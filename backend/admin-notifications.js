// Admin notifications for Franchise / Vendor applications submitted on the public website.
//
// One notification is created per application (UNIQUE application_id), so a repeated submit can never create a
// second one. Read / unread / deleted state is kept per admin account, so one admin reading or deleting a
// notification does not change it for another admin. Deleting a notification never deletes the application.
//
// The admin email is sent after the application and notification are saved. A failed send is kept as
// "failed" with its reason and retried with a growing wait (processDue, called by server.js). The
// application and the dashboard notification are never rolled back because of email.
//
// Works with better-sqlite3 (server.js) and node:sqlite (tests): only prepare/run/get/all are used.

import crypto from "node:crypto";

export const EMAIL_SUBJECT =
  "New Vendor / Franchise Application Received – On The Way Logistics";
export const MAX_EMAIL_ATTEMPTS = 5;
export const TYPES = ["Vendor", "Franchise"];
// "New" = not opened by this admin yet (unread). The others are the application's own status.
export const FILTER_STATUSES = ["New", "Pending", "Approved", "Rejected"];

const TIME_ZONE = "Asia/Kolkata";

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const oneLine = (v) =>
  String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Stored statuses: New, Contacted, Under Review, Documents Pending (all undecided), Accepted, Rejected.
// The dashboard shows every undecided application as Pending, Accepted as Approved.
export function displayStatus(status) {
  const s = String(status ?? "").trim();
  if (s === "Accepted" || s === "Approved") return "Approved";
  if (s === "Rejected") return "Rejected";
  return "Pending";
}

export function istDate(iso) {
  const d = new Date(iso);
  return isNaN(d)
    ? ""
    : d.toLocaleDateString("en-IN", { timeZone: TIME_ZONE, day: "2-digit", month: "short", year: "numeric" });
}
export function istTime(iso) {
  const d = new Date(iso);
  return isNaN(d)
    ? ""
    : d.toLocaleTimeString("en-IN", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: true });
}

// Email to the admin(s). Every applicant-typed value is escaped in HTML and kept to one line in text.
export function adminApplicationEmail(app, { dashboardUrl = "", status = "Pending" } = {}) {
  const rows = [
    ["Application ID", app.app_id],
    ["Applicant Name", app.name],
    ["Application Type", app.type],
    ["Mobile Number", app.mobile],
    ["Submission Date and Time", `${istDate(app.submitted_at)}, ${istTime(app.submitted_at)} IST`],
    ["Application Status", status],
  ];
  const text = [
    "A new Franchise or Vendor application was submitted on the On The Way Logistics website.",
    "",
    ...rows.map(([k, v]) => `${k}: ${oneLine(v)}`),
    "",
    "View the complete application in the Admin Dashboard:",
    dashboardUrl,
    "",
    "This is an automatic notification. Each application is emailed once.",
  ].join("\n");
  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 12px;color:#5b6b7d;font-size:13px;border-bottom:1px solid #e6eef5">${esc(k)}</td><td style="padding:8px 12px;font-size:14px;font-weight:600;color:#14263b;border-bottom:1px solid #e6eef5">${esc(oneLine(v))}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#eef3f8"><div style="max-width:560px;margin:0 auto;padding:16px;font-family:Arial,Helvetica,sans-serif;color:#14263b"><div style="background:#0b2a4a;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0"><strong style="font-size:16px;letter-spacing:.5px">ON THE WAY LOGISTICS</strong></div><div style="background:#fff;padding:20px 18px;border-radius:0 0 10px 10px;border:1px solid #dbe6f0;border-top:0"><h1 style="font-size:19px;margin:0 0 12px">New Application Received</h1><p style="font-size:14px;line-height:1.55;margin:0 0 12px">A new ${esc(app.type)} application was submitted on the website. Please check the application details.</p><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:14px 0;background:#f6f9fc;border:1px solid #dbe6f0">${table}</table>${dashboardUrl ? `<p style="margin:18px 0 0"><a href="${esc(dashboardUrl)}" style="background:#0b2a4a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px">View application in Admin Dashboard</a></p>` : ""}</div></div></body></html>`;
  return { subject: EMAIL_SUBJECT, text, html };
}

// Keeps only the email-address shape check; the real delivery result comes from the mail server.
const EMAIL_OK = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const safeError = (e) => oneLine(e?.message || String(e || "send failed")).slice(0, 300);

