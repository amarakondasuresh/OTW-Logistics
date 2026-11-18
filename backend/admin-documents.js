// Admin Portal > Documents: rider documents uploaded by an admin. Each record is one document file (Aadhaar / ID
// proof, PAN card, driving licence, bank passbook, RC book, insurance, other) and an optional Rider Selfie / Screenshot,
// both linked to one Rider ID. Files are stored privately in backend/uploads/admin-documents/ (never in a public
// folder) and are opened only through an admin session. Every admin sees the same list. Uploads, replacements, views
// and deletions are audited.
//
// Files are checked by their content (not by the browser's claim or the file name). The same document cannot be
// uploaded twice for one rider, and a repeated submission with the same submissionId returns the first record.
//
// createAdminDocumentService has no web-framework dependency, so its rules can be tested directly against SQLite.
// The HTTP routes are in admin-document-routes.js.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DOC_TYPES = Object.freeze([
  "Aadhaar / ID Proof",
  "PAN Card",
  "Driving Licence",
  "Bank Passbook",
  "RC Book",
  "Insurance Document",
  "Other Documents",
]);
// Types saved by the earlier version of this page. Those records stay as they are and are still listed; new
// uploads and replacements must use DOC_TYPES.
export const LEGACY_DOC_TYPES = Object.freeze(["PAN", "RC", "Address Proof", "Other"]);
export const DOC_MAX_BYTES = 5 * 1024 * 1024;
const DOC_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};
const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"];
const DOC_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];
const SELFIE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const SUBMISSION_ID = /^[A-Za-z0-9-]{8,64}$/;

