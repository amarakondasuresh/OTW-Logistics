import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import multer from "multer";
import nodemailer from "nodemailer";
import { createAuth } from "./auth.js";
import { createPasswordResetService } from "./password-reset.js";
import { createPasswordHelpService } from "./admin-password-help.js";
import {
  submittedEmail,
  approvedEmail,
  rejectedEmail,
  newPasswordEmail,
} from "./partner-emails.js";
import { readRiderScreenshot } from "./ocr.js";
import { createRiderRegistrationService } from "./rider-registrations.js";
import {
  createPaymentImportService,
  PaymentImportError,
} from "./payment-imports.js";
import { registerRiderRegistrationRoutes } from "./rider-registration-routes.js";
import { createSupportService } from "./support-tickets.js";
import { registerSupportRoutes } from "./support-routes.js";
import { createSupportMailer } from "./support-mail.js";
import { createGmailApi, createGmailInbound, gmailConfigFrom } from "./support-inbound.js";
import { createHubService } from "./hubs.js";
import { registerHubRoutes } from "./hub-routes.js";
import {
  createWeeklyPaymentService,
  partnerGroupsForImport,
} from "./weekly-payments.js";
import { partnerPortalPayload } from "./partner-reports.js";
import { registerWeeklyPaymentRoutes } from "./weekly-payment-routes.js";
import {
  createAdminDocumentService,
} from "./admin-documents.js";
import { registerAdminDocumentRoutes } from "./admin-document-routes.js";
import { createLocationService, registerLocationRoutes } from "./locations.js";
import { createDriveSyncService } from "./drive-sync.js";
import { registerDriveSyncRoutes } from "./drive-sync-routes.js";
import { createAdminNotifications } from "./admin-notifications.js";
import { createRequire } from "node:module";
import {
  recordsFromWeeklyRows,
  hubMapOf,
  buildReport,
  ReportError,
} from "./report-stats.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "uploads");
const app = express();
const PORT = Number(process.env.PORT || 8080);
const ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;
const db = new Database(path.join(__dirname, "payments.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,payer_name TEXT NOT NULL,payer_email TEXT,payer_type TEXT,amount INTEGER NOT NULL,frequency TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'razorpay',gateway_subscription_id TEXT UNIQUE,mandate_id TEXT,consent_at TEXT NOT NULL,created_at TEXT NOT NULL,next_payment_at TEXT,retry_count INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,gateway_payment_id TEXT UNIQUE,subscription_id TEXT,gateway_subscription_id TEXT,transaction_id TEXT,amount INTEGER,status TEXT,method TEXT,payer_name TEXT,payment_date TEXT,auto_pay_status TEXT,raw_event TEXT,created_at TEXT);CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,admin_email TEXT,action TEXT,details TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS partner_applications(id TEXT PRIMARY KEY,app_id TEXT UNIQUE NOT NULL,type TEXT NOT NULL,name TEXT NOT NULL,contact TEXT,mobile TEXT,whatsapp TEXT,email TEXT,state TEXT,district TEXT,city TEXT,pincode TEXT,address TEXT,education TEXT,remarks TEXT,status TEXT NOT NULL DEFAULT 'New',payload TEXT NOT NULL,submitted_at TEXT NOT NULL);`);
// Each website submission carries a key made once per form. A repeated submit with the same key returns the
// application that was already saved instead of creating a second one.
try {
  db.exec("ALTER TABLE partner_applications ADD COLUMN submission_key TEXT");
} catch {
  // column already exists
}
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS partner_applications_submission_key ON partner_applications(submission_key) WHERE submission_key IS NOT NULL",
);

// ===================== Sign-in (admins, vendors, franchise partners) =====================
const auth = createAuth(db);
// The four admins. On the very first start (no admin accounts yet) each gets a random temporary
// password, printed in the server window and saved to backend/FIRST-ADMIN-PASSWORDS.txt. They must choose
// their own password at first sign-in. Later: add or reset admins with  node reset-admin-password.js
const INITIAL_ADMINS = [
  ["balajinaik5069@gmail.com", "M. Balajinaik"],
  ["koppelagayathri@gmail.com", "Koppela Gayathri"],
  ["admin3@onthewaylogistics.in", "Admin 3"],
  ["admin4@onthewaylogistics.in", "Admin 4"],
];
if (
  db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role='admin'").get()
    .n === 0
) {
  const lines = [];
  for (const [email, name] of INITIAL_ADMINS) {
    const password = auth.tempPassword();
    await auth.createAccount({
      role: "admin",
      loginId: email,
      email,
      name,
      password,
      mustChange: true,
    });
    lines.push(`  ${name.padEnd(18)} ${email.padEnd(32)} ${password}`);
  }
  const text = `ON THE WAY LOGISTICS - first admin sign-in (created ${new Date().toLocaleString()})\n\nSign in at /dashboard/ with the email and temporary password below.\nEach admin must choose their own password at first sign-in. Give each person only their own line,\nthen DELETE THIS FILE.\n\n${lines.join("\n")}\n`;
  try {
    fs.writeFileSync(path.join(__dirname, "FIRST-ADMIN-PASSWORDS.txt"), text, {
      mode: 0o600,
    });
  } catch (e) {}
  console.log(
    "\n" +
      "=".repeat(78) +
      "\n" +
      text +
      "(Also saved to backend/FIRST-ADMIN-PASSWORDS.txt)\n" +
      "=".repeat(78) +
      "\n",
  );
}
// One Super Admin manages the other admins' accounts (SUPER_ADMIN_EMAIL in backend/.env, else the earliest admin).
auth.ensureSuperAdmin(process.env.SUPER_ADMIN_EMAIL);
auth.cleanupSessions();
setInterval(() => auth.cleanupSessions(), 60 * 60 * 1000).unref();
// Behind an HTTPS proxy/host (Render, Railway, Nginx...) set TRUST_PROXY=true so cookies are marked Secure.
if (process.env.TRUST_PROXY)
  app.set(
    "trust proxy",
    process.env.TRUST_PROXY === "true" ? 1 : process.env.TRUST_PROXY,
  );

app.use(helmet({ contentSecurityPolicy: false }));
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};
const TRUSTED_ORIGINS = new Set(
  [
    ORIGIN,
    originOf(process.env.PUBLIC_URL || ""),
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:5501",
    "http://127.0.0.1:5501",
  ].filter(Boolean),
);
// Host names this server answers to: localhost, IP addresses (e.g. 192.168.x.x on your network), and the
// addresses in ALLOWED_ORIGIN / PUBLIC_URL / ALLOWED_HOSTS. Unknown domain names are refused.
const KNOWN_HOSTS = new Set([
  "localhost",
  ...[...TRUSTED_ORIGINS].map((o) => new URL(o).hostname),
  ...String(process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
]);
const hostnameOf = (req) =>
  String(req.headers.host || "")
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
const isKnownHost = (req) => {
  const h = hostnameOf(req);
  return (
    KNOWN_HOSTS.has(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")
  );
};
const isTrustedOrigin = (req, origin) =>
  TRUSTED_ORIGINS.has(origin) ||
  (isKnownHost(req) && origin === `${req.protocol}://${req.get("host")}`);
let warnedHost = false;
app.use("/api", (req, res, next) => {
  if (isKnownHost(req)) return next();
  if (!warnedHost) {
    warnedHost = true;
    console.warn(
      `Refused API request for unknown address "${hostnameOf(req)}". If this is your site's address, set PUBLIC_URL (or ALLOWED_HOSTS) in backend/.env.`,
    );
  }
  res
    .status(421)
    .json({
      error:
        "This server is not set up for this web address. The site owner must add it to PUBLIC_URL in backend/.env.",
    });
});
app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  res.setHeader("Vary", "Origin");
  if (origin && isTrustedOrigin(req, origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else if (origin === "null")
    res.setHeader("Access-Control-Allow-Origin", "null"); // pages opened from disk may submit the public forms only
  else res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// Signed-in actions must come from this site's own pages (protects the session cookies from other websites).
const PUBLIC_POSTS = new Set([
  "/api/partner-applications",
  "/api/support",
  "/api/razorpay/webhook",
]);
app.use("/api", (req, res, next) => {
  if (
    ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
    PUBLIC_POSTS.has(req.originalUrl.split("?")[0])
  )
    return next();
  const origin = req.headers.origin;
  if (origin && !isTrustedOrigin(req, origin))
    return res
      .status(403)
      .json({
        error:
          "This request was blocked because it did not come from the On The Way Logistics site.",
      });
  next();
});
// General limit for the API only. Pages, scripts, styles and images are not limited: one page load fetches 20+ files,
// so a shared office connection would otherwise see a blank page. Sign-in, applications and the support form keep
// their own stricter limits below.
app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a minute and try again." },
  }),
);

// Admin API access now requires a signed-in admin session (the old X-Admin-Email header is no longer trusted).
const adminGuard = auth.requireRole("admin");
function adminEmailOf(req) {
  const s = auth.getSession(req, "admin");
  return s && !s.account.must_change_password
    ? s.account.email || s.account.login_id
    : "";
}
function razorHeaders() {
  return {
    Authorization:
      "Basic " +
      Buffer.from(
        `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`,
      ).toString("base64"),
    "Content-Type": "application/json",
  };
}
async function razor(pathname, options = {}) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
    throw new Error("Razorpay backend credentials are not configured");
  const r = await fetch("https://api.razorpay.com/v1" + pathname, {
    ...options,
    headers: { ...razorHeaders(), ...(options.headers || {}) },
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok)
    throw new Error(
      data?.error?.description || `Razorpay API error ${r.status}`,
    );
  return data;
}
function planFor(f) {
  return f === "Daily"
    ? process.env.RAZORPAY_PLAN_DAILY_ID
    : f === "Monthly"
      ? process.env.RAZORPAY_PLAN_MONTHLY_ID
      : process.env.RAZORPAY_PLAN_WEEKLY_ID;
}
function audit(email, action, details) {
  db.prepare(
    "INSERT INTO audit_log(admin_email,action,details,created_at) VALUES(?,?,?,?)",
  ).run(email, action, JSON.stringify(details || {}), new Date().toISOString());
}

// IMPORTANT: raw body is required for webhook HMAC verification.
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
      const signature = String(req.header("X-Razorpay-Signature") || "");
      if (!secret || !signature)
        return res.status(400).send("Webhook secret/signature missing");
      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");
      if (
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
      )
        return res.status(400).send("Invalid signature");
      const event = JSON.parse(req.body.toString("utf8"));
      const entity =
        event?.payload?.payment?.entity ||
        event?.payload?.subscription?.entity ||
        {};
      const payment = event?.payload?.payment?.entity;
      if (payment) {
        const status =
          event.event === "payment.captured" ||
          event.event === "payment.authorized"
            ? "Successful"
            : event.event === "payment.failed"
              ? "Failed"
              : "Pending";
        db.prepare(
          `INSERT INTO transactions(gateway_payment_id,subscription_id,gateway_subscription_id,transaction_id,amount,status,method,payer_name,payment_date,auto_pay_status,raw_event,created_at) VALUES(@gateway_payment_id,@subscription_id,@gateway_subscription_id,@transaction_id,@amount,@status,@method,@payer_name,@payment_date,@auto_pay_status,@raw_event,@created_at) ON CONFLICT(gateway_payment_id) DO UPDATE SET status=excluded.status,raw_event=excluded.raw_event,payment_date=excluded.payment_date`,
        ).run({
          gateway_payment_id: payment.id,
          subscription_id: null,
          gateway_subscription_id: payment.subscription_id || null,
          transaction_id: payment.id,
          amount: Number(payment.amount || 0) / 100,
          status,
          method: payment.method || "Unknown",
          payer_name: "",
          payment_date: new Date().toISOString().slice(0, 10),
          auto_pay_status: payment.subscription_id ? "Active" : "Cancelled",
          raw_event: JSON.stringify(event),
          created_at: new Date().toISOString(),
        });
      }
      if (event.event?.startsWith("subscription.")) {
        const sub = entity;
        db.prepare(
          "UPDATE subscriptions SET status=?,next_payment_at=? WHERE gateway_subscription_id=?",
        ).run(
          String(sub.status || "unknown"),
          sub.charge_at
            ? new Date(Number(sub.charge_at) * 1000).toISOString()
            : null,
          sub.id,
        );
      }
      return res.sendStatus(200);
    } catch (err) {
      return res.status(500).send("Webhook processing error");
    }
  },
);
app.use("/api/portal", express.json({ limit: "1mb" })); // portal data can include a small profile photo
app.use("/api/admin/payment-import", express.json({ limit: "8mb" })); // a month of payment rows for many riders
app.use("/api/admin/weekly-payments", express.json({ limit: "12mb" })); // Weekly Payments Excel imports (up to 20,000 rows)
app.use("/api/admin/hubs", express.json({ limit: "2mb" })); // Hub Management Excel imports (up to 2,000 rows)
app.use(express.json({ limit: "100kb" }));

