// HTTP routes for the Weekly Payments table (Admin Portal only). Every route needs an admin sign-in (the guard passed in).
// The rules and the database work are in weekly-payments.js.
import { WeeklyPaymentError } from "./weekly-payments.js";

export function registerWeeklyPaymentRoutes(app, { guard, service }) {
  const fail = (res, err, context) => {
    if (err instanceof WeeklyPaymentError)
      return res.status(err.status).json({ error: err.message });
    console.error(context, err && err.message);
    return res
      .status(500)
      .json({ error: "Something went wrong on the server. Please try again." });
  };

  // All saved weekly payments (optional ?q= searches rider name, Rider ID and week) plus the last import.
  app.get("/api/admin/weekly-payments", guard, (req, res) => {
    try {
      res.json({
        ok: true,
        ...service.list({
          q: typeof req.query.q === "string" ? req.query.q : "",
        }),
      });
    } catch (err) {
      fail(res, err, "Could not load the weekly payments:");
    }
  });

  // Rows waiting for Rider Verification, with the registered riders an Admin can choose from.
  app.get("/api/admin/weekly-payments/pending", guard, (req, res) => {
    try {
      res.json({ ok: true, ...service.listPending() });
    } catch (err) {
      fail(res, err, "Could not load the pending rider rows:");
    }
  });

  // Admin maps one pending weekly row; the saved mapping resolves all weeks for that Excel rider.
  app.post("/api/admin/weekly-payments/pending/:id/map", guard, (req, res) => {
    try {
      res.json({
        ok: true,
        result: service.mapPending(
          req.params.id,
          String(req.body?.riderId || ""),
          req.adminEmail || "",
        ),
      });
    } catch (err) {
      fail(res, err, "Could not map the rider:");
    }
  });

  // Admin sets one saved rider-week's payment status: {status: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED'}.
  app.post("/api/admin/weekly-payments/:id/status", guard, (req, res) => {
    try {
      res.json({
        ok: true,
        result: service.setPaymentStatus(
          req.params.id,
          req.body?.status,
          req.adminEmail || "",
        ),
      });
    } catch (err) {
      fail(res, err, "Could not update the payment status:");
    }
  });

  // Saves the rows read from an Excel sheet: {fileName, fileHash, records:[...]}. Safe to send twice (no duplicates).
  app.post("/api/admin/weekly-payments/import", guard, (req, res) => {
    try {
      res.json({
        ok: true,
        result: service.importRecords(req.body || {}, req.adminEmail || ""),
      });
    } catch (err) {
      fail(res, err, "Could not save the weekly payments:");
    }
  });
}