export class AdminDocumentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The real file type from its first bytes (the browser's claim is not trusted).
export function sniffDocumentType(b) {
  if (!b || !b.length) return "";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  if (b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return "";
}

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
// Rider IDs are compared without spaces or capitals, so "wl 001" and "WL001" are the same rider.
export const normalizeRiderId = (v) => String(v ?? "").replace(/\s+/g, "").toUpperCase();
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const randomTag = () => crypto.randomBytes(4).toString("hex");

// A safe display name: the last part of the name only, no folders, no odd characters.
function safeName(original, fallback) {
  const base = path.basename(String(original || "")).replace(/[^\w.\- ()]/g, "_").slice(0, 120);
  return base || fallback;
}

// Checks one uploaded file. Returns null when no file was sent.
function checkFile(file, { label, pdfAllowed, extensions }) {
  if (!file || !file.buffer || !file.buffer.length) return null;
  if (file.buffer.length > DOC_MAX_BYTES)
    throw new AdminDocumentError(400, `The ${label} is too large. Please upload a file under 5 MB.`);
  const ext = path.extname(String(file.originalname || "")).toLowerCase();
  const allowedText = pdfAllowed ? "JPG, JPEG, PNG, WEBP or PDF" : "JPG, JPEG, PNG or WEBP";
  if (!extensions.includes(ext)) throw new AdminDocumentError(400, `The ${label} must be a ${allowedText} file.`);
  const mime = sniffDocumentType(file.buffer);
  const ok = pdfAllowed ? !!mime : IMAGE_MIME.includes(mime);
  if (!ok) throw new AdminDocumentError(400, `The ${label} must be a ${allowedText} file.`);
  return { buffer: file.buffer, mime, name: safeName(file.originalname, "file" + DOC_EXT[mime]) };
}
const checkDocument = (file) => checkFile(file, { label: "document", pdfAllowed: true, extensions: DOC_EXTENSIONS });
const checkSelfie = (file) =>
  checkFile(file, { label: "Rider Selfie / Screenshot", pdfAllowed: false, extensions: SELFIE_EXTENSIONS });

export function createAdminDocumentService({ db, uploadDir, audit = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_rider_documents(
    id TEXT PRIMARY KEY,
    rider_id TEXT NOT NULL,
    rider_name TEXT NOT NULL DEFAULT '',
    doc_type TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    uploaded_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS admin_rider_documents_rider ON admin_rider_documents(rider_id);`);
  // Columns added by this version. Existing records get NULL here and keep working unchanged.
  const have = new Set(db.prepare("PRAGMA table_info(admin_rider_documents)").all().map((c) => c.name));
  const added = {
    selfie_stored: "TEXT",
    selfie_name: "TEXT",
    selfie_mime: "TEXT",
    selfie_size: "INTEGER",
    file_sha256: "TEXT",
    client_key: "TEXT",
    updated_at: "TEXT",
  };
  for (const [col, type] of Object.entries(added))
    if (!have.has(col)) db.exec(`ALTER TABLE admin_rider_documents ADD COLUMN ${col} ${type}`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS admin_rider_documents_client_key ON admin_rider_documents(client_key)");
  db.exec("CREATE INDEX IF NOT EXISTS admin_rider_documents_hash ON admin_rider_documents(rider_id, doc_type, file_sha256)");

  const dir = path.join(uploadDir, "admin-documents");
  const fullPath = (stored) => path.join(dir, stored);

  const toPublic = (r) => ({
    id: r.id,
    riderId: r.rider_id,
    riderName: r.rider_name,
    type: r.doc_type,
    name: r.original_name,
    mime: r.mime,
    size: r.size,
    selfie: r.selfie_stored ? { name: r.selfie_name || "selfie", mime: r.selfie_mime, size: r.selfie_size || 0 } : null,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at,
  });
  const rowOf = (id) => db.prepare("SELECT * FROM admin_rider_documents WHERE id=?").get(String(id));

  function list() {
    return db.prepare("SELECT * FROM admin_rider_documents ORDER BY created_at DESC LIMIT 20000").all().map(toPublic);
  }

  function writeFile(stored, buffer) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(fullPath(stored), buffer, { mode: 0o600 });
    return stored;
  }
  const unlinkQuietly = (stored) => {
    if (!stored) return;
    try {
      fs.unlinkSync(fullPath(stored));
    } catch {}
  };

  function add(actor, { riderId, riderName, type, submissionId }, files = {}) {
    const rid = normalizeRiderId(riderId);
    if (!rid) throw new AdminDocumentError(400, "Choose the rider first.");
    const docType = DOC_TYPES.includes(String(type)) ? String(type) : "";
    if (!docType) throw new AdminDocumentError(400, "Choose a document type.");
    const key = SUBMISSION_ID.test(String(submissionId || "")) ? String(submissionId) : null;
    if (key) {
      const again = db.prepare("SELECT * FROM admin_rider_documents WHERE client_key=?").get(key);
      if (again) return { item: toPublic(again), duplicate: true };
    }
    const doc = checkDocument(files.document);
    if (!doc) throw new AdminDocumentError(400, "Choose a document file to upload.");
    const selfie = checkSelfie(files.selfie);
    const hash = sha256(doc.buffer);
    const same = db
      .prepare("SELECT id FROM admin_rider_documents WHERE rider_id=? AND doc_type=? AND file_sha256=?")
      .get(rid, docType, hash);
    if (same) throw new AdminDocumentError(409, "This document is already uploaded for this rider.");

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const stored = writeFile(id + DOC_EXT[doc.mime], doc.buffer);
    const selfieStored = selfie ? writeFile(`${id}-selfie-${randomTag()}${DOC_EXT[selfie.mime]}`, selfie.buffer) : null;
    try {
      db.prepare(
        `INSERT INTO admin_rider_documents(id,rider_id,rider_name,doc_type,original_name,mime,size,stored_name,uploaded_by,created_at,
           selfie_stored,selfie_name,selfie_mime,selfie_size,file_sha256,client_key,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        rid,
        clean(riderName, 120),
        docType,
        doc.name,
        doc.mime,
        doc.buffer.length,
        stored,
        clean(actor, 254),
        now,
        selfieStored,
        selfie ? selfie.name : null,
        selfie ? selfie.mime : null,
        selfie ? selfie.buffer.length : null,
        hash,
        key,
        now,
      );
    } catch (err) {
      unlinkQuietly(stored);
      unlinkQuietly(selfieStored);
      // A double submit that raced past the check above still gets the record that was saved first.
      if (key && /UNIQUE/i.test(String(err.message))) {
        const again = db.prepare("SELECT * FROM admin_rider_documents WHERE client_key=?").get(key);
        if (again) return { item: toPublic(again), duplicate: true };
      }
      throw err;
    }
    audit(actor, "rider_document_uploaded", { id, riderId: rid, type: docType, selfie: !!selfie });
    return { item: toPublic(rowOf(id)), duplicate: false };
  }

  // Replaces the document file, the selfie, or the document type of an existing record. Anything not sent is kept.
  function replace(actor, id, { type }, files = {}) {
    const row = rowOf(id);
    if (!row) throw new AdminDocumentError(404, "Document not found.");
    let docType = row.doc_type;
    if (type !== undefined && type !== null && String(type) !== "") {
      if (!DOC_TYPES.includes(String(type))) throw new AdminDocumentError(400, "Choose a document type.");
      docType = String(type);
    }
    const doc = checkDocument(files.document);
    const selfie = checkSelfie(files.selfie);
    if (!doc && !selfie && docType === row.doc_type)
      throw new AdminDocumentError(400, "Choose a new file, a new selfie or a new document type to save.");
    const hash = doc ? sha256(doc.buffer) : row.file_sha256;
    if (doc || docType !== row.doc_type) {
      const same = db
        .prepare("SELECT id FROM admin_rider_documents WHERE rider_id=? AND doc_type=? AND file_sha256=? AND id<>?")
        .get(row.rider_id, docType, hash, row.id);
      if (same) throw new AdminDocumentError(409, "This document is already uploaded for this rider.");
    }
    const now = new Date().toISOString();
    const newDoc = doc ? writeFile(`${row.id}-${randomTag()}${DOC_EXT[doc.mime]}`, doc.buffer) : null;
    const newSelfie = selfie ? writeFile(`${row.id}-selfie-${randomTag()}${DOC_EXT[selfie.mime]}`, selfie.buffer) : null;
    try {
      db.prepare(
        `UPDATE admin_rider_documents SET doc_type=?,
           original_name=?, mime=?, size=?, stored_name=?, file_sha256=?,
           selfie_stored=?, selfie_name=?, selfie_mime=?, selfie_size=?, updated_at=?
         WHERE id=?`,
      ).run(
        docType,
        doc ? doc.name : row.original_name,
        doc ? doc.mime : row.mime,
        doc ? doc.buffer.length : row.size,
        newDoc || row.stored_name,
        hash,
        newSelfie || row.selfie_stored,
        selfie ? selfie.name : row.selfie_name,
        selfie ? selfie.mime : row.selfie_mime,
        selfie ? selfie.buffer.length : row.selfie_size,
        now,
        row.id,
      );
    } catch (err) {
      unlinkQuietly(newDoc);
      unlinkQuietly(newSelfie);
      throw err;
    }
    // The old files are removed only after the new record is saved.
    if (newDoc) unlinkQuietly(row.stored_name);
    if (newSelfie) unlinkQuietly(row.selfie_stored);
    audit(actor, "rider_document_replaced", {
      id: row.id,
      riderId: row.rider_id,
      type: docType,
      file: !!newDoc,
      selfie: !!newSelfie,
    });
    return toPublic(rowOf(row.id));
  }

  // kind: "document" (default) or "selfie".
  function fileOf(actor, id, kind = "document") {
    const row = rowOf(id);
    if (!row) throw new AdminDocumentError(404, "Document not found.");
    const selfie = kind === "selfie";
    const stored = selfie ? row.selfie_stored : row.stored_name;
    if (!stored) throw new AdminDocumentError(404, selfie ? "This record has no selfie or screenshot." : "Document not found.");
    const full = fullPath(stored);
    if (!fs.existsSync(full))
      throw new AdminDocumentError(404, "The file of this document is missing on the server.");
    audit(actor, selfie ? "rider_selfie_viewed" : "rider_document_viewed", {
      id: row.id,
      riderId: row.rider_id,
      type: row.doc_type,
    });
    return selfie
      ? { path: full, mime: row.selfie_mime || "image/jpeg", name: row.selfie_name || "selfie" }
      : { path: full, mime: row.mime, name: row.original_name };
  }

  function remove(actor, id) {
    const row = rowOf(id);
    if (!row) throw new AdminDocumentError(404, "Document not found.");
    db.prepare("DELETE FROM admin_rider_documents WHERE id=?").run(row.id);
    unlinkQuietly(row.stored_name);
    unlinkQuietly(row.selfie_stored);
    audit(actor, "rider_document_deleted", { id: row.id, riderId: row.rider_id, type: row.doc_type });
    return { ok: true };
  }

  return { list, add, replace, fileOf, remove };
}
