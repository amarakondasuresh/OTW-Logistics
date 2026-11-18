// HTTP routes for Google Drive payment sync (Admin Portal only). Every route needs an admin sign-in (the guard passed in).
// The rules and the Google calls are in drive-sync.js.
import { DriveSyncError } from "./drive-sync.js";

export function registerDriveSyncRoutes(app, { guard, service, baseUrlOf }) {
  const fail = (res, err, context) => {
    if (err instanceof DriveSyncError)
      return res.status(err.status).json({ error: err.message });
    console.error(context, err && err.message);
    return res
      .status(500)
      .json({ error: "Something went wrong on the server. Please try again." });
  };
  const admin = (req) => req.adminEmail || "";

  app.get("/api/admin/drive", guard, (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json({ ok: true, ...service.status() });
    } catch (err) {
      fail(res, err, "Drive status:");
    }
  });

  // Returns the Google sign-in address; the dashboard opens it in the same browser tab.
  app.get("/api/admin/drive/connect", guard, (req, res) => {
    try {
      res.json({
        ok: true,
        url: service.connectUrl({
          adminEmail: admin(req),
          baseUrl: baseUrlOf(req),
        }),
      });
    } catch (err) {
      fail(res, err, "Drive connect:");
    }
  });

  // Google sends the browser back here. The state must match the admin who started the sign-in.
  app.get("/api/admin/drive/callback", guard, async (req, res) => {
    try {
      await service.completeConnect({
        code: req.query.code,
        state: req.query.state,
        adminEmail: admin(req),
        baseUrl: baseUrlOf(req),
      });
      res.redirect("/dashboard/?drive=connected");
    } catch (err) {
      if (!(err instanceof DriveSyncError))
        console.error("Drive callback:", err && err.message);
      res.redirect("/dashboard/?drive=error");
    }
  });

  app.get("/api/admin/drive/folders", guard, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json({ ok: true, folders: await service.listFolders() });
    } catch (err) {
      fail(res, err, "Drive folders:");
    }
  });

  app.post("/api/admin/drive/folder", guard, async (req, res) => {
    try {
      res.json({
        ok: true,
        folder: await service.chooseFolder({
          folderId: req.body?.folderId,
          actor: admin(req),
        }),
      });
    } catch (err) {
      fail(res, err, "Drive folder:");
    }
  });

  // Sync Now. Returns the outcome of this run.
  app.post("/api/admin/drive/sync", guard, async (req, res) => {
    try {
      res.json({
        ok: true,
        result: await service.sync({ trigger: "manual", actor: admin(req) }),
      });
    } catch (err) {
      fail(res, err, "Drive sync:");
    }
  });

  app.post("/api/admin/drive/disconnect", guard, async (req, res) => {
    try {
      res.json(await service.disconnect({ actor: admin(req) }));
    } catch (err) {
      fail(res, err, "Drive disconnect:");
    }
  });
}
