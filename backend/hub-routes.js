// HTTP routes for Hub Management (Admin Portal only). Every route needs an admin sign-in (the guard passed in).
// The rules and the database work are in hubs.js.
import { HubError } from "./hubs.js";

export function registerHubRoutes(app, { guard, service }) {
  const actor = (req) => req.adminEmail || "";

  const fail = (res, err, context) => {
    if (err instanceof HubError) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.field ? { field: err.field } : {}),
        ...(err.errors?.length ? { errors: err.errors } : {}),
      });
    }
    console.error(context, err && err.message);
    return res
      .status(500)
      .json({ error: "Something went wrong on the server. Please try again." });
  };

  app.get("/api/admin/hubs", guard, (req, res) => {
    try {
      res.json({ ok: true, hubs: service.list() });
    } catch (err) {
      fail(res, err, "Could not load hubs:");
    }
  });

  app.post("/api/admin/hubs", guard, (req, res) => {
    try {
      res
        .status(201)
        .json({ ok: true, hub: service.create(req.body || {}, actor(req)) });
    } catch (err) {
      fail(res, err, "Could not add the hub:");
    }
  });

  // Partial update: send only the fields to change, e.g. {"phone":"9876543210"}.
  app.patch("/api/admin/hubs/:id", guard, (req, res) => {
    try {
      res.json({
        ok: true,
        ...service.update(req.params.id, req.body || {}, actor(req)),
      });
    } catch (err) {
      fail(res, err, "Could not update the hub:");
    }
  });

  app.delete("/api/admin/hubs/:id", guard, (req, res) => {
    try {
      res.json(service.remove(req.params.id, actor(req)));
    } catch (err) {
      fail(res, err, "Could not delete the hub:");
    }
  });

  app.post("/api/admin/hubs/:id/notes", guard, (req, res) => {
    try {
      res.json({
        ok: true,
        ...service.addNote(req.params.id, req.body || {}, actor(req)),
      });
    } catch (err) {
      fail(res, err, "Could not save the hub note:");
    }
  });

  // Excel / CSV import. dryRun defaults to true, so nothing is saved unless the client asks for it.
  app.post("/api/admin/hubs/import", guard, (req, res) => {
    try {
      const body = req.body || {};
      const report = service.importRows(body.rows, {
        source: body.source === "browser" ? "browser" : "excel",
        dryRun: body.dryRun !== false,
        actor: actor(req),
        fileName: body.fileName || "",
      });
      res.json({ ok: true, report });
    } catch (err) {
      fail(res, err, "Could not import the hubs:");
    }
  });
}