// ---------- Sign in / out / change password ----------
// Failed attempts are counted per person (IP + the ID they typed), so one mistyped password elsewhere - or several
// people behind one shared address - cannot lock every admin out. A wider per-IP cap still stops guessing across many IDs.
const loginIdOf = (req) =>
  String(req.body?.loginId || req.body?.email || "")
    .trim()
    .toLowerCase()
    .slice(0, 254);
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}|${loginIdOf(req)}`,
  message: {
    error: "Too many sign-in attempts. Please wait 15 minutes and try again.",
  },
});
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: "Too many sign-in attempts. Please wait 15 minutes and try again.",
  },
});
const portalOf = (v) => (auth.ROLES.includes(String(v || "")) ? String(v) : "");
app.post("/api/auth/login", loginIpLimiter, loginLimiter, async (req, res) => {
  try {
    const portal = portalOf(req.body?.portal),
      loginId = String(req.body?.loginId || "")
        .trim()
        .slice(0, 254),
      password = String(req.body?.password || "").slice(0, 200);
    if (!portal) return res.status(400).json({ error: "Unknown portal." });
    if (!loginId || !password)
      return res.status(400).json({ error: "Enter your ID and password." });
    // Several partner accounts may share one email: the password decides which one is meant.
    const candidates = auth.findCandidates(portal, loginId);
    let account = null;
    for (const c of candidates)
      if (await auth.verifyPassword(password, c.password_hash)) {
        account = c;
        break;
      }
    // Run a hash check even for unknown IDs so a wrong ID and a wrong password take the same time.
    if (!candidates.length)
      await auth.verifyPassword(
        password,
        "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      );
    if (!account) {
      if (portal === "admin")
        audit(loginId.toLowerCase(), "sign_in_failed", {
          reason: candidates.length ? "wrong_password" : "unknown_account",
        });
      return res.status(401).json({ error: "Incorrect ID or password." });
    }
    if (account.status !== "active") {
      if (portal === "admin")
        audit(account.email || account.login_id, "sign_in_blocked", {
          reason: "account_not_active",
        });
      return res
        .status(403)
        .json({
          error:
            "This account is not active. Please contact On The Way Logistics.",
        });
    }
    const ban = auth.banInfo(account);
    if (ban) {
      audit(account.login_id, "sign_in_blocked", { reason: "banned" });
      return res.status(403).json({ error: banMessage(ban, account.role), code: "BANNED" });
    }
    auth.startSession(req, res, account, { remember: !!req.body?.remember });
    audit(
      account.role === "admin" ? account.email : account.login_id,
      "signed_in",
      { portal, loginId: account.login_id },
    );
    res.json({ ok: true, account: auth.publicAccount(account) });
  } catch (err) {
    console.error("Login failed:", err.message);
    res
      .status(500)
      .json({ error: "Could not sign in right now. Please try again." });
  }
});
app.post("/api/auth/logout", (req, res) => {
  const portal = portalOf(req.body?.portal || req.query.portal);
  if (portal === "admin") {
    const s = auth.getSession(req, "admin");
    if (s) audit(s.account.email || s.account.login_id, "signed_out", {});
  }
  if (portal) auth.endSession(req, res, portal);
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) => {
  const portal = portalOf(req.query.portal);
  const s = portal && auth.getSession(req, portal);
  if (!s)
    return res
      .status(401)
      .json({ error: "Not signed in.", code: "NOT_SIGNED_IN" });
  res.json({ ok: true, account: auth.publicAccount(s.account) });
});
app.post("/api/auth/change-password", loginLimiter, async (req, res) => {
  try {
    const portal = portalOf(req.body?.portal);
    const s = portal && auth.getSession(req, portal);
    if (!s)
      return res
        .status(401)
        .json({ error: "Please sign in again.", code: "NOT_SIGNED_IN" });
    const current = String(req.body?.currentPassword || ""),
      next = String(req.body?.newPassword || "");
    if (!(await auth.verifyPassword(current, s.account.password_hash))) {
      audit(
        s.account.role === "admin" ? s.account.email : s.account.login_id,
        "password_change_failed",
        { portal, reason: "wrong_current_password" },
      );
      return res
        .status(400)
        .json({ error: "Your current password is not correct." });
    }
    const problem = auth.passwordProblem(next);
    if (problem)
      return res.status(400).json({ error: "New password: " + problem });
    if (current === next)
      return res
        .status(400)
        .json({
          error: "Choose a password that is different from the current one.",
        });
    await auth.setPassword(s.account.id, next, { mustChange: false });
    auth.endAllSessions(s.account.id, s.tokenHash); // sign out other devices, keep this one
    audit(
      s.account.role === "admin" ? s.account.email : s.account.login_id,
      "password_changed",
      { portal },
    );
    res.json({
      ok: true,
      account: auth.publicAccount(auth.accountById(s.account.id)),
    });
  } catch (err) {
    console.error("Password change failed:", err.message);
    res
      .status(500)
      .json({ error: "Could not change the password. Please try again." });
  }
});

// ---------- Admin: forgot / reset password by email ----------
// The reset link goes to the admin's registered email, sent with the same Gmail / SMTP settings as the other emails
// (backend/.env). Passwords are never emailed or shown; the link lets the admin choose a new one.
const resetRequestLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Too many password reset requests. Please wait 15 minutes and try again.",
  },
});
let warnedLocalResetLink = false;
const passwordResets = createPasswordResetService({
  auth,
  audit,
  log: console,
  sendMail: async ({ to, subject, text }) => {
    const mail = getMailTransporter();
    if (!mail) throw new Error("Email sending is not configured");
    try {
      await mail.transporter.sendMail({
        from: { name: "ON THE WAY LOGISTICS", address: mail.user },
        to,
        subject,
        text,
      });
    } catch (err) {
      mailCheck.at = 0; // check the email settings again on the next request
      throw err;
    }
  },
});
// Can reset emails be sent? Checked by signing in to the mail server (Gmail or SMTP from backend/.env). The result is
// kept for 10 minutes (1 minute after a failure), so the sign-in page stays fast. This answer is the same for every
// email address, so it does not reveal who is an admin.
let mailCheck = { at: 0, ready: false, problem: "", detail: "" };
async function mailStatus({ fresh = false } = {}) {
  const mail = getMailTransporter();
  if (!mail)
    return {
      ready: false,
      problem: "not_configured",
      detail:
        "Email is not set up. Add GMAIL_USER and GMAIL_APP_PASSWORD (or the SMTP settings) to backend/.env and restart the server.",
    };
  const maxAge = mailCheck.ready ? 10 * 60_000 : 60_000;
  if (!fresh && mailCheck.at && Date.now() - mailCheck.at < maxAge)
    return mailCheck;
  try {
    await Promise.race([
      mail.transporter.verify(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
          12_000,
        ).unref?.(),
      ),
    ]);
    mailCheck = {
      at: Date.now(),
      ready: true,
      problem: "",
      detail: `Email is ready (sending as ${mail.user}).`,
    };
  } catch (err) {
    const refused =
      err && (err.code === "EAUTH" || err.responseCode === 535 || err.responseCode === 534);
    mailCheck = {
      at: Date.now(),
      ready: false,
      problem: refused ? "refused" : "unreachable",
      detail: refused
        ? `The mail server refused the sign-in for ${mail.user}. Check GMAIL_USER and GMAIL_APP_PASSWORD in backend/.env: it must be a 16-character Google App Password (Google Account > Security > App passwords), not the normal Gmail password.`
        : `The mail server could not be reached (${err?.code || err?.message || "no answer"}). Check this computer's internet connection.`,
    };
  }
  return mailCheck;
}
// When reset emails cannot be sent, a Forgot password request goes to the Super Admin (Settings > Admin Accounts),
// who can give a temporary password. See admin-password-help.js.
const passwordHelp = createPasswordHelpService({ db, auth, audit });
app.get("/api/auth/forgot-password/options", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const mail = await mailStatus();
  res.json({ ok: true, email: mail.ready });
});
app.post("/api/auth/forgot-password", resetRequestLimiter, async (req, res) => {
  const mail = await mailStatus();
  if (!mail.ready) {
    const out = passwordHelp.requestHelp({ email: req.body?.email });
    return res.json({ ok: true, mode: out.mode, message: out.message });
  }
  const host = `${req.protocol}://${req.get("host")}`;
  if (
    !process.env.PUBLIC_URL &&
    !warnedLocalResetLink &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(host)
  ) {
    warnedLocalResetLink = true;
    console.warn(
      "Password reset links point to " +
        host +
        ". Set PUBLIC_URL in backend/.env to the address admins use on their phones, or the link will not open there.",
    );
  }
  const out = passwordResets.requestReset({
    email: req.body?.email,
    baseUrl: process.env.PUBLIC_URL || host,
  });
  res.json({ ok: true, mode: "email", message: out.message });
});
app.post("/api/auth/reset-password", resetRequestLimiter, async (req, res) => {
  try {
    const out = await passwordResets.completeReset({
      token: req.body?.token,
      newPassword: String(req.body?.newPassword || "").slice(0, 200),
    });
    if (!out.ok)
      return res.status(out.status || 400).json({ error: out.error });
    res.json({ ok: true });
  } catch (err) {
    console.error("Password reset failed:", err.message);
    res
      .status(500)
      .json({ error: "Could not reset the password. Please try again." });
  }
});

// ---------- Super Admin: manage administrator accounts ----------
// Only the Super Admin can list admins, send them a reset link or switch an account on / off. Everything is checked on
// the server; hiding the screen in the browser is not what protects it. No password or hash is ever returned.
const superAdminGuard = (req, res, next) =>
  auth.isSuperAdmin(req.account)
    ? next()
    : res
        .status(403)
        .json({
          error: "Only the Super Admin can manage administrator accounts.",
          code: "SUPER_ADMIN_ONLY",
        });
const baseUrlOf = (req) =>
  process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
