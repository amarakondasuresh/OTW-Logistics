// HTTP routes for rider applications (see rider-registrations.js for the rules).
// Every request names the portal it comes from with ?portal=admin|vendor|franchise and must be signed in to it.
// Admins see everything; vendors and franchises see only the riders they registered themselves.
// Only admins and vendors can approve or reject (a franchise submits and watches the status).
import multer from "multer";
import fs from "node:fs";
import {
  REG_MAX_FILE_BYTES,
  REG_PORTALS,
  RegistrationError,
} from "./rider-registrations.js";

const KNOWN_PORTALS = ["admin", "vendor", "franchise"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: REG_MAX_FILE_BYTES,
    files: 2,
    fields: 10,
    fieldSize: 500,
  },
});

export function registerRiderRegistrationRoutes(
  app,
  { auth, service, onApproved },
) {
  // Checks the portal sign-in and sets req.actor = {role, accountId, identity}.
  const guard = (req, res, next) => {
    const portal = String(req.query.portal || "");
    if (!REG_PORTALS.includes(portal)) {
      return res
        .status(KNOWN_PORTALS.includes(portal) ? 403 : 400)
        .json({ error: "Unknown portal." });
    }
    auth.requireRole(portal)(req, res, () => {
      req.actor = {
        role: portal,
        accountId: req.account.id,
        identity:
          portal === "admin"
            ? req.account.email || req.account.login_id
            : req.account.login_id,
        ownerName: req.account.name || "",
      };
      next();
    });
  };

  const fail = (res, err, context) => {
    if (err instanceof RegistrationError) {
      return res
        .status(err.status)
        .json({
          error: err.message,
          ...(err.field ? { field: err.field } : {}),
        });
    }
    console.error(context, err && err.message);
    return res
      .status(500)
      .json({ error: "Something went wrong on the server. Please try again." });
  };

  // The rider master contains personal phone numbers. Keep it server-side and expose it only to admins.
  app.get("/api/rider-master-directory", guard, (req, res) => {
    if (req.actor.role !== "admin")
      return res
        .status(403)
        .json({
          error: "Only the admin can access the rider master directory.",
        });
    try {
      const file = new URL(
        "./data/rider-master-directory.json",
        import.meta.url,
      );
      const items = JSON.parse(fs.readFileSync(file, "utf8"));
      res.set("Cache-Control", "private, no-store");
      res.json({ ok: true, items });
    } catch (err) {
      fail(res, err, "Could not load the rider master directory:");
    }
  });

  app.get("/api/rider-registrations", guard, (req, res) => {
    try {
      res.json({ ok: true, items: service.list(req.actor) });
    } catch (err) {
      fail(res, err, "Could not load rider registrations:");
    }
  });

  app.get("/api/rider-registrations/:id", guard, (req, res) => {
    try {
      res.json({ ok: true, item: service.get(req.actor, req.params.id) });
    } catch (err) {
      fail(res, err, "Could not load the rider registration:");
    }
  });

  app.post("/api/rider-registrations", guard, (req, res) => {
    upload.fields([
      { name: "selfie", maxCount: 1 },
      { name: "aadhaar", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          error:
            err.code === "LIMIT_FILE_SIZE"
              ? "Each document must be 5 MB or smaller."
              : "The form could not be read. Please check the files and try again.",
        });
      }
      try {
        const files = {
          selfie: req.files?.selfie?.[0],
          aadhaar: req.files?.aadhaar?.[0],
        };
        const item = service.create(req.actor, req.body || {}, files);
        res.status(201).json({ ok: true, item });
      } catch (error) {
        fail(res, error, "Could not save the rider registration:");
      }
    });
  });

  app.put("/api/rider-registrations/:id", guard, (req, res) => {
    upload.fields([
      { name: "selfie", maxCount: 1 },
      { name: "aadhaar", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          error:
            err.code === "LIMIT_FILE_SIZE"
              ? "Each document must be 5 MB or smaller."
              : "The form could not be read. Please check the files and try again.",
        });
      }
      try {
        const files = {
          selfie: req.files?.selfie?.[0],
          aadhaar: req.files?.aadhaar?.[0],
        };
        res.json({
          ok: true,
          item: service.update(req.actor, req.params.id, req.body || {}, files),
        });
      } catch (error) {
        fail(res, error, "Could not update the rider profile:");
      }
    });
  });

  app.post("/api/rider-registrations/:id/status", guard, (req, res) => {
    try {
      const item = service.setStatus(req.actor, req.params.id, req.body || {});
      if (item?.status === "APPROVED" && typeof onApproved === "function") {
        try {
          onApproved(String(req.actor?.identity || req.actor?.role || ""));
        } catch (err) {
          console.error(
            "Could not re-check pending payment rows after approval:",
            err.message,
          );
        }
      }
      res.json({ ok: true, item });
    } catch (err) {
      fail(res, err, "Could not change the application status:");
    }
  });

  app.get("/api/rider-registrations/:id/files/:kind", guard, (req, res) => {
    try {
      const file = service.fileFor(req.actor, req.params.id, req.params.kind);
      res.set({
        "Content-Type": file.type,
        "Content-Disposition": `inline; filename="${String(file.name).replace(/["\\]/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.sendFile(file.path, (sendErr) => {
        if (sendErr && !res.headersSent)
          res.status(404).json({ error: "File not found." });
      });
    } catch (err) {
      fail(res, err, "Could not open the document:");
    }
  });
}