export function createAdminNotifications({
  db,
  transport,
  recipients = () => [],
  audit = () => {},
  log = console,
  now = () => new Date(),
  maxAttempts = MAX_EMAIL_ATTEMPTS,
  onCreated = () => {},
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_notifications(
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL UNIQUE,
      app_id TEXT NOT NULL,
      application_type TEXT NOT NULL,
      dashboard_base TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      email_status TEXT NOT NULL DEFAULT 'pending',
      email_attempts INTEGER NOT NULL DEFAULT 0,
      email_error TEXT NOT NULL DEFAULT '',
      email_sent_at TEXT,
      next_email_at TEXT
    );
    CREATE INDEX IF NOT EXISTS admin_notifications_created ON admin_notifications(created_at);
    CREATE TABLE IF NOT EXISTS admin_notification_states(
      notification_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      read_at TEXT,
      deleted_at TEXT,
      PRIMARY KEY(notification_id, account_id)
    );`);

  const inFlight = new Set();
  const iso = () => now().toISOString();

  function loadRow(notificationId) {
    return db
      .prepare(
        `SELECT n.*, a.name, a.mobile, a.email, a.status AS application_status, a.submitted_at, a.app_id AS saved_app_id, a.type AS saved_type
         FROM admin_notifications n JOIN partner_applications a ON a.id = n.application_id WHERE n.id = ?`,
      )
      .get(notificationId);
  }

  // Creates the notification for a saved application. Safe to call twice: the second call changes nothing.
  // Returns {id, created}. Throws if the application is not in the database (a notification must never
  // exist without its application).
  function create({ applicationId, dashboardBase = "" }) {
    const app = db
      .prepare("SELECT id, app_id, type FROM partner_applications WHERE id = ?")
      .get(applicationId);
    if (!app) throw new Error("Application is not saved; no notification created.");
    const id = crypto.randomUUID();
    const result = db
      .prepare(
        `INSERT INTO admin_notifications(id,application_id,app_id,application_type,dashboard_base,created_at,email_status)
         VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(application_id) DO NOTHING`,
      )
      .run(id, app.id, app.app_id, app.type, String(dashboardBase || ""), iso());
    const created = Number(result?.changes || 0) === 1;
    if (!created) {
      const existing = db
        .prepare("SELECT id FROM admin_notifications WHERE application_id = ?")
        .get(app.id);
      return { id: existing.id, created: false };
    }
    onCreated({ id, applicationId: app.id, appId: app.app_id, type: app.type });
    return { id, created: true };
  }

  // Unread = not deleted by this admin and not marked read by this admin.
  function unreadCount(accountId) {
    return Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM admin_notifications n
           LEFT JOIN admin_notification_states s ON s.notification_id = n.id AND s.account_id = ?
           WHERE COALESCE(s.deleted_at,'') = '' AND s.read_at IS NULL`,
        )
        .get(accountId)?.n || 0,
    );
  }

  function toItem(r) {
    return {
      id: r.id,
      applicationId: r.application_id,
      appId: r.app_id,
      type: r.application_type,
      name: r.name || "",
      mobile: r.mobile || "",
      email: r.email || "",
      submittedAt: r.submitted_at,
      submissionDate: istDate(r.submitted_at),
      submissionTime: istTime(r.submitted_at),
      status: displayStatus(r.application_status),
      applicationStatus: r.application_status,
      unread: !r.read_at,
      emailStatus: r.email_status,
      emailAttempts: r.email_attempts,
      emailError: r.email_error || "",
      emailSentAt: r.email_sent_at || "",
      createdAt: r.created_at,
    };
  }

  // Filters: type = Vendor | Franchise; status = New (unread) | Pending | Approved | Rejected.
  function list(accountId, { type = "", status = "", limit = 500 } = {}) {
    const rows = db
      .prepare(
        `SELECT n.id, n.application_id, n.app_id, n.application_type, n.created_at, n.email_status, n.email_attempts,
                n.email_error, n.email_sent_at, a.name, a.mobile, a.email, a.status AS application_status,
                a.submitted_at, s.read_at, s.deleted_at
         FROM admin_notifications n
         JOIN partner_applications a ON a.id = n.application_id
         LEFT JOIN admin_notification_states s ON s.notification_id = n.id AND s.account_id = ?
         WHERE COALESCE(s.deleted_at,'') = ''
         ORDER BY a.submitted_at DESC`,
      )
      .all(accountId);
    const wantType = TYPES.includes(type) ? type : "";
    const wantStatus = FILTER_STATUSES.includes(status) ? status : "";
    const items = rows
      .map(toItem)
      .filter((n) => !wantType || n.type === wantType)
      .filter((n) =>
        !wantStatus
          ? true
          : wantStatus === "New"
            ? n.unread
            : n.status === wantStatus,
      )
      .slice(0, Math.max(1, Math.min(Number(limit) || 500, 1000)));
    return { items, unreadCount: unreadCount(accountId) };
  }

  function exists(notificationId, accountId) {
    return !!db
      .prepare(
        `SELECT n.id FROM admin_notifications n
         LEFT JOIN admin_notification_states s ON s.notification_id = n.id AND s.account_id = ?
         WHERE n.id = ? AND COALESCE(s.deleted_at,'') = ''`,
      )
      .get(accountId, notificationId);
  }

  // read=true marks read; read=false marks unread. Returns false when the notification is unknown to this admin.
  function setRead(accountId, notificationId, read) {
    if (!exists(notificationId, accountId)) return false;
    db.prepare(
      `INSERT INTO admin_notification_states(notification_id,account_id,read_at) VALUES(?,?,?)
       ON CONFLICT(notification_id,account_id) DO UPDATE SET read_at=excluded.read_at`,
    ).run(notificationId, accountId, read ? iso() : null);
    return true;
  }

  // Removes the notification from this admin's list only.
  function remove(accountId, notificationId) {
    if (!db.prepare("SELECT id FROM admin_notifications WHERE id = ?").get(notificationId)) return false;
    db.prepare(
      `INSERT INTO admin_notification_states(notification_id,account_id,read_at,deleted_at) VALUES(?,?,?,?)
       ON CONFLICT(notification_id,account_id) DO UPDATE SET deleted_at=excluded.deleted_at, read_at=COALESCE(admin_notification_states.read_at, excluded.read_at)`,
    ).run(notificationId, accountId, iso(), iso());
    return true;
  }

  function recipientList() {
    return [...new Set((recipients() || []).map((a) => String(a || "").trim()).filter((a) => EMAIL_OK.test(a)))];
  }

  function markFailed(notificationId, attempts, reason) {
    const wait = Math.min(2 ** attempts, 60); // minutes: 2, 4, 8, 16, 32
    db.prepare(
      "UPDATE admin_notifications SET email_status='failed', email_attempts=?, email_error=?, next_email_at=? WHERE id=?",
    ).run(attempts, reason, new Date(now().getTime() + wait * 60_000).toISOString(), notificationId);
    return { sent: false, reason };
  }

  // Sends the admin email for one notification. Used for the first send, retries and the Resend button.
  async function sendEmail(notificationId, { actor = "system" } = {}) {
    if (inFlight.has(notificationId)) return null;
    inFlight.add(notificationId);
    try {
      const n = loadRow(notificationId);
      if (!n) return null;
      if (n.email_status === "sent") return { sent: true, reason: "" };
      const attempts = Number(n.email_attempts || 0) + 1;
      const to = recipientList();
      if (!to.length)
        return markFailed(
          notificationId,
          attempts,
          "No admin email address is set. Add ADMIN_EMAIL to backend/.env (or register an admin with an email address).",
        );
      const dashboardUrl = n.dashboard_base
        ? `${n.dashboard_base}/dashboard/?notification=${encodeURIComponent(notificationId)}`
        : "";
      const msg = adminApplicationEmail(
        { app_id: n.app_id, type: n.application_type, name: n.name, mobile: n.mobile, submitted_at: n.submitted_at },
        { dashboardUrl, status: displayStatus(n.application_status) },
      );
      try {
        await transport.sendMail({ to: to.join(", "), subject: msg.subject, text: msg.text, html: msg.html });
      } catch (err) {
        const reason = safeError(err);
        log.error?.(`[admin-notification] email failed for ${n.app_id}: ${reason}`);
        audit(actor, "admin_notification_email_failed", { appId: n.app_id, attempts, reason });
        return markFailed(notificationId, attempts, reason);
      }
      db.prepare(
        "UPDATE admin_notifications SET email_status='sent', email_attempts=?, email_error='', email_sent_at=?, next_email_at=NULL WHERE id=?",
      ).run(attempts, iso(), notificationId);
      audit(actor, "admin_notification_email_sent", { appId: n.app_id, attempts, recipients: to.length });
      return { sent: true, reason: "" };
    } finally {
      inFlight.delete(notificationId);
    }
  }

  // Retry worker: sends emails that are pending or failed, not yet at the attempt limit, and due.
  async function processDue() {
    const due = db
      .prepare(
        `SELECT id FROM admin_notifications
         WHERE email_status IN ('pending','failed') AND email_attempts < ?
           AND (next_email_at IS NULL OR next_email_at <= ?)
         ORDER BY created_at LIMIT 20`,
      )
      .all(maxAttempts, iso());
    for (const row of due) await sendEmail(row.id, { actor: "retry" });
    return due.length;
  }

  // Lets an admin see whether the email went out and why it did not.
  function emailStatusOf(notificationId) {
    const n = loadRow(notificationId);
    return n ? { status: n.email_status, attempts: n.email_attempts, error: n.email_error } : null;
  }

  return {
    create,
    list,
    unreadCount,
    setRead,
    remove,
    sendEmail,
    processDue,
    emailStatusOf,
    exists,
    loadRow,
  };
}