const adminsWithHelp = () => {
  const open = passwordHelp.openRequests();
  return auth.listAdmins().map((a) => ({
    ...a,
    helpRequestedAt: open.get(a.loginId)?.requestedAt || null,
  }));
};
app.get("/api/admin/accounts", adminGuard, superAdminGuard, async (req, res) => {
  const mail = await mailStatus({ fresh: req.query.check === "1" });
  res.json({
    ok: true,
    admins: adminsWithHelp(),
    mailReady: mail.ready,
    mailProblem: mail.ready ? "" : mail.detail,
  });
});
// The Super Admin adds an admin (temporary password shown once) or changes an admin's name / registered email.
// The email is also the sign-in ID. Checked on the server; recorded in the audit log.
app.post("/api/admin/accounts", adminGuard, superAdminGuard, async (req, res) => {
  try {
    const out = await auth.addAdmin({
      name: req.body?.name,
      email: req.body?.email,
    });
    if (!out.ok)
      return res
        .status(out.status || 400)
        .json({ error: out.error, field: out.field });
    audit(req.adminEmail, "admin_account_added", {
      target: out.account.email,
      name: out.account.name,
    });
    res.set("Cache-Control", "no-store");
    res.status(201).json({
      ok: true,
      password: out.password,
      loginId: out.account.login_id,
      email: out.account.email,
      name: out.account.name,
      admins: adminsWithHelp(),
    });
  } catch (err) {
    console.error("Add admin failed:", err.message);
    res.status(500).json({ error: "Could not add the admin. Please try again." });
  }
});
app.patch(
  "/api/admin/accounts/:loginId",
  adminGuard,
  superAdminGuard,
  (req, res) => {
    try {
      const out = auth.updateAdminDetails(req.params.loginId, {
        name: req.body?.name,
        email: req.body?.email,
      });
      if (!out.ok)
        return res
          .status(out.status || 400)
          .json({ error: out.error, field: out.field });
      if (out.changes.length)
        audit(req.adminEmail, "admin_account_updated", {
          target: out.account.email,
          changes: out.changes,
          ...(out.changes.includes("email") ? { previousEmail: out.previousEmail } : {}),
        });
      res.json({
        ok: true,
        changes: out.changes,
        account: auth.publicAccount(out.account),
        admins: adminsWithHelp(),
      });
    } catch (err) {
      console.error("Edit admin failed:", err.message);
      res.status(500).json({ error: "Could not save the changes. Please try again." });
    }
  },
);
// The Super Admin gives another admin a temporary password (shown once). The admin must choose their own password
// at the next sign-in. Works without email, for example after a Forgot password request.
app.post(
  "/api/admin/accounts/:loginId/temporary-password",
  adminGuard,
  superAdminGuard,
  async (req, res) => {
    try {
      const out = await passwordHelp.issueTemporaryPassword({
        loginId: req.params.loginId,
        actorAccountId: req.account.id,
        actorEmail: req.adminEmail,
      });
      if (!out.ok)
        return res.status(out.status || 400).json({ error: out.error });
      res.set("Cache-Control", "no-store");
      res.json({
        ok: true,
        password: out.password,
        loginId: out.loginId,
        email: out.email,
        name: out.name,
        admins: adminsWithHelp(),
      });
    } catch (err) {
      console.error("Temporary password failed:", err.message);
      res
        .status(500)
        .json({ error: "Could not set a temporary password. Please try again." });
    }
  },
);
app.post(
  "/api/admin/accounts/:loginId/send-reset",
  adminGuard,
  superAdminGuard,
  resetRequestLimiter,
  async (req, res) => {
    try {
      const target = auth.adminByLoginId(req.params.loginId);
      if (!target)
        return res
          .status(404)
          .json({ error: "That admin account was not found." });
      const mail = await mailStatus();
      if (!mail.ready)
        return res.status(503).json({
          error: mail.detail + " You can use Temporary password instead.",
        });
      const out = await passwordResets.requestResetForAdmin({
        account: target,
        actorEmail: req.adminEmail,
        baseUrl: baseUrlOf(req),
      });
      if (!out.ok)
        return res.status(out.status || 400).json({ error: out.error });
      res.json({
        ok: true,
        message: `A password reset link was sent to ${out.sentTo}. It works once and expires in 30 minutes.`,
      });
    } catch (err) {
      console.error("Admin reset link failed:", err.message);
      res
        .status(500)
        .json({ error: "Could not send the reset link. Please try again." });
    }
  },
);
app.post(
  "/api/admin/accounts/:loginId/status",
  adminGuard,
  superAdminGuard,
  (req, res) => {
    const status = String(req.body?.status || "");
    const out = auth.setAdminStatus(req.params.loginId, status, req.account.id);
    if (!out.ok)
      return res.status(out.status || 400).json({ error: out.error });
    audit(
      req.adminEmail,
      status === "disabled"
        ? "admin_account_disabled"
        : "admin_account_enabled",
      { target: out.account.email || out.account.login_id },
    );
    res.json({ ok: true, admins: adminsWithHelp() });
  },
);

import {
  cleanInput,
  typeOf,
  recordFields,
  validatePublicApplication,
  isValidPin,
  isValidDateOfBirth,
  isValidYears,
  categoryForYears,
} from "./partner-application.js";
const PARTNER_STATUSES = [
  "New",
  "Contacted",
  "Under Review",
  "Documents Pending",
  "Accepted",
  "Rejected",
];
const PARTNER_DECISIONS = ["Accepted", "Rejected"];
// Older versions called "Accepted" "Approved"; treat both the same.
function normalizeStatus(v) {
  const s = String(v ?? "").trim();
  return s === "Approved" ? "Accepted" : s;
}
// One-time upgrade of records saved with the old "Approved" status.
for (const r of db
  .prepare(
    "SELECT id,payload FROM partner_applications WHERE status='Approved'",
  )
  .all()) {
  const p = JSON.parse(r.payload);
  p.status = "Accepted";
  db.prepare(
    "UPDATE partner_applications SET status=?,payload=? WHERE id=?",
  ).run("Accepted", JSON.stringify(p), r.id);
}
// Fields an application may contain (website form + admin "New application"). Anything else is ignored.
// Application field rules (allowed fields, validation, record mapping) live in partner-application.js.
const PARTNER_EDITABLE = [
  "name",
  "contact",
  "mobile",
  "whatsapp",
  "email",
  "state",
  "district",
  "city",
  "pincode",
  "street",
  "locality",
  "nearby",
  "landmark",
  "address",
  "education",
  "remarks",
  "status",
  "dateOfBirth",
  "whatsappNumber",
  "locationArea",
  "yearsOfExperience",
];
// Admin edits also update the applicant's own field names, so the View form and the table always agree.
const PARTNER_ALIAS = {
  name: "fullName",
  mobile: "contactNumber",
  whatsapp: "whatsappNumber",
  email: "gmail",
  city: "cityOrVillage",
  locality: "locationArea",
};
function partnerPrefix(type) {
  return String(type || "").toLowerCase() === "vendor" ? "VN" : "FP";
}
// Application IDs count up per type: VN-000001, VN-000002 ... for vendors and FP-000001, FP-000002 ... for
// franchises. Every ID is given out only once: the counter is stored and never goes back (an ID freed by a
// type change is not reused), and any number that is already taken is skipped.
db.exec(
  "CREATE TABLE IF NOT EXISTS id_counters(prefix TEXT PRIMARY KEY,last INTEGER NOT NULL)",
);
const nextApplicationId = db.transaction((type) => {
  const prefix = partnerPrefix(type),
    taken = db.prepare("SELECT 1 FROM partner_applications WHERE app_id=?");
  let n =
      db.prepare("SELECT last FROM id_counters WHERE prefix=?").get(prefix)
        ?.last || 0,
    id;
  do {
    n++;
    id = `${prefix}-${String(n).padStart(6, "0")}`;
  } while (taken.get(id) || auth.accountByLogin(id));
  db.prepare(
    "INSERT INTO id_counters(prefix,last) VALUES(?,?) ON CONFLICT(prefix) DO UPDATE SET last=excluded.last",
  ).run(prefix, n);
  return id;
});
// ---------- Partner portal logins ----------
const portalPathFor = (app) =>
  String(app.type).toLowerCase() === "vendor" ? "/vendor/" : "/franchise/";
