// Rider member registrations.
//
// A rider is registered once (Rider ID, name, mobile number, hub pincode, hub location, a selfie / screenshot
// and an Aadhaar card) by the Admin, a Vendor or a Franchise. Every registration starts as PENDING.
// Decisions (APPROVED / REJECTED, with remarks):
//   - an admin can decide on any registration;
//   - a vendor can decide only on the riders it registered;
//   - a franchise cannot decide on anything (it sees the status and the admin's remarks only).
//
// This file has no web-framework dependency, so its rules can be tested directly against SQLite.
// rider-registration-routes.js exposes it over HTTP.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REG_STATUSES = ["PENDING", "APPROVED", "REJECTED"];
export const REG_MAX_FILE_BYTES = 5 * 1024 * 1024;
// Rider Applications belong to the Admin Portal (full management), the Vendor Portal (own riders, can decide
// on them) and the Franchise Portal (own riders, read-only status). Each partner sees only its own registrations.
export const REG_PORTALS = ["admin", "vendor", "franchise"];
// Only these roles may approve or reject (a franchise may submit and watch, but never decide).
export const REG_DECIDER_ROLES = ["admin", "vendor"];
const SOURCE_BY_ROLE = {
  admin: "Admin",
  vendor: "Vendor",
  franchise: "Franchise",
};
const ADMIN_LABEL = "On The Way Logistics"; // what a franchise sees instead of an admin's login / email
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const DOCUMENTS = {
  selfie: { label: "rider selfie / screenshot", types: IMAGE_TYPES },
  aadhaar: {
    label: "Aadhaar card",
    types: [...IMAGE_TYPES, "application/pdf"],
  },
};
const EXTENSION = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

export class RegistrationError extends Error {
  constructor(status, message, field = "") {
    super(message);
    this.status = status;
    this.field = field;
  }
}

