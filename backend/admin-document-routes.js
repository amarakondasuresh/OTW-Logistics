// HTTP routes for Admin Portal > Documents (service rules: admin-documents.js). Admin sign-in is required for every route.
//   GET    /api/admin/rider-documents              list (every admin sees the same list)
//   POST   /api/admin/rider-documents              upload: fields riderId, riderName, type, submissionId; files file, selfie
//   PUT    /api/admin/rider-documents/:id          replace the file, the selfie or the type (files and fields optional)
//   GET    /api/admin/rider-documents/:id/file     view or download (?kind=selfie for the selfie)
//   DELETE /api/admin/rider-documents/:id          delete the record and its files
import fs from "node:fs";
import multer from "multer";
import { AdminDocumentError, DOC_MAX_BYTES, DOC_TYPES } from "./admin-documents.js";

export function registerAdminDocumentRoutes(app, { guard, service }) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: DOC_MAX_BYTES, files: 2, fields: 8, fieldSize: 300 },
  }).fields([
    { name: "file", maxCount: 1 },
    { name: "selfie", maxCount: 1 },
  ]);
  const fail = (res, err) => {
    if (err instanceof AdminDocumentError) return res.status(err.status).json({ error: err.message });
    console.error("Rider document request failed:", err && err.message);
    return res.status(500).json({ error: "Something went wrong on the server. Please try again." });
  };
  const readUpload = (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? "A file is too large. Please upload files under 5 MB."
          : err.code === "LIMIT_UNEXPECTED_FILE"
            ? "Unexpected file field. Upload the document and the selfie separately."
            : "Could not read the file. Please try another one.";
      return res.status(400).json({ error: msg });
    });
  const filesOf = (req) => ({ document: req.files?.file?.[0], selfie: req.files?.selfie?.[0] });

  app.get("/api/admin/rider-documents", guard, (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, items: service.list(), types: DOC_TYPES });
    } catch (err) {
      fail(res, err);
    }
  });
  app.post("/api/admin/rider-documents", guard, readUpload, (req, res) => {
    try {
      const out = service.add(req.adminEmail || "", req.body || {}, filesOf(req));
      res.status(out.duplicate ? 200 : 201).json({ ok: true, duplicate: out.duplicate, item: out.item });
    } catch (err) {
      fail(res, err);
    }
  });
  app.put("/api/admin/rider-documents/:id", guard, readUpload, (req, res) => {
    try {
      const item = service.replace(req.adminEmail || "", req.params.id, req.body || {}, filesOf(req));
      res.json({ ok: true, item });
    } catch (err) {
      fail(res, err);
    }
  });
  app.get("/api/admin/rider-documents/:id/file", guard, (req, res) => {
    try {
      const kind = req.query.kind === "selfie" ? "selfie" : "document";
      const f = service.fileOf(req.adminEmail || "", req.params.id, kind);
      res.set({
        "Content-Type": f.mime,
        "Content-Disposition": `inline; filename="${f.name.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      fs.createReadStream(f.path).pipe(res);
    } catch (err) {
      fail(res, err);
    }
  });
  app.delete("/api/admin/rider-documents/:id", guard, (req, res) => {
    try {
      res.json(service.remove(req.adminEmail || "", req.params.id));
    } catch (err) {
      fail(res, err);
    }
  });
}