const publicBase = (req) =>
  (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(
    /\/+$/,
    "",
  );
// ---------- Emails to applicants (partner-emails.js has the wording) ----------
// Sent when a website application is submitted, approved or rejected, and when an admin issues a new partner password.
// Never throws: the result {sent, to, reason} is shown to the admin and kept in the application's email history.
const EMAIL_OK = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
async function emailApplicant(app, message) {
  const to = String(app.email || "").trim();
  if (!EMAIL_OK.test(to))
    return { sent: false, to: "", reason: "The application has no valid email address." };
  const status = await mailStatus();
  if (!status.ready)
    return {
      sent: false,
      to,
      reason:
        status.problem === "not_configured"
          ? "Email sending is not set up yet (backend/.env)."
          : "Email could not be sent: the email settings or connection are not working (see the server window).",
    };
  const mail = getMailTransporter();
  try {
    await mail.transporter.sendMail({
      from: { name: "ON THE WAY LOGISTICS", address: mail.user },
      replyTo: SUPPORT_EMAIL,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { sent: true, to, reason: "" };
  } catch (e) {
    console.error("Applicant email failed:", e.message);
    mailCheck.at = 0; // check the email settings again next time
    return { sent: false, to, reason: "The email could not be sent. Share the details another way." };
  }
}
// Adds one entry to the application's email history (kept in its saved record, newest 20). Returns the record.
function recordApplicantEmail(id, kind, result, actor = "") {
  const row = db.prepare("SELECT payload FROM partner_applications WHERE id=?").get(id);
  if (!row) return null;
  const p = JSON.parse(row.payload);
  p.emailLog = [
    ...(Array.isArray(p.emailLog) ? p.emailLog : []),
    {
      kind,
      at: new Date().toISOString(),
      to: result.to || "",
      sent: !!result.sent,
      reason: result.sent ? "" : result.reason || "",
    },
  ].slice(-20);
  db.prepare("UPDATE partner_applications SET payload=? WHERE id=?").run(JSON.stringify(p), id);
  audit(actor || p.email || "", "applicant_email_" + kind, {
    appId: p.appId,
    sent: !!result.sent,
  });
  return p;
}
let warnedLocalPortalLink = false;
const loginFor = (req, app, loginId, password = "") => {
  const portalUrl = publicBase(req) + portalPathFor(app);
  if (
    !process.env.PUBLIC_URL &&
    !warnedLocalPortalLink &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(portalUrl)
  ) {
    warnedLocalPortalLink = true;
    console.warn(
      `Partner login emails link to ${portalUrl}, which only works on this computer. Set PUBLIC_URL in backend/.env to your website address (or this computer's network address, e.g. http://192.168.1.20:8080).`,
    );
  }
  return { portalUrl, loginId, password };
};
const NOT_NOTIFIED = { sent: false, to: "", reason: "you chose not to email the applicant." };
// What the admin sees once, right after a login is created or its password is reset.
function credentialsFor(req, app, login, email) {
  return {
    loginId: login.loginId,
    password: login.password,
    portalUrl: login.portalUrl,
    portal:
      String(app.type).toLowerCase() === "vendor"
        ? "Vendor Portal"
        : "Franchise Portal",
    name: app.name,
    phone: app.whatsapp || app.mobile || "",
    email,
  };
}
// Approve / reject emails for a decision. Returns {email, credentials, loginReenabled, application}.
async function decisionFollowUp(req, app, decision, { note = "", notify = true } = {}) {
  let email = null,
    credentials = null,
    loginReenabled = false;
  if (decision === "Accepted") {
    const r = await auth.ensurePartnerAccount(app);
    const login = loginFor(req, app, r.account.login_id, r.password || "");
    email = notify
      ? await emailApplicant(app, approvedEmail(app, { login, note, supportEmail: SUPPORT_EMAIL }))
      : NOT_NOTIFIED;
    if (r.password) credentials = credentialsFor(req, app, login, email);
    else loginReenabled = true;
  } else if (decision === "Rejected") {
    auth.disablePartnerAccount(app.id);
    email = notify
      ? await emailApplicant(app, rejectedEmail(app, { note, supportEmail: SUPPORT_EMAIL }))
      : NOT_NOTIFIED;
  }
  const saved = email
    ? recordApplicantEmail(app.id, decision === "Accepted" ? "approved" : "rejected", email, req.adminEmail) || app
    : app;
  return { email, credentials, loginReenabled, application: saved };
}
const withLogin = (app) => ({
  ...app,
  portalLogin: auth.publicAccount(auth.accountForApplication(app.id)),
});
const applicationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Too many applications from this connection. Please try again later.",
  },
});
const partnerApplicationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 7, fields: 80 },
}).fields([
  { name: "aadhaarCard", maxCount: 1 },
  { name: "salarySlips", maxCount: 6 },
]);
function sniffPartnerFile(buffer) {
  if (!buffer || !buffer.length) return "";
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (buffer.length > 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return "";
}
// Applicant identity documents are encrypted at rest with AES-256-GCM. The key is kept
// outside the public website; deployments should preserve backend/uploads and back it up securely.
const partnerDocumentKeyPath = path.join(UPLOAD_DIR, ".partner-document-key");
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
let partnerDocumentKey;
if (process.env.PARTNER_DOCUMENT_ENCRYPTION_KEY) {
  partnerDocumentKey = Buffer.from(process.env.PARTNER_DOCUMENT_ENCRYPTION_KEY, "base64");
  if (partnerDocumentKey.length !== 32) throw new Error("PARTNER_DOCUMENT_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
} else {
  try { partnerDocumentKey = fs.readFileSync(partnerDocumentKeyPath); }
  catch { partnerDocumentKey = crypto.randomBytes(32); fs.writeFileSync(partnerDocumentKeyPath, partnerDocumentKey, { flag: "wx", mode: 0o600 }); }
  if (partnerDocumentKey.length !== 32) throw new Error("Invalid partner document encryption key file.");
}
function encryptPartnerDocument(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", partnerDocumentKey, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("OTW1"), iv, cipher.getAuthTag(), encrypted]);
}
function decryptPartnerDocument(stored) {
  if (stored.length < 32 || stored.subarray(0, 4).toString("ascii") !== "OTW1") throw new Error("Encrypted document format is invalid.");
  const iv = stored.subarray(4, 16), tag = stored.subarray(16, 32), body = stored.subarray(32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", partnerDocumentKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
app.post("/api/partner-applications", applicationLimiter, (req, res, next) => partnerApplicationUpload(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Each document must be 5 MB or smaller." : err.message || "Invalid document upload." });
  next();
}), (req, res) => {
  const storedPaths = [];
  try {
    const input = cleanInput(req.body);
    const type = typeOf(input.type || input.portalType);
    // Entries made in the dashboard are sent as JSON; the public forms always send multipart form data. An admin
    // who is signed in and tests the public form therefore still gets the visitor rules and the notification.
    const createdBy = req.is("application/json") ? adminEmailOf(req) : "";
    const submissionKey = String(req.body?.submissionKey || "").trim();
    if (submissionKey && !/^[A-Za-z0-9-]{16,80}$/.test(submissionKey))
      return res.status(400).json({ error: "Invalid submission key." });
    if (submissionKey) {
      const existing = findApplicationByKey(submissionKey);
      if (existing) return res.status(200).json({ ok: true, duplicate: true, application: existing });
    }
    // Website visitors must complete the required fields; entries made in the admin panel keep the looser rule.
    if (createdBy && !isValidYears(input.yearsOfExperience))
      return res.status(400).json({ error: "Years of Experience must be a whole number from 0 to 10." });
    if (!createdBy) {
      // The Applicant Category is always derived from Years of Experience (0 = Fresher, 1 to 10 = Experienced),
      // so the saved category can never disagree with the years the applicant entered.
      input.applicantCategory = categoryForYears(input.yearsOfExperience);
      const errors = validatePublicApplication(input, type);
      if (errors.length)
        return res.status(400).json({ error: errors.join(" "), errors });
      const category = String(input.applicantCategory || "");
      if (!["Fresher", "Experienced"].includes(category)) return res.status(400).json({ error: "Please select Fresher or Experienced." });
      const aadhaar = req.files?.aadhaarCard?.[0];
      if (!aadhaar) return res.status(400).json({ error: "Please upload your Aadhaar Card." });
      if (category === "Experienced") {
        const months = Number(input.salarySlipMonths);
        const slips = req.files?.salarySlips || [];
        if (![3, 6].includes(months)) return res.status(400).json({ error: "Select 3-month or 6-month salary slips." });
        if (slips.length !== months) return res.status(400).json({ error: `Upload exactly ${months} salary slip files.` });
      }
    }
    const fields = recordFields(input, type);
    if (!fields.name)
      return res.status(400).json({ error: "Applicant name is required" });
    const appId = nextApplicationId(type),
      id = crypto.randomUUID(),
      submittedAt = new Date().toISOString();
    const documents = [];
    if (!createdBy) {
      const aadhaar = req.files?.aadhaarCard?.[0];
      const salarySlips = req.files?.salarySlips || [];
      const incoming = [...(aadhaar ? [{ file: aadhaar, kind: "Aadhaar Card" }] : []), ...salarySlips.map((file, index) => ({ file, kind: `Salary Slip ${index + 1}` }))];
      for (const item of incoming) {
        const mime = sniffPartnerFile(item.file.buffer);
        if (!mime) {
          for (const saved of storedPaths) try { fs.unlinkSync(saved); } catch {}
          return res.status(400).json({ error: "Documents must be valid PDF, JPG or PNG files." });
        }
      }
      const docDir = path.join(UPLOAD_DIR, "partner-applications", id);
      fs.mkdirSync(docDir, { recursive: true, mode: 0o700 });
      for (const item of incoming) {
        const mime = sniffPartnerFile(item.file.buffer);
        const docId = crypto.randomUUID();
        const storedName = docId + ".enc";
        const target = path.join(docDir, storedName);
        fs.writeFileSync(target, encryptPartnerDocument(item.file.buffer), { flag: "wx", mode: 0o600 });
        storedPaths.push(target);
        documents.push({ id: docId, type: item.kind, name: path.basename(item.file.originalname || item.kind).slice(0, 120), mime, size: item.file.size, storedName });
      }
    }
    const status =
      createdBy && PARTNER_STATUSES.includes(normalizeStatus(input.status))
        ? normalizeStatus(input.status)
        : "New";
    const payload = {
      ...input,
      type,
      ...fields,
      documents,
      id,
      appId,
      status,
      submittedAt,
      source: createdBy ? "Admin panel" : "Website",
    };
    if (createdBy) payload.createdBy = createdBy;
    let adminNote = null;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO partner_applications(id,app_id,type,name,contact,mobile,whatsapp,email,state,district,city,pincode,address,education,remarks,status,payload,submitted_at,submission_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        appId,
        type,
        payload.name,
        payload.contact,
        payload.mobile,
        payload.whatsapp,
        payload.email,
        payload.state,
        payload.district,
        payload.city,
        payload.pincode,
        payload.address,
        payload.education,
        payload.remarks,
        status,
        JSON.stringify(payload),
        submittedAt,
        createdBy ? null : submissionKey || null,
      );
      // Website submissions only: the admin is notified about applications the public sends in.
      if (!createdBy) adminNote = adminNotifications.create({ applicationId: id, dashboardBase: publicBase(req) });
    })();
    if (createdBy)
      audit(createdBy, "partner_application_created", { appId, type });
    const willEmail =
      !createdBy && EMAIL_OK.test(String(payload.email || "").trim()) && !!getMailTransporter() && mailCheck.ready === true;
    const responseApplication = { ...payload, documents: documents.map(({ storedName, ...doc }) => doc) };
    res.status(201).json({ ok: true, application: responseApplication, confirmationEmail: willEmail });
    if (adminNote?.created) {
      broadcastAdminNotification({ id: adminNote.id, applicationId: id, appId, type, name: payload.name });
      adminNotifications.sendEmail(adminNote.id, { actor: "system" }).catch((e) => console.error("Admin email:", e.message));
    }
    // "Application submitted" email to the applicant, sent after the answer so the website never waits for it.
    if (!createdBy)
      emailApplicant(payload, submittedEmail(payload, { supportEmail: SUPPORT_EMAIL }))
        .then((r) => recordApplicantEmail(id, "submitted", r))
        .catch((e) => console.error("Submission email:", e.message));
  } catch (err) {
    for (const saved of storedPaths) try { fs.unlinkSync(saved); } catch {}
    const key = String(req.body?.submissionKey || "").trim();
    if (key && /UNIQUE/.test(String(err?.message || "")) && findApplicationByKey(key))
      return res.status(200).json({ ok: true, duplicate: true, application: findApplicationByKey(key) });
    console.error("Partner application save:", err);
    res.status(500).json({ error: "Could not save application" });
  }
});
// Admin-only document download. Files live outside every public/static directory.
app.get("/api/partner-applications/:id/documents/:docId", adminGuard, (req, res) => {
  try {
    const row = db.prepare("SELECT payload FROM partner_applications WHERE id=?").get(String(req.params.id));
    if (!row) return res.status(404).json({ error: "Application not found." });
    const appRecord = JSON.parse(row.payload);
    const doc = (appRecord.documents || []).find((d) => d.id === req.params.docId);
    if (!doc || !/^[a-f0-9-]{36}\.enc$/.test(doc.storedName || "")) return res.status(404).json({ error: "Document not found." });
    const filePath = path.join(UPLOAD_DIR, "partner-applications", String(req.params.id), doc.storedName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Stored document is missing." });
    const plaintext = decryptPartnerDocument(fs.readFileSync(filePath));
    audit(adminEmailOf(req), "partner_document_downloaded", { appId: appRecord.appId, documentType: doc.type });
    res.setHeader("Content-Type", doc.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${String(doc.name || "document").replace(/[\\"\r\n]/g, "_")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(plaintext);
  } catch (err) { res.status(500).json({ error: "Could not retrieve document." }); }
});
// Admin edits (status, contact details...) are saved on the server so every admin sees them
// and the next refresh does not undo them. The applicant's original form answers are kept.
app.patch("/api/partner-applications/:id", adminGuard, async (req, res) => {
  try {
    const row = db
      .prepare("SELECT payload FROM partner_applications WHERE id=?")
      .get(String(req.params.id));
    if (!row) return res.status(404).json({ error: "Application not found" });
    const current = JSON.parse(row.payload),
      input = req.body || {},
      changes = {};
    for (const k of PARTNER_EDITABLE)
      if (input[k] !== undefined)
        changes[k] = String(input[k] ?? "").slice(0, 2000);
    if (changes.status !== undefined)
      changes.status = normalizeStatus(changes.status);
    if (
      changes.status !== undefined &&
      !PARTNER_STATUSES.includes(changes.status)
    )
      return res.status(400).json({ error: "Invalid status" });
    if (changes.name !== undefined && !changes.name.trim())
      return res.status(400).json({ error: "Applicant name is required" });
    if (changes.pincode && !isValidPin(changes.pincode))
      return res
        .status(400)
        .json({ error: "PIN Code must be a 6-digit number." });
    if (changes.dateOfBirth && !isValidDateOfBirth(changes.dateOfBirth))
      return res
        .status(400)
        .json({ error: "Date of Birth is not a valid past date." });
    if (changes.yearsOfExperience !== undefined && !isValidYears(changes.yearsOfExperience))
      return res
        .status(400)
        .json({
          error: "Years of Experience must be a whole number from 0 to 10.",
        });
    const synced = {};
    for (const [from, to] of Object.entries(PARTNER_ALIAS))
      if (changes[from] !== undefined) synced[to] = changes[from];
    const next = {
      ...current,
      ...changes,
      ...synced,
      updatedAt: new Date().toISOString(),
      updatedBy: req.adminEmail,
    };
    if (changes.status !== undefined && changes.status !== current.status) {
      if (PARTNER_DECISIONS.includes(changes.status)) {
        next.decidedBy = req.adminEmail;
        next.decidedAt = next.updatedAt;
      } else {
        delete next.decidedBy;
        delete next.decidedAt;
        delete next.decisionNote;
      }
    }
    if (input.type !== undefined) {
      const t =
        String(input.type).toLowerCase() === "vendor" ? "Vendor" : "Franchise";
      if (t !== current.type) {
        next.type = t;
        next.appId = nextApplicationId(t);
        next.previousAppId = current.appId;
      }
    }
    db.prepare(
      "UPDATE partner_applications SET app_id=?,type=?,name=?,contact=?,mobile=?,whatsapp=?,email=?,state=?,district=?,city=?,pincode=?,address=?,education=?,remarks=?,status=?,payload=? WHERE id=?",
    ).run(
      next.appId,
      next.type,
      next.name,
      next.contact || "",
      next.mobile || "",
      next.whatsapp || "",
      next.email || "",
      next.state || "",
      next.district || "",
      next.city || "",
      next.pincode || "",
      next.address || "",
      next.education || "",
      next.remarks || "",
      next.status || "New",
      JSON.stringify(next),
      current.id,
    );
    audit(req.adminEmail, "partner_application_updated", {
      appId: next.appId,
      changes: Object.keys(changes),
    });
    // Accepting through Edit creates the portal login too; moving away from Accepted switches it off.
    // A change to Accepted or Rejected emails the applicant, as the Approve / Reject buttons do.
    let credentials = null,
      applicantEmail = null,
      saved = next;
    const statusChanged = next.status !== current.status;
    if (next.status === "Accepted" && statusChanged) {
      const out = await decisionFollowUp(req, next, "Accepted", { notify: input.notify !== false });
      credentials = out.credentials;
      applicantEmail = out.email;
      saved = out.application;
    } else if (next.status === "Accepted") {
      const r = await auth.ensurePartnerAccount(next);
      if (r.password) {
        const login = loginFor(req, next, r.account.login_id, r.password);
        applicantEmail = await emailApplicant(next, approvedEmail(next, { login, supportEmail: SUPPORT_EMAIL }));
        credentials = credentialsFor(req, next, login, applicantEmail);
        saved = recordApplicantEmail(next.id, "approved", applicantEmail, req.adminEmail) || next;
      }
    } else if (next.status === "Rejected" && statusChanged) {
      const out = await decisionFollowUp(req, next, "Rejected", { notify: input.notify !== false });
      applicantEmail = out.email;
      saved = out.application;
    } else if (current.status === "Accepted")
      auth.disablePartnerAccount(next.id);
    else auth.syncPartnerAccount(next);
    res.json({ ok: true, application: withLogin(saved), credentials, applicantEmail });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update application" });
  }
});
// Accept / Reject an application. Records the decision, an optional note, which admin decided and when.
// decision "Pending" undoes a decision (back to "Under Review").
app.post(
  "/api/partner-applications/:id/decision",
  adminGuard,
  async (req, res) => {
    try {
      const decision = normalizeStatus(req.body?.decision);
      if (![...PARTNER_DECISIONS, "Pending"].includes(decision))
        return res
          .status(400)
          .json({ error: "Decision must be Accepted, Rejected or Pending" });
      const row = db
        .prepare("SELECT payload FROM partner_applications WHERE id=?")
        .get(String(req.params.id));
      if (!row) return res.status(404).json({ error: "Application not found" });
      const current = JSON.parse(row.payload),
        now = new Date().toISOString();
      const next = { ...current, updatedAt: now, updatedBy: req.adminEmail };
      if (decision === "Pending") {
        next.status = "Under Review";
        delete next.decidedBy;
        delete next.decidedAt;
        delete next.decisionNote;
      } else {
        next.status = decision;
        next.decidedBy = req.adminEmail;
        next.decidedAt = now;
        next.decisionNote = String(req.body?.note || "")
          .trim()
          .slice(0, 1000);
      }
      db.prepare(
        "UPDATE partner_applications SET status=?,payload=? WHERE id=?",
      ).run(next.status, JSON.stringify(next), current.id);
      audit(
        req.adminEmail,
        "partner_application_" +
          (decision === "Pending" ? "decision_undone" : decision.toLowerCase()),
        { appId: next.appId, note: next.decisionNote || "" },
      );
      // Accepted -> the applicant gets a portal login (new ones get a temporary password, shown once) and an
      // "approved" email. Rejected -> their login is switched off and they get a "rejected" email. The admin can
      // choose not to email ({notify:false}). Undo -> the login is switched off; no email.
      let credentials = null,
        loginReenabled = false,
        applicantEmail = null,
        saved = next;
      if (decision === "Accepted" || decision === "Rejected") {
        const out = await decisionFollowUp(req, next, decision, {
          note: next.decisionNote || "",
          notify: req.body?.notify !== false,
        });
        ({ credentials, loginReenabled } = out);
        applicantEmail = out.email;
        saved = out.application;
      } else auth.disablePartnerAccount(next.id);
      res.json({
        ok: true,
        application: withLogin(saved),
        credentials,
        loginReenabled,
        applicantEmail,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not save decision" });
    }
  },
);
// ---------- Ban / unban a partner's portal login (the application status does not change) ----------
const banTime = (iso) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
// What a banned partner sees when they try to sign in.
function banMessage(ban, role) {
  const portal = role === "vendor" ? "Vendor Portal" : "Franchise Portal";
  return (
    `Your ${portal} access has been suspended by On The Way Logistics ${ban.until ? "until " + banTime(ban.until) : "until further notice"}.` +
    (ban.reason ? ` Reason: ${ban.reason}.` : "") +
    " Please contact On The Way Logistics."
  ).replace(/\.\./g, ".");
}
function recordBan(id, entry) {
  const row = db.prepare("SELECT payload FROM partner_applications WHERE id=?").get(id);
  if (!row) return null;
  const p = JSON.parse(row.payload);
  p.banLog = [...(Array.isArray(p.banLog) ? p.banLog : []), { ...entry, at: new Date().toISOString() }].slice(-50);
  db.prepare("UPDATE partner_applications SET payload=? WHERE id=?").run(JSON.stringify(p), id);
  return p;
}
app.post("/api/partner-applications/:id/ban", adminGuard, (req, res) => {
  try {
    const id = String(req.params.id);
    if (!db.prepare("SELECT 1 FROM partner_applications WHERE id=?").get(id))
      return res.status(404).json({ error: "Application not found" });
    const out = auth.banPartner(id, {
      until: req.body?.until || "",
      reason: req.body?.reason || "",
      actor: req.adminEmail,
    });
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
    const saved = recordBan(id, {
      action: "banned",
      by: req.adminEmail,
      until: out.ban.until,
      reason: out.ban.reason,
    });
    audit(req.adminEmail, "partner_banned", {
      appId: saved?.appId,
      loginId: out.account.login_id,
      until: out.ban.until || "until unbanned",
      reason: out.ban.reason,
    });
    res.json({ ok: true, application: withLogin(saved), message: banMessage(out.ban, out.account.role) });
  } catch (err) {
    console.error("Ban failed:", err.message);
    res.status(500).json({ error: "Could not ban the login. Please try again." });
  }
});
app.post("/api/partner-applications/:id/unban", adminGuard, (req, res) => {
  try {
    const id = String(req.params.id);
    if (!db.prepare("SELECT 1 FROM partner_applications WHERE id=?").get(id))
      return res.status(404).json({ error: "Application not found" });
    const out = auth.unbanPartner(id);
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
    const saved = recordBan(id, { action: "unbanned", by: req.adminEmail });
    audit(req.adminEmail, "partner_unbanned", { appId: saved?.appId, loginId: out.account.login_id });
    res.json({ ok: true, application: withLogin(saved) });
  } catch (err) {
    console.error("Unban failed:", err.message);
    res.status(500).json({ error: "Could not unban the login. Please try again." });
  }
});
// Create a login for an accepted application that has none yet, or issue a new temporary password.
app.post(
  "/api/partner-applications/:id/portal-login",
  adminGuard,
  async (req, res) => {
    try {
      const row = db
        .prepare("SELECT payload FROM partner_applications WHERE id=?")
        .get(String(req.params.id));
      if (!row) return res.status(404).json({ error: "Application not found" });
      const app = JSON.parse(row.payload);
      if (app.status !== "Accepted")
        return res
          .status(400)
          .json({
            error: "Accept the application before creating a portal login.",
          });
      const r = await auth.ensurePartnerAccount(app, { reset: true });
      audit(
        req.adminEmail,
        r.created ? "partner_login_created" : "partner_password_reset",
        { appId: app.appId, loginId: r.account.login_id },
      );
      const login = loginFor(req, app, r.account.login_id, r.password);
      const email = await emailApplicant(
        app,
        r.created
          ? approvedEmail(app, { login, supportEmail: SUPPORT_EMAIL })
          : newPasswordEmail(app, { login, supportEmail: SUPPORT_EMAIL }),
      );
      const saved = recordApplicantEmail(app.id, r.created ? "login_created" : "new_password", email, req.adminEmail) || app;
      res.json({
        ok: true,
        application: withLogin(saved),
        credentials: credentialsFor(req, app, login, email),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not create the login" });
    }
  },
);
app.get("/api/partner-applications", adminGuard, (req, res) => {
  try {
    const rows = db
        .prepare(
          "SELECT payload FROM partner_applications ORDER BY submitted_at DESC",
        )
        .all(),
      logins = auth.accountsByApplication();
    res.json(
      rows.map((r) => {
        const a = JSON.parse(r.payload);
        return { ...a, documents: (a.documents || []).map(({ storedName, ...doc }) => doc), portalLogin: logins.get(a.id) || null };
      }),
    );
  } catch (err) {
    res.status(500).json({ error: "Could not load applications" });
  }
});
// ---------- Admin notifications for new website applications (admin-notifications.js) ----------
function findApplicationByKey(key) {
  const row = db.prepare("SELECT payload FROM partner_applications WHERE submission_key=?").get(key);
  if (!row) return null;
  const a = JSON.parse(row.payload);
  return { ...a, documents: (a.documents || []).map(({ storedName, ...doc }) => doc) };
}
const adminNotifications = createAdminNotifications({
  db,
  transport: { sendMail: (message) => sendSupportMail(message) },
  recipients: () => supportAdminRecipients(),
  audit: (actor, action, details) => audit(actor, action, details),
  log: console,
});
// Open dashboards connected through the notification stream (one per browser tab).
const adminStreams = new Set();
function broadcastAdminNotification(data) {
  const chunk = `event: notification\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of adminStreams) {
    try {
      client.res.write(chunk);
    } catch {
      adminStreams.delete(client);
    }
  }
}
app.get("/api/admin/notifications", adminGuard, (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(
      adminNotifications.list(req.account.id, {
        type: String(req.query.type || ""),
        status: String(req.query.status || ""),
      }),
    );
  } catch (err) {
    console.error("Notifications list:", err);
    res.status(500).json({ error: "Could not load notifications" });
  }
});
// Real-time: the dashboard keeps this connection open. A new application is pushed at once; if the admin is
// offline the notification is simply waiting in the database and shows up at the next sign-in.
app.get("/api/admin/notifications/stream", adminGuard, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const client = { res, accountId: req.account.id };
  adminStreams.add(client);
  res.write(`event: ready\ndata: ${JSON.stringify({ unreadCount: adminNotifications.unreadCount(req.account.id) })}\n\n`);
  const heartbeat = setInterval(() => {
    // Stop streaming as soon as the admin's session has ended.
    if (!auth.getSession(req, "admin")) {
      cleanup();
      return res.end();
    }
    res.write(": ping\n\n");
  }, 25_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    adminStreams.delete(client);
  };
  req.on("close", cleanup);
});
function notificationAction(read) {
  return (req, res) => {
    const ok = adminNotifications.setRead(req.account.id, String(req.params.id), read);
    if (!ok) return res.status(404).json({ error: "Notification not found." });
    res.json({ ok: true, unreadCount: adminNotifications.unreadCount(req.account.id) });
  };
}
app.post("/api/admin/notifications/:id/read", adminGuard, notificationAction(true));
app.post("/api/admin/notifications/:id/unread", adminGuard, notificationAction(false));
app.post("/api/admin/notifications/:id/delete", adminGuard, (req, res) => {
  const ok = adminNotifications.remove(req.account.id, String(req.params.id));
  if (!ok) return res.status(404).json({ error: "Notification not found." });
  res.json({ ok: true, unreadCount: adminNotifications.unreadCount(req.account.id) });
});
app.post("/api/admin/notifications/:id/resend-email", adminGuard, async (req, res) => {
  const id = String(req.params.id);
  if (!adminNotifications.exists(id, req.account.id)) return res.status(404).json({ error: "Notification not found." });
  const result = await adminNotifications.sendEmail(id, { actor: req.adminEmail });
  res.json({ ok: !!result?.sent, emailStatus: adminNotifications.emailStatusOf(id) });
});
// Retry worker for admin emails that failed (pending or failed, due, under the attempt limit).
setTimeout(() => adminNotifications.processDue().catch((e) => console.error("Admin email retry:", e.message)), 10_000).unref?.();
setInterval(() => adminNotifications.processDue().catch((e) => console.error("Admin email retry:", e.message)), 60_000).unref?.();

// ---------- Vendor / Franchise portal data (each partner sees only their own) ----------
const portalGuard = (req, res, next) => {
  const portal = portalOf(req.query.portal);
  if (portal !== "vendor" && portal !== "franchise")
    return res.status(400).json({ error: "Unknown portal." });
  return auth.requireRole(portal)(req, res, next);
};
function initialPortalData(account, app) {
  return {
    id: account.login_id,
    name: app.companyName || app.businessName || app.name || account.name || "",
    contact: app.contact || app.name || "",
    phone: app.mobile || app.whatsapp || "",
    email: app.email || "",
    state: app.state || "",
    district: app.district || "",
    city: app.city || "",
    pin: app.pincode || "",
    office: "",
    address: app.address || app.fullAddress || "",
    remarks: app.remarks || "",
    locations: [], // partners add their own locations (each one needs a map link)
    riders: [],
    orderRecords: [],
    orders: 0,
    applications: [],
  };
}
app.get("/api/portal/data", portalGuard, (req, res) => {
  const account = req.account;
  const row = db
    .prepare("SELECT data FROM portal_data WHERE account_id=?")
    .get(account.id);
  const appRow =
    account.application_id &&
    db
      .prepare("SELECT payload FROM partner_applications WHERE id=?")
      .get(account.application_id);
  const application = appRow ? JSON.parse(appRow.payload) : {};
  let data = row
    ? JSON.parse(row.data)
    : initialPortalData(account, application);
  data.id = account.login_id;
  res.json({
    ok: true,
    account: auth.publicAccount(account),
    data,
    application: {
      appId: application.appId || "",
      status: application.status || "",
      decidedAt: application.decidedAt || "",
    },
  });
});
// Admin-uploaded weekly / 15-day payments. The account id and approved Rider Registration
// ownership are taken from the authenticated session; a franchise cannot request another rider.
app.get("/api/portal/weekly-payments", portalGuard, (req, res) => {
  // Franchise and vendor accounts each see only the approved riders they registered (matched by Rider ID).
  if (req.account.role !== "franchise" && req.account.role !== "vendor")
    return res.status(403).json({ error: "Partner access required." });
  try {
    // Vendors and franchises get the Reports figures, built from the same rows as their Orders page (partner-reports.js).
    const week =
      typeof req.query.week === "string" ? req.query.week.slice(0, 64) : "";
    const { records, report } = partnerPortalPayload(
      db,
      req.account.role,
      req.account.id,
      week,
    );
    res.set("Cache-Control", "private, no-store");
    res.json({ ok: true, records, report });
  } catch (err) {
    console.error("Could not load partner weekly payments:", err.message);
    res.status(500).json({ error: "Could not load payment history." });
  }
});
app.put("/api/portal/data", portalGuard, (req, res) => {
  const data = req.body?.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return res.status(400).json({ error: "Nothing to save." });
  for (const k of ["locations", "riders", "orderRecords"])
    if (data[k] !== undefined && !Array.isArray(data[k]))
      return res.status(400).json({ error: "Invalid " + k + "." });
  data.id = req.account.login_id; // partners cannot change their own ID
  // Orders come from the admin's payment imports; a portal save (possibly from an older open page) must not change them.
  const stored = db
    .prepare("SELECT data FROM portal_data WHERE account_id=?")
    .get(req.account.id);
  data.orderRecords = stored ? JSON.parse(stored.data).orderRecords || [] : [];
  const json = JSON.stringify(data);
  if (json.length > 900_000)
    return res
      .status(413)
      .json({ error: "Too much data to save. Try a smaller profile photo." });
  db.prepare(
    "INSERT INTO portal_data(account_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
  ).run(req.account.id, json, new Date().toISOString());
  removeUnusedFiles(req.account.id, data);
  res.json({ ok: true });
});
// ---------- Rider documents (screenshot, Aadhaar) ----------
// Files are kept in backend/uploads/<account>/ (never in a public folder) and only the partner who
// uploaded them can open them. Each upload is checked to really be an image (or a PDF for Aadhaar).
db.exec(
  "CREATE TABLE IF NOT EXISTS portal_files(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,original_name TEXT,mime TEXT NOT NULL,size INTEGER NOT NULL,stored_name TEXT NOT NULL,created_at TEXT NOT NULL)",
);
const FILE_KINDS = {
  screenshot: ["image/jpeg", "image/png", "image/webp"],
  aadhaar: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
};
const FILE_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};
// Decide the type from the file's first bytes, not from its name or what the browser claims.
function sniffType(b) {
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
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, fieldSize: 200 },
});
const fileRow = (id, accountId) =>
  db
    .prepare("SELECT * FROM portal_files WHERE id=? AND account_id=?")
    .get(String(id), accountId);
function deleteStoredFile(row) {
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, row.account_id, row.stored_name));
  } catch (e) {}
  db.prepare("DELETE FROM portal_files WHERE id=?").run(row.id);
}
// Files no longer used by any rider are removed (a short grace period covers uploads still being saved).
function removeUnusedFiles(accountId, data) {
  const used = new Set();
  for (const r of Array.isArray(data?.riders) ? data.riders : [])
    for (const k of ["screenshotFile", "aadhaarFile"])
      if (r && r[k] && r[k].id) used.add(String(r[k].id));
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  for (const row of db
    .prepare("SELECT * FROM portal_files WHERE account_id=? AND created_at<?")
    .all(accountId, cutoff))
    if (!used.has(row.id)) deleteStoredFile(row);
}
app.post("/api/portal/files", portalGuard, (req, res) => {
  fileUpload.single("file")(req, res, async (err) => {
    if (err)
      return res
        .status(400)
        .json({
          error:
            err.code === "LIMIT_FILE_SIZE"
              ? "The file is too large. Please upload a file under 5 MB."
              : "Could not read the file. Please try another one.",
        });
    try {
      const kind = String(req.body?.kind || ""),
        allowed = FILE_KINDS[kind];
      if (!allowed)
        return res.status(400).json({ error: "Unknown document type." });
      const f = req.file;
      if (!f || !f.size)
        return res.status(400).json({ error: "Choose a file to upload." });
      const type = sniffType(f.buffer);
      if (!allowed.includes(type))
        return res
          .status(400)
          .json({
            error:
              kind === "aadhaar"
                ? "Aadhaar must be a JPG, PNG or WEBP image, or a PDF."
                : "The screenshot must be a JPG, PNG or WEBP image.",
          });
      if (
        db
          .prepare("SELECT COUNT(*) AS n FROM portal_files WHERE account_id=?")
          .get(req.account.id).n >= 500
      )
        return res
          .status(400)
          .json({ error: "This account has reached its upload limit." });
      const id = crypto.randomUUID(),
        stored = id + FILE_EXT[type],
        dir = path.join(UPLOAD_DIR, req.account.id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, stored), f.buffer, { mode: 0o600 });
      const name =
        path
          .basename(String(f.originalname || ""))
          .replace(/[^\w.\- ()]/g, "_")
          .slice(0, 100) || kind + FILE_EXT[type];
      db.prepare(
        "INSERT INTO portal_files(id,account_id,kind,original_name,mime,size,stored_name,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id,
        req.account.id,
        kind,
        name,
        type,
        f.size,
        stored,
        new Date().toISOString(),
      );
      // Screenshots of the delivery app: read the Partner ID and name so the form can fill them in.
      const read =
        kind === "screenshot" ? await readRiderScreenshot(f.buffer) : undefined;
      res
        .status(201)
        .json({ ok: true, file: { id, kind, name, type, size: f.size }, read });
    } catch (e) {
      console.error("Upload failed:", e.message);
      res
        .status(500)
        .json({ error: "Could not save the file. Please try again." });
    }
  });
});
// Rider Applications forms (Admin, Vendor, Franchise portals): read the Rider ID / Partner ID and name from a
// delivery-app screenshot so the form can fill them in. The image is read in memory and is not stored by this route
// (the form uploads it with the application). Text recognition runs on this server.
const screenshotReadLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many screenshots were read. Please wait a few minutes." },
});
app.post(
  "/api/read-rider-screenshot",
  screenshotReadLimiter,
  (req, res, next) => {
    const portal = portalOf(req.query.portal);
    if (!["admin", "vendor", "franchise"].includes(portal))
      return res.status(400).json({ error: "Unknown portal." });
    return auth.requireRole(portal)(req, res, next);
  },
  (req, res) => {
    fileUpload.single("file")(req, res, async (err) => {
      if (err)
        return res.status(400).json({
          error:
            err.code === "LIMIT_FILE_SIZE"
              ? "The file is too large. Please upload a file under 5 MB."
              : "Could not read the file. Please try another one.",
        });
      const f = req.file;
      if (!f || !f.size)
        return res.status(400).json({ error: "Choose a screenshot to read." });
      if (!["image/jpeg", "image/png", "image/webp"].includes(sniffType(f.buffer)))
        return res
          .status(400)
          .json({ error: "The screenshot must be a JPG, PNG or WEBP image." });
      const read = await readRiderScreenshot(f.buffer);
      res.json({
        ok: true,
        read: { partnerId: read.partnerId || "", name: read.name || "" },
      });
    });
  },
);
app.get("/api/portal/files/:id", portalGuard, (req, res) => {
  const row = fileRow(req.params.id, req.account.id);
  if (!row) return res.status(404).json({ error: "File not found." });
  res.set({
    "Content-Type": row.mime,
    "Content-Disposition": `inline; filename="${row.original_name.replace(/["\\]/g, "")}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.sendFile(
    path.join(UPLOAD_DIR, row.account_id, row.stored_name),
    (err) => {
      if (err && !res.headersSent)
        res.status(404).json({ error: "File not found." });
    },
  );
});
app.delete("/api/portal/files/:id", portalGuard, (req, res) => {
  const row = fileRow(req.params.id, req.account.id);
  if (row) deleteStoredFile(row);
  res.json({ ok: true });
});
// ---------- Payment data → vendor / franchise portals ----------
// When an admin imports the payment Excel, each row is matched to the partner whose Riders list has that rider
// (by Rider ID / Partner ID, otherwise by name when only one partner has a rider with that name). Matched rows
// fill that partner's Orders page and the partner gets a notification. Nothing is shared with other partners.
db.exec(`CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,meta TEXT,created_at TEXT NOT NULL,read_at TEXT);
CREATE INDEX IF NOT EXISTS notifications_account ON notifications(account_id,created_at);`);
const normRiderId = (v) =>
  String(v ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
const normRiderName = (v) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim();
const fmtDay = (iso) => {
  const d = new Date(iso + "T12:00:00");
  return isNaN(d)
    ? iso
    : d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
};
function addNotification(accountId, kind, title, body, meta) {
  db.prepare(
    "INSERT INTO notifications(id,account_id,kind,title,body,meta,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    crypto.randomUUID(),
    accountId,
    kind,
    title,
    body,
    JSON.stringify(meta || {}),
    new Date().toISOString(),
  );
  // keep the newest 200 per partner
  db.prepare(
    "DELETE FROM notifications WHERE account_id=? AND id NOT IN (SELECT id FROM notifications WHERE account_id=? ORDER BY created_at DESC LIMIT 200)",
  ).run(accountId, accountId);
}
// Versioned Excel payment imports (see payment-imports.js for the matching rules).
const paymentImports = createPaymentImportService({ db, audit });
// Writes one imported version into the partners' Orders pages, inside the same transaction as the import:
// each vendor / franchise gets only the rows matched to its own riders. Earlier orders from payment imports
// are replaced, so the latest file is the active data source. Partner-entered records are kept.
function projectPaymentVersion(versionId, matched, fileName) {
  const now = new Date().toISOString();
  const partners = db
    .prepare(
      "SELECT a.id,a.login_id,a.name,a.role,p.data FROM accounts a JOIN portal_data p ON p.account_id=a.id WHERE a.role IN ('vendor','franchise') AND a.status='active'",
    )
    .all()
    .map((r) => ({ ...r, data: JSON.parse(r.data) }));
  const byOwner = new Map();
  for (const m of matched) {
    if (!byOwner.has(m.ownerAccountId)) byOwner.set(m.ownerAccountId, []);
    byOwner.get(m.ownerAccountId).push(m);
  }
  const saveData = db.prepare(
    "UPDATE portal_data SET data=?,updated_at=? WHERE account_id=?",
  );
  const shared = [];
  for (const p of partners) {
    const mine = byOwner.get(p.id) || [];
    const previous = Array.isArray(p.data.orderRecords)
      ? p.data.orderRecords
      : [];
    const kept = previous.filter((o) => o.source !== "payment-import");
    if (!mine.length && previous.length === kept.length) continue; // nothing to add and nothing to remove
    const fresh = mine.map((m) => ({
      riderId: m.riderId,
      riderName: m.riderName,
      date: m.date,
      total: m.lm + m.primary + m.club,
      prime: m.primary,
      club: m.club,
      large: m.lm,
      sdd: m.sdd,
      amount: m.amount,
      sddPayment: m.sddAmount,
      source: "payment-import",
      fileName,
      versionId,
      importedAt: now,
    }));
    const orders = [...kept, ...fresh].sort(
      (a, b) =>
        String(b.date).localeCompare(String(a.date)) ||
        String(a.riderName).localeCompare(String(b.riderName)),
    );
    p.data.orderRecords = orders;
    saveData.run(JSON.stringify(p.data), now, p.id);
    if (mine.length) {
      const dates = mine.map((m) => m.date).sort(),
        riders = new Set(mine.map((m) => m.riderId));
      const range =
        dates[0] === dates[dates.length - 1]
          ? fmtDay(dates[0])
          : `${fmtDay(dates[0])} – ${fmtDay(dates[dates.length - 1])}`;
      const total = mine.reduce((n, m) => n + m.lm, 0);
      addNotification(
        p.id,
        "payment",
        "Payment data updated",
        `On The Way Logistics uploaded payment data for ${riders.size} of your riders: ${mine.length} daily record${mine.length === 1 ? "" : "s"} (${range}), ${total} orders in total. Open Orders to see the details.`,
        {
          fileName,
          versionId,
          riders: riders.size,
          records: mine.length,
          from: dates[0],
          to: dates[dates.length - 1],
        },
      );
    }
    shared.push({
      loginId: p.login_id,
      name: p.name,
      role: p.role,
      riders: new Set(mine.map((m) => m.riderId)).size,
      records: mine.length,
    });
  }
  return shared;
}
app.post("/api/admin/payment-import", adminGuard, (req, res) => {
  try {
    const fileName =
      oneLine(req.body?.fileName).slice(0, 120) || "payment file";
    let shared = [];
    const out = paymentImports.importRows(
      { fileName, fileHash: req.body?.fileHash, records: req.body?.records },
      req.adminEmail || "",
      (versionId, matched) => {
        shared = projectPaymentVersion(versionId, matched, fileName);
      },
    );
    if (out.alreadyImported)
      return res.json({
        ok: true,
        alreadyImported: true,
        version: out.version,
        activeVersionId: out.activeVersionId,
        shared: [],
        flagged: [],
      });
    // Rows an admin must look at: name mismatches and riders not found in the registrations.
    const flagged = paymentImports
      .rowsOf({ versionId: out.activeVersionId })
      .rows.filter((r) => r.status === "review" || r.status === "unmatched")
      .map((r) => ({
        status: r.status,
        riderId: r.riderId,
        riderName: r.riderName,
        date: r.date,
        note: r.note,
      }))
      .slice(0, 500);
    audit(req.adminEmail, "payment_import_shared", {
      fileName,
      versionId: out.activeVersionId,
      partners: shared.map((x) => x.loginId),
      matched: out.version.matched,
      review: out.version.review,
      unmatched: out.version.unmatched,
    });
    res.json({
      ok: true,
      alreadyImported: false,
      version: out.version,
      activeVersionId: out.activeVersionId,
      skipped: out.skipped,
      duplicates: out.duplicates,
      shared,
      flagged,
      unmatchedCount: out.version.unmatched,
      reviewCount: out.version.review,
      noPartnerCount: out.version.noPartner,
    });
  } catch (err) {
    if (err instanceof PaymentImportError)
      return res.status(err.status).json({ error: err.message });
    console.error("Payment import failed:", err);
    res
      .status(500)
      .json({
        error:
          "The Excel file could not be imported. The previous payment data is unchanged. Please try again.",
      });
  }
});
// Version history (every imported file is kept) and the rows of one version. Admin sign-in only.
app.get("/api/admin/payment-imports", adminGuard, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, ...paymentImports.listVersions() });
});
app.get("/api/admin/payment-imports/rows", adminGuard, (req, res) => {
  try {
    const status = ["matched", "review", "unmatched", "no_partner"].includes(
      req.query.status,
    )
      ? req.query.status
      : undefined;
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      ...paymentImports.rowsOf({
        versionId: req.query.version ? String(req.query.version) : undefined,
        status,
      }),
    });
  } catch (err) {
    console.error("Could not read payment rows:", err);
    res.status(500).json({ error: "Could not load the payment rows." });
  }
});
// Partner notifications
app.get("/api/portal/notifications", portalGuard, (req, res) => {
  const items = db
    .prepare(
      "SELECT id,kind,title,body,created_at,read_at FROM notifications WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
    )
    .all(req.account.id)
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      createdAt: n.created_at,
      read: !!n.read_at,
    }));
  res.json({ ok: true, items, unread: items.filter((n) => !n.read).length });
});
app.post("/api/portal/notifications/read", portalGuard, (req, res) => {
  const t = new Date().toISOString();
  if (req.body?.id)
    db.prepare(
      "UPDATE notifications SET read_at=? WHERE id=? AND account_id=? AND read_at IS NULL",
    ).run(t, String(req.body.id), req.account.id);
  else
    db.prepare(
      "UPDATE notifications SET read_at=? WHERE account_id=? AND read_at IS NULL",
    ).run(t, req.account.id);
  res.json({ ok: true });
});
// Admin Reports: totals, 15-day / 365-day periods and rider-week rows. The source is the saved weekly payment rows
// (weekly_payments), the same rows the Payments page shows, so an Excel import updates both at once.
// Partner rider lists are read only to find each rider's hub. Admin sign-in only.
app.get("/api/admin/reports", adminGuard, (req, res) => {
  try {
    const partners = db
      .prepare(
        "SELECT p.data FROM accounts a JOIN portal_data p ON p.account_id=a.id WHERE a.role IN ('vendor','franchise') AND a.status='active'",
      )
      .all();
    const datas = partners.map((r) => {
      try {
        return JSON.parse(r.data);
      } catch (e) {
        return {};
      }
    });
    const weekly = db
      .prepare(
        "SELECT id,rider_id,rider_name,week_label,week_start,week_end,days,total_orders,lm,primary_orders,club,sdd,lm_amount,prime_amount,club_amount,sdd_amount,amount,payment_status FROM weekly_payments",
      )
      .all();
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      ...buildReport(
        req.query,
        recordsFromWeeklyRows(weekly, hubMapOf(datas)),
        today,
      ),
    });
  } catch (err) {
    if (err instanceof ReportError)
      return res.status(err.status).json({ error: err.message });
    console.error("Report error:", err.message);
    res
      .status(500)
      .json({ error: "Could not build the report. Please try again." });
  }
});
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    gateway: "Razorpay",
    mode: process.env.RAZORPAY_KEY_ID?.startsWith("rzp_test_")
      ? "sandbox"
      : "live",
  }),
);
app.get("/api/payments/history", adminGuard, (req, res) =>
  res.json(
    db
      .prepare("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 1000")
      .all(),
  ),
);
app.get("/api/autopay", adminGuard, (req, res) =>
  res.json(
    db
      .prepare("SELECT * FROM subscriptions ORDER BY next_payment_at ASC")
      .all(),
  ),
);
app.post("/api/autopay/create", adminGuard, async (req, res) => {
  try {
    const { payerName, payerEmail, payerType, amount, frequency, consent } =
      req.body || {};
    if (!payerName || !amount || !frequency || !consent)
      return res
        .status(400)
        .json({
          error:
            "Payer name, amount, frequency and explicit consent are required",
        });
    const planId = planFor(frequency);
    if (!planId)
      return res
        .status(400)
        .json({ error: `Razorpay ${frequency} plan is not configured` });
    const payload = {
      plan_id: planId,
      total_count: 120,
      customer_notify: 1,
      notes: {
        payer_name: String(payerName),
        payer_type: String(payerType || "Customer"),
      },
    };
    const sub = await razor("/subscriptions", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO subscriptions(id,payer_name,payer_email,payer_type,amount,frequency,status,gateway,gateway_subscription_id,consent_at,created_at,next_payment_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      crypto.randomUUID(),
      payerName,
      payerEmail || "",
      payerType || "Customer",
      Number(amount),
      frequency,
      "Pending Authorization",
      "razorpay",
      sub.id,
      now,
      now,
      null,
    );
    audit(req.adminEmail, "autopay_created", {
      gateway_subscription_id: sub.id,
      payer: payerName,
      frequency,
      amount,
    });
    res.json({
      id: sub.id,
      status: sub.status || "created",
      short_url: sub.short_url || null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
app.post("/api/autopay/:id/pause", adminGuard, async (req, res) => {
  try {
    const out = await razor(
      `/subscriptions/${encodeURIComponent(req.params.id)}/pause`,
      { method: "POST", body: JSON.stringify({ pause_at: "now" }) },
    );
    db.prepare(
      "UPDATE subscriptions SET status=? WHERE gateway_subscription_id=?",
    ).run("Paused", req.params.id);
    audit(req.adminEmail, "autopay_paused", { id: req.params.id });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
app.post("/api/autopay/:id/resume", adminGuard, async (req, res) => {
  try {
    const out = await razor(
      `/subscriptions/${encodeURIComponent(req.params.id)}/resume`,
      { method: "POST", body: JSON.stringify({ resume_at: "now" }) },
    );
    db.prepare(
      "UPDATE subscriptions SET status=? WHERE gateway_subscription_id=?",
    ).run("Active", req.params.id);
    audit(req.adminEmail, "autopay_resumed", { id: req.params.id });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
app.post("/api/autopay/:id/cancel", adminGuard, async (req, res) => {
  try {
    const out = await razor(
      `/subscriptions/${encodeURIComponent(req.params.id)}/cancel`,
      { method: "POST", body: JSON.stringify({ cancel_at_cycle_end: 0 }) },
    );
    db.prepare(
      "UPDATE subscriptions SET status=? WHERE gateway_subscription_id=?",
    ).run("Cancelled", req.params.id);
    audit(req.adminEmail, "autopay_cancelled", { id: req.params.id });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ===================== Helpline / Support (Vendor, Franchise and Admin) =====================
// Tickets are stored in the database (support-tickets.js) and handled by the routes in support-routes.js.
// Email is sent with the Gmail account in .env (GMAIL_USER + GMAIL_APP_PASSWORD), or SMTP_* if those are set.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "supportontheway@gmail.com";
// The Vendor / Franchise portals show this address, so the address shown is always the one that receives the messages.
app.get("/api/support-info", (req, res) => res.json({ ok: true, email: SUPPORT_EMAIL }));
let mailTransporter = null;
function getMailTransporter() {
  // Optional: another mail provider via SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS.
  if (process.env.SMTP_HOST) {
    const user =
      process.env.SMTP_USER || process.env.GMAIL_USER || SUPPORT_EMAIL;
    if (!mailTransporter)
      mailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === "true",
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
        auth: process.env.SMTP_PASS
          ? { user, pass: process.env.SMTP_PASS }
          : undefined,
      });
    return { transporter: mailTransporter, user };
  }
  const user = process.env.GMAIL_USER || SUPPORT_EMAIL,
    pass = String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!pass || pass.startsWith("replace_")) return null;
  if (!mailTransporter)
    mailTransporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user, pass },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  return { transporter: mailTransporter, user };
}
const oneLine = (v) =>
  String(v || "")
    .replace(/[\r\n]+/g, " ")
    .trim();
// Admin copy of every support notification: ADMIN_EMAIL when set, otherwise every active admin account's email.
// ADMIN_EMAIL may list several addresses separated by commas.
function supportAdminRecipients() {
  if (process.env.ADMIN_EMAIL)
    return [...new Set(String(process.env.ADMIN_EMAIL).split(",").map((a) => a.trim()).filter(Boolean))];
  return db
    .prepare(
      "SELECT email FROM accounts WHERE role='admin' AND status='active' AND email IS NOT NULL AND email<>''",
    )
    .all()
    .map((r) => String(r.email).trim())
    .filter(Boolean);
}
// Gmail API (OAuth 2.0) when GMAIL_OAUTH_* is configured; otherwise SMTP with the App Password.
// The Gmail API sends as the authorised support account. Errors are returned as text, never with secrets.
const gmailConfig = gmailConfigFrom(process.env);
const gmailApi = createGmailApi({ config: gmailConfig, log: console });
function smtpProblem() {
  const pass = String(process.env.GMAIL_APP_PASSWORD || "").trim();
  if (!pass) return "GMAIL_APP_PASSWORD is empty in backend/.env";
  if (/^replace[_ ]|^your[_ ]/i.test(pass))
    return "GMAIL_APP_PASSWORD still has the template value in backend/.env. Replace it with a Gmail App Password, or connect the Gmail API (GMAIL_OAUTH_*).";
  return "";
}
async function sendSupportMail(message) {
  if (gmailApi.configured()) return gmailApi.sendMail(message);
  const problem = smtpProblem();
  if (!getMailTransporter()) throw new Error(`Email is not configured: ${problem || "set GMAIL_APP_PASSWORD or GMAIL_OAUTH_* in backend/.env"}`);
  const mail = getMailTransporter();
  return mail.transporter.sendMail({
    from: { name: "ON THE WAY LOGISTICS Support", address: mail.user },
    ...message,
  });
}
console.log(
  gmailApi.configured()
    ? "[support-email] sending through the Gmail API (OAuth 2.0)"
    : `[support-email] Gmail API not connected; using SMTP. ${smtpProblem() || "SMTP password found."}`,
);
const supportService = createSupportService({ db, uploadDir: UPLOAD_DIR });
// Every support email is queued in the database and sent by the outbox worker, with retries (support-mail.js).
const supportMailer = createSupportMailer({
  db,
  uploadDir: UPLOAD_DIR,
  transport: { sendMail: (m) => sendSupportMail(m) },
});
// Incoming customer email through the Gmail API (support-inbound.js). Off until GMAIL_OAUTH_* is set.
const supportInbound = createGmailInbound({
  db,
  api: gmailApi,
  service: supportService,
  mailer: supportMailer,
  adminRecipients: supportAdminRecipients,
  supportEmail: SUPPORT_EMAIL,
  baseUrl: process.env.PUBLIC_URL || "",
});
registerSupportRoutes(app, {
  auth,
  service: supportService,
  mailer: supportMailer,
  inbound: supportInbound,
  supportEmail: SUPPORT_EMAIL,
  adminRecipients: supportAdminRecipients,
  baseUrl: process.env.PUBLIC_URL || "",
});
// Retry and send due emails every 30 seconds. Check the support inbox every minute when it is connected.
{
  const emailTimer = setInterval(() => supportMailer.runDue().catch((e) => console.error("[support-email]", e.message)), 30_000);
  emailTimer.unref?.();
  supportMailer.runDue().catch(() => {});
  supportInbound.start(60_000);
}

// ---------- Rider member registrations (Admin, Vendor and Franchise portals; each partner sees only its own) ----------
// Stored in the same database; documents are kept in backend/uploads/registrations (never public).
const riderRegistrations = createRiderRegistrationService({
  db,
  uploadDir: UPLOAD_DIR,
  audit,
});
registerRiderRegistrationRoutes(app, {
  auth,
  service: riderRegistrations,
  onApproved: (actor) => weeklyPaymentService.recheckPending(actor),
});

// ---------- Hub Management (Admin Portal only) ----------
// Hubs are stored in the `hubs` table. On the first start the 100 existing hubs are loaded once from data/hubs-seed.json.
const hubService = createHubService({
  db,
  audit,
  seedRows: JSON.parse(
    fs.readFileSync(path.join(__dirname, "data", "hubs-seed.json"), "utf8"),
  ),
});
registerHubRoutes(app, { guard: adminGuard, service: hubService });
// ---------- Franchise & Vendor locations (partner submits, admin approves) ----------
// Stored in the `partner_locations` table. Partners see only their own rows; only admins approve, edit or delete.
// Approved locations become hubs in the `hubs` table (see hubs.js createFromLocation).
// Approving a location creates its hub in Hub List (hubService), in the same database transaction.
const locationService = createLocationService({ db, audit, hubService });
registerLocationRoutes(app, {
  partnerGuard: auth.requireRole("vendor", "franchise"),
  adminGuard,
  service: locationService,
});
// ---------- Rider documents (Admin Portal > Documents) ----------
// Files are kept privately in backend/uploads/admin-documents/ and opened only with an admin session.
registerAdminDocumentRoutes(app, {
  guard: adminGuard,
  service: createAdminDocumentService({ db, uploadDir: UPLOAD_DIR, audit }),
});
// After weekly rows are saved, each vendor / franchise whose approved riders received new or changed rows gets a
// notification. Uses the same rules as their Orders page (listForVendor / listForFranchise in weekly-payments.js).
function notifyPartnersOfWeeklyRows({ importId, fileName }) {
  const groups = partnerGroupsForImport(db, importId);
  for (const g of groups) {
    const range = !g.fromDay
      ? ""
      : g.fromDay === g.toDay
        ? ` (${fmtDay(g.fromDay)})`
        : ` (${fmtDay(g.fromDay)} – ${fmtDay(g.toDay)})`;
    addNotification(
      g.accountId,
      "payment",
      "Payment data updated",
      `On The Way Logistics uploaded payment data for ${g.riders} of your rider${g.riders === 1 ? "" : "s"}: ${g.records} weekly record${g.records === 1 ? "" : "s"}${range}, ${g.orders} orders in total. Open Orders to see the details.`,
      { fileName, importId, riders: g.riders, records: g.records },
    );
  }
}
const weeklyPaymentService = createWeeklyPaymentService({
  db,
  audit,
  riderRegistry: true,
  onSaved: notifyPartnersOfWeeklyRows,
});
registerWeeklyPaymentRoutes(app, {
  guard: adminGuard,
  service: weeklyPaymentService,
});

// ---------- Google Drive payment sync (Admin Portal > Payments > Google Drive) ----------
// Files in the chosen Drive folder go through the same Excel reader as a manual upload (dashboard/payment-excel.js)
// and the same save rules (weekly-payments.js). Setup: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and DRIVE_TOKEN_SECRET
// in backend/.env (see .env.example). Without them the Payments page shows that Drive is not set up.
const requireCjs = createRequire(import.meta.url);
const XLSX = requireCjs("xlsx");
const PaymentExcel = requireCjs("../dashboard/payment-excel.js");
const driveSync = createDriveSyncService({
  db,
  weeklyPayments: weeklyPaymentService,
  audit,
  parseWorkbook: (buf) =>
    PaymentExcel.parseSheets(
      PaymentExcel.sheetsFromWorkbook(XLSX, XLSX.read(buf, { type: "buffer" })),
    ),
});
registerDriveSyncRoutes(app, {
  guard: adminGuard,
  service: driveSync,
  baseUrlOf: (req) =>
    String(process.env.PUBLIC_URL || "").replace(/\/+$/, "") ||
    `${req.protocol}://${req.get("host")}`,
});
driveSync.schedule(process.env.DRIVE_SYNC_MINUTES);
app.use("/vendor", express.static(path.join(__dirname, "..", "vendor-portal")));
app.use(
  "/franchise",
  express.static(path.join(__dirname, "..", "franchise-portal")),
);
app.use("/dashboard", express.static(path.join(__dirname, "..", "dashboard")));
app.use(express.static(path.join(__dirname, "..", "website")));
// Last stop for errors: a short JSON message, never a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error("Server error:", err.message);
  res
    .status(status)
    .json({
      error:
        err.type === "entity.parse.failed"
          ? "The request was not valid."
          : err.type === "entity.too.large"
            ? "The request is too large."
            : status >= 500
              ? "Something went wrong on the server."
              : "The request could not be completed.",
    });
});
app.listen(PORT, (err) => {
  if (err) {
    // Without this the window said "running" while the browser was really talking to another copy (and its database).
    if (err.code === "EADDRINUSE")
      console.error(
        `\n  NOT STARTED: port ${PORT} is already in use. Another copy of this server is still running,` +
          `\n  maybe from an older project folder. Your browser is talking to THAT copy and its database,` +
          `\n  so sign-ins and data will not match this folder.` +
          `\n  Close the other server window (or restart the computer), then run START-WINDOWS.bat again.\n`,
      );
    else console.error(`\n  NOT STARTED: ${err.message}\n`);
    process.exit(1);
  }
  console.log(`On The Way Logistics (Version 12 · 15 Nov 2026) running on http://localhost:${PORT}`);
  console.log(`  Database:      ${path.join(__dirname, "payments.sqlite")}`);
  // Tell the owner straight away whether Forgot password / support emails can be sent.
  mailStatus().then((m) =>
    console.log(
      (m.ready ? "  Email: " : "  Email NOT working: ") +
        m.detail +
        (m.ready
          ? ""
          : " Until then, Forgot password requests go to the Super Admin (Settings > Admin Accounts > Temporary password)."),
    ),
  );
  console.log(`  Website:       http://localhost:${PORT}/`);
  console.log(`  Admin panel:   http://localhost:${PORT}/dashboard/`);
  console.log(`  Vendor portal: http://localhost:${PORT}/vendor/`);
  console.log(`  Franchise portal: http://localhost:${PORT}/franchise/`);
});