// Decide a file's real type from its first bytes, never from its name or the type the browser reports.
export function sniffType(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (
    b.length > 8 &&
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    b.length > 12 &&
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-")
    return "application/pdf";
  return "";
}

// Rider IDs are compared ignoring case and spaces, so "wl 001" and "WL001" are the same rider.
export function normalizeRiderKey(riderId) {
  return String(riderId ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

// Mobile numbers are stored as 10 digits. "+91 98765 43210" and "098765 43210" are accepted.
export function cleanMobile(value) {
  let d = String(value ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

function safeFileName(original, fallback) {
  const base = path
    .basename(String(original ?? ""))
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 100);
  return base || fallback;
}

// Checks the typed fields and returns them in stored form. Throws RegistrationError with the field name.
export function validateRegistrationFields(raw = {}) {
  const riderId = String(raw.riderId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_\/]{1,39}$/.test(riderId)) {
    throw new RegistrationError(
      400,
      "Rider ID must be 2 to 40 letters, numbers, dashes or slashes, with no spaces.",
      "riderId",
    );
  }
  const riderName = String(raw.riderName ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!riderName)
    throw new RegistrationError(400, "Enter the rider name.", "riderName");
  if (riderName.length > 100)
    throw new RegistrationError(
      400,
      "The rider name is too long (100 characters at most).",
      "riderName",
    );
  if (/\d/.test(riderName))
    throw new RegistrationError(
      400,
      "The rider name cannot contain numbers.",
      "riderName",
    );
  if (
    !/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(riderName) ||
    (riderName.match(/\p{L}/gu) || []).length < 2
  ) {
    throw new RegistrationError(
      400,
      "The rider name can only contain letters, spaces and . ' -",
      "riderName",
    );
  }
  const mobileNumber = cleanMobile(raw.mobile);
  if (!mobileNumber)
    throw new RegistrationError(
      400,
      "Enter a 10-digit mobile number starting with 6, 7, 8 or 9.",
      "mobile",
    );
  const hubPincode = String(raw.hubPincode ?? "").trim();
  if (!/^[1-9]\d{5}$/.test(hubPincode))
    throw new RegistrationError(
      400,
      "Enter the 6-digit hub pincode.",
      "hubPincode",
    );
  const hubLocation = String(raw.hubLocation ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (hubLocation.length < 2)
    throw new RegistrationError(400, "Enter the hub location.", "hubLocation");
  if (hubLocation.length > 120)
    throw new RegistrationError(
      400,
      "The hub location is too long (120 characters at most).",
      "hubLocation",
    );
  return {
    riderId,
    riderKey: normalizeRiderKey(riderId),
    riderName,
    mobileNumber,
    hubPincode,
    hubLocation,
  };
}

// Both documents are mandatory. Each must really be the type it claims to be and be 5 MB or smaller.
export function checkDocuments(files = {}) {
  const out = {};
  for (const [kind, spec] of Object.entries(DOCUMENTS)) {
    const f = files[kind];
    const requirement =
      kind === "selfie"
        ? "Upload the rider selfie or screenshot (JPG, PNG or WEBP image)."
        : "Upload the Aadhaar card (JPG, PNG, WEBP image or PDF).";
    if (!f || !f.buffer || !f.buffer.length)
      throw new RegistrationError(400, requirement, kind);
    if (f.buffer.length > REG_MAX_FILE_BYTES)
      throw new RegistrationError(
        400,
        `The ${spec.label} file is larger than 5 MB.`,
        kind,
      );
    const type = sniffType(f.buffer);
    if (!spec.types.includes(type)) {
      throw new RegistrationError(
        400,
        kind === "selfie"
          ? "The selfie must be a real JPG, PNG or WEBP image."
          : "The Aadhaar card must be a real JPG, PNG, WEBP image or PDF file.",
        kind,
      );
    }
    out[kind] = {
      buffer: f.buffer,
      type,
      name: safeFileName(f.originalname, kind + EXTENSION[type]),
      size: f.buffer.length,
    };
  }
  return out;
}

const isUniqueViolation = (err) =>
  /UNIQUE constraint failed/.test(String(err?.message || ""));

export function createRiderRegistrationService({
  db,
  uploadDir,
  audit = () => {},
  now = () => new Date().toISOString(),
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rider_registrations(
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL UNIQUE,
      rider_id TEXT NOT NULL,
      rider_key TEXT NOT NULL,
      rider_name TEXT NOT NULL,
      mobile_number TEXT NOT NULL,
      hub_pincode TEXT NOT NULL,
      hub_location TEXT NOT NULL,
      selfie_path TEXT NOT NULL,
      selfie_name TEXT NOT NULL,
      selfie_type TEXT NOT NULL,
      selfie_size INTEGER NOT NULL,
      aadhaar_path TEXT NOT NULL,
      aadhaar_name TEXT NOT NULL,
      aadhaar_type TEXT NOT NULL,
      aadhaar_size INTEGER NOT NULL,
      registration_source TEXT NOT NULL,
      owner_account_id TEXT,
      owner_login_id TEXT,
      owner_name TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      application_status TEXT NOT NULL DEFAULT 'PENDING',
      rejection_remarks TEXT,
      decision_remarks TEXT,
      approved_by TEXT,
      approval_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- A rider ID can have only one live application (PENDING or APPROVED). A REJECTED application does not block
    -- a new one, so a rejected rider can be registered again.
    CREATE UNIQUE INDEX IF NOT EXISTS rider_registrations_live_rider
      ON rider_registrations(rider_key) WHERE application_status <> 'REJECTED';
    CREATE INDEX IF NOT EXISTS rider_registrations_owner ON rider_registrations(owner_account_id, registration_source);
    CREATE TABLE IF NOT EXISTS rider_registration_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      remarks TEXT,
      actor TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rider_registration_history_reg ON rider_registration_history(registration_id, id);
    CREATE TABLE IF NOT EXISTS rider_registration_counter(id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
    INSERT INTO rider_registration_counter(id, last) VALUES(1, 0) ON CONFLICT(id) DO NOTHING;
  `);
  // Databases created before these columns existed get them added (existing records keep their values).
  const existingColumns = new Set(
    db
      .prepare("PRAGMA table_info(rider_registrations)")
      .all()
      .map((c) => c.name),
  );
  if (!existingColumns.has("owner_name"))
    db.exec(
      "ALTER TABLE rider_registrations ADD COLUMN owner_name TEXT NOT NULL DEFAULT ''",
    );
  if (!existingColumns.has("decision_remarks"))
    db.exec("ALTER TABLE rider_registrations ADD COLUMN decision_remarks TEXT");

  const statements = {
    byId: db.prepare("SELECT * FROM rider_registrations WHERE id = ?"),
    liveByRider: db.prepare(
      "SELECT id, application_id FROM rider_registrations WHERE rider_key = ? AND application_status <> 'REJECTED' AND id <> ?",
    ),
    insert:
      db.prepare(`INSERT INTO rider_registrations(id, application_id, rider_id, rider_key, rider_name, mobile_number, hub_pincode, hub_location,
        selfie_path, selfie_name, selfie_type, selfie_size, aadhaar_path, aadhaar_name, aadhaar_type, aadhaar_size,
        registration_source, owner_account_id, owner_login_id, owner_name, created_by, application_status, rejection_remarks,
        decision_remarks, approved_by, approval_date, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    updateStatus:
      db.prepare(`UPDATE rider_registrations SET application_status = ?, rejection_remarks = ?, decision_remarks = ?,
        approved_by = ?, approval_date = ?, updated_at = ? WHERE id = ?`),
    updateDetails:
      db.prepare(`UPDATE rider_registrations SET rider_id = ?, rider_key = ?, rider_name = ?, mobile_number = ?,
        hub_pincode = ?, hub_location = ?, selfie_path = ?, selfie_name = ?, selfie_type = ?, selfie_size = ?,
        aadhaar_path = ?, aadhaar_name = ?, aadhaar_type = ?, aadhaar_size = ?, updated_at = ? WHERE id = ?`),
    insertHistory:
      db.prepare(`INSERT INTO rider_registration_history(registration_id, from_status, to_status, remarks, actor, actor_role, created_at)
        VALUES(?,?,?,?,?,?,?)`),
    historyFor: db.prepare(
      "SELECT * FROM rider_registration_history WHERE registration_id = ? ORDER BY id ASC",
    ),
    bumpCounter: db.prepare(
      "UPDATE rider_registration_counter SET last = last + 1 WHERE id = 1",
    ),
    readCounter: db.prepare(
      "SELECT last FROM rider_registration_counter WHERE id = 1",
    ),
  };

  // Runs fn inside one database transaction (manual BEGIN so it works the same on every SQLite driver).
  function inTransaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      throw err;
    }
  }

  function nextApplicationId() {
    statements.bumpCounter.run();
    return "RM-" + String(statements.readCounter.get().last).padStart(6, "0");
  }

  function assertActor(actor) {
    if (!SOURCE_BY_ROLE[actor?.role])
      throw new RegistrationError(
        403,
        "This account cannot use rider applications.",
      );
  }

  // Admins see every registration. Vendors see only the riders they registered themselves.
  function scopeFor(actor) {
    if (actor.role === "admin") return { sql: "1 = 1", params: [] };
    return {
      sql: "owner_account_id = ? AND registration_source = ?",
      params: [actor.accountId, SOURCE_BY_ROLE[actor.role]],
    };
  }

  function visibleRow(actor, id) {
    const scope = scopeFor(actor);
    return db
      .prepare(
        `SELECT * FROM rider_registrations WHERE id = ? AND ${scope.sql}`,
      )
      .get(String(id), ...scope.params);
  }

  function toPublic(row, history = null) {
    const out = {
      id: row.id,
      applicationId: row.application_id,
      riderId: row.rider_id,
      riderName: row.rider_name,
      mobileNumber: row.mobile_number,
      hubPincode: row.hub_pincode,
      hubLocation: row.hub_location,
      selfie: {
        name: row.selfie_name,
        type: row.selfie_type,
        size: row.selfie_size,
      },
      aadhaar: {
        name: row.aadhaar_name,
        type: row.aadhaar_type,
        size: row.aadhaar_size,
      },
      registrationSource: row.registration_source,
      appliedBy: row.registration_source,
      ownerLoginId: row.owner_login_id || "",
      ownerName: row.owner_name || "",
      createdBy: row.created_by,
      status: row.application_status,
      rejectionRemarks: row.rejection_remarks || "",
      decisionRemarks: row.decision_remarks || "",
      approvedBy: row.approved_by || "",
      approvalDate: row.approval_date || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (history) {
      out.history = history.map((h) => ({
        fromStatus: h.from_status || "",
        toStatus: h.to_status,
        remarks: h.remarks || "",
        actor: h.actor,
        actorRole: h.actor_role,
        at: h.created_at,
      }));
    }
    return out;
  }

  // A franchise sees who decided as "On The Way Logistics" rather than an admin's login e-mail.
  function forViewer(actor, item) {
    if (actor.role !== "franchise") return item;
    const out = { ...item, approvedBy: item.approvedBy ? ADMIN_LABEL : "" };
    if (item.history)
      out.history = item.history.map((h) => ({
        ...h,
        actor: h.actorRole === "admin" ? ADMIN_LABEL : h.actor,
      }));
    return out;
  }

  function list(actor) {
    assertActor(actor);
    const scope = scopeFor(actor);
    return db
      .prepare(
        `SELECT * FROM rider_registrations WHERE ${scope.sql} ORDER BY created_at DESC, application_id DESC`,
      )
      .all(...scope.params)
      .map((row) => forViewer(actor, toPublic(row)));
  }

  function get(actor, id) {
    assertActor(actor);
    const row = visibleRow(actor, id);
    if (!row) throw new RegistrationError(404, "Rider application not found.");
    return forViewer(actor, toPublic(row, statements.historyFor.all(row.id)));
  }

  // files: {selfie: {buffer, originalname}, aadhaar: {buffer, originalname}} as read by multer.
  function create(actor, rawFields, files) {
    assertActor(actor);
    const fields = validateRegistrationFields(rawFields);
    const docs = checkDocuments(files);
    const identity = String(actor.identity || actor.role);
    const liveNow = statements.liveByRider.get(fields.riderKey, "");
    if (liveNow) throw duplicateError(fields, liveNow);

    const id = crypto.randomUUID();
    const dir = path.join(uploadDir, "registrations", id);
    try {
      // Files are written before the record so the record never points at a missing file.
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stored = {};
      for (const kind of Object.keys(docs)) {
        const rel = path.posix.join(
          "registrations",
          id,
          kind + EXTENSION[docs[kind].type],
        );
        fs.writeFileSync(path.join(uploadDir, rel), docs[kind].buffer, {
          mode: 0o600,
        });
        stored[kind] = rel;
      }
      const stamp = now();
      const owner = actor.role === "admin" ? null : actor;
      const ownerName = owner
        ? String(actor.ownerName || actor.identity || "").slice(0, 100)
        : "";
      inTransaction(() => {
        const clash = statements.liveByRider.get(fields.riderKey, "");
        if (clash) throw duplicateError(fields, clash);
        const applicationId = nextApplicationId();
        statements.insert.run(
          id,
          applicationId,
          fields.riderId,
          fields.riderKey,
          fields.riderName,
          fields.mobileNumber,
          fields.hubPincode,
          fields.hubLocation,
          stored.selfie,
          docs.selfie.name,
          docs.selfie.type,
          docs.selfie.size,
          stored.aadhaar,
          docs.aadhaar.name,
          docs.aadhaar.type,
          docs.aadhaar.size,
          SOURCE_BY_ROLE[actor.role],
          owner?.accountId || null,
          owner ? identity : null,
          ownerName,
          identity,
          "PENDING",
          null,
          null,
          null,
          null,
          stamp,
          stamp,
        );
        statements.insertHistory.run(
          id,
          null,
          "PENDING",
          "Registration submitted",
          identity,
          actor.role,
          stamp,
        );
      });
      const row = statements.byId.get(id);
      audit(identity, "rider_registration_created", {
        applicationId: row.application_id,
        riderId: row.rider_id,
        source: row.registration_source,
      });
      return toPublic(row, statements.historyFor.all(id));
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true }); // nothing was saved, so remove the files of this attempt
      if (err instanceof RegistrationError) throw err;
      if (isUniqueViolation(err) && String(err.message).includes("rider_key")) {
        throw new RegistrationError(
          409,
          `Rider ID ${fields.riderId} is already registered. Each rider can only be registered once.`,
          "riderId",
        );
      }
      throw err;
    }
  }

  function duplicateError(fields, existing) {
    return new RegistrationError(
      409,
      `Rider ID ${fields.riderId} is already registered (application ${existing.application_id}). Each rider can only be registered once.`,
      "riderId",
    );
  }

  // Approve or reject. Any change of status is kept in the history with who made it, when and the remarks.
  // Admin-only edits. Omitted document uploads keep the existing private files.
  function update(actor, id, rawFields = {}, files = {}) {
    assertActor(actor);
    if (actor.role !== "admin")
      throw new RegistrationError(
        403,
        "Only the admin can edit an active rider profile.",
      );
    const row = visibleRow(actor, id);
    if (!row) throw new RegistrationError(404, "Rider application not found.");
    const fields = validateRegistrationFields(rawFields);
    const clash = statements.liveByRider.get(fields.riderKey, row.id);
    if (clash)
      throw new RegistrationError(
        409,
        `Rider ID ${fields.riderId} is already assigned to another live rider.`,
        "riderId",
      );

    const replacements = {};
    for (const kind of Object.keys(DOCUMENTS)) {
      const file = files[kind];
      if (!file || !file.buffer || !file.buffer.length) continue;
      if (file.buffer.length > REG_MAX_FILE_BYTES)
        throw new RegistrationError(
          400,
          `The ${DOCUMENTS[kind].label} file is larger than 5 MB.`,
          kind,
        );
      const type = sniffType(file.buffer);
      if (!DOCUMENTS[kind].types.includes(type))
        throw new RegistrationError(
          400,
          kind === "selfie"
            ? "The selfie must be a real JPG, PNG or WEBP image."
            : "The Aadhaar card must be a real JPG, PNG, WEBP image or PDF file.",
          kind,
        );
      replacements[kind] = {
        buffer: file.buffer,
        type,
        name: safeFileName(file.originalname, kind + EXTENSION[type]),
        size: file.buffer.length,
      };
    }

    const root = path.resolve(uploadDir),
      dir = path.join(root, "registrations", row.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const next = {
      selfie_path: row.selfie_path,
      selfie_name: row.selfie_name,
      selfie_type: row.selfie_type,
      selfie_size: row.selfie_size,
      aadhaar_path: row.aadhaar_path,
      aadhaar_name: row.aadhaar_name,
      aadhaar_type: row.aadhaar_type,
      aadhaar_size: row.aadhaar_size,
    };
    const written = [];
    for (const [kind, doc] of Object.entries(replacements)) {
      const rel = path.posix.join(
        "registrations",
        row.id,
        kind + "-" + crypto.randomUUID() + EXTENSION[doc.type],
      );
      fs.writeFileSync(path.join(root, rel), doc.buffer, { mode: 0o600 });
      written.push(path.join(root, rel));
      next[kind + "_path"] = rel;
      next[kind + "_name"] = doc.name;
      next[kind + "_type"] = doc.type;
      next[kind + "_size"] = doc.size;
    }
    const stamp = now(),
      identity = String(actor.identity || actor.role);
    try {
      inTransaction(() => {
        const latestClash = statements.liveByRider.get(fields.riderKey, row.id);
        if (latestClash)
          throw new RegistrationError(
            409,
            `Rider ID ${fields.riderId} is already assigned to another live rider.`,
            "riderId",
          );
        statements.updateDetails.run(
          fields.riderId,
          fields.riderKey,
          fields.riderName,
          fields.mobileNumber,
          fields.hubPincode,
          fields.hubLocation,
          next.selfie_path,
          next.selfie_name,
          next.selfie_type,
          next.selfie_size,
          next.aadhaar_path,
          next.aadhaar_name,
          next.aadhaar_type,
          next.aadhaar_size,
          stamp,
          row.id,
        );
      });
    } catch (err) {
      for (const f of written)
        try {
          fs.rmSync(f, { force: true });
        } catch {}
      if (isUniqueViolation(err))
        throw new RegistrationError(
          409,
          `Rider ID ${fields.riderId} is already assigned to another live rider.`,
          "riderId",
        );
      throw err;
    }
    audit(identity, "rider_registration_updated", {
      riderId: fields.riderId,
      previousRiderId: row.rider_id,
      status: row.application_status,
    });
    return get(actor, row.id);
  }

  function setStatus(actor, id, input = {}) {
    assertActor(actor);
    if (!REG_DECIDER_ROLES.includes(actor.role)) {
      throw new RegistrationError(
        403,
        "Only the On The Way Logistics admin can approve or reject rider applications.",
      );
    }
    const target = String(input.status ?? "")
      .trim()
      .toUpperCase();
    if (!REG_STATUSES.includes(target))
      throw new RegistrationError(
        400,
        "Status must be PENDING, APPROVED or REJECTED.",
        "status",
      );
    const remarks = String(input.remarks ?? "")
      .trim()
      .slice(0, 500);
    if (target === "REJECTED" && !remarks)
      throw new RegistrationError(
        400,
        "Enter the reason for rejecting this application.",
        "remarks",
      );
    const row = visibleRow(actor, id);
    if (!row) throw new RegistrationError(404, "Rider application not found.");
    if (row.application_status === target)
      throw new RegistrationError(
        400,
        `This application is already ${target}.`,
      );
    const identity = String(actor.identity || actor.role);
    const stamp = now();
    inTransaction(() => {
      if (target !== "REJECTED") {
        const clash = statements.liveByRider.get(row.rider_key, row.id);
        if (clash) {
          throw new RegistrationError(
            409,
            `Rider ID ${row.rider_id} already has a live application (${clash.application_id}). Reject that one first.`,
            "status",
          );
        }
      }
      statements.updateStatus.run(
        target,
        target === "REJECTED" ? remarks : null,
        target === "PENDING" ? null : remarks || null,
        target === "APPROVED" ? identity : null,
        target === "APPROVED" ? stamp : null,
        stamp,
        row.id,
      );
      statements.insertHistory.run(
        row.id,
        row.application_status,
        target,
        remarks || null,
        identity,
        actor.role,
        stamp,
      );
    });
    audit(identity, "rider_registration_" + target.toLowerCase(), {
      applicationId: row.application_id,
      riderId: row.rider_id,
      from: row.application_status,
      remarks: remarks || "",
    });
    return get(actor, row.id);
  }

  // Path of a stored document, if this account may see that registration. Aadhaar views are audited.
  function fileFor(actor, id, kind) {
    assertActor(actor);
    if (!DOCUMENTS[kind]) throw new RegistrationError(404, "File not found.");
    const row = visibleRow(actor, id);
    if (!row) throw new RegistrationError(404, "File not found.");
    const rel = kind === "selfie" ? row.selfie_path : row.aadhaar_path;
    const root = path.resolve(uploadDir);
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) {
      throw new RegistrationError(
        404,
        "The file is missing on the server. Ask the administrator to check the uploads folder.",
      );
    }
    if (kind === "aadhaar") {
      audit(String(actor.identity || actor.role), "rider_aadhaar_viewed", {
        applicationId: row.application_id,
        riderId: row.rider_id,
      });
    }
    return {
      path: abs,
      type: kind === "selfie" ? row.selfie_type : row.aadhaar_type,
      name: kind === "selfie" ? row.selfie_name : row.aadhaar_name,
    };
  }

  return { list, get, create, update, setStatus, fileFor };
}
