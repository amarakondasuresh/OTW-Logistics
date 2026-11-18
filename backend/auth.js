// Accounts, passwords and sign-in sessions for the admin panel and the vendor / franchise portals.
//
// - Passwords are stored only as salted scrypt hashes, never in plain text.
// - A session is a random token kept in an HttpOnly cookie; the database stores only its SHA-256 hash.
// - Each area has its own cookie, so an admin, a vendor and a franchise partner can be signed in
//   from the same browser without interfering with each other.
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
export const ROLES = ["admin", "vendor", "franchise"];
const COOKIE = {
  admin: "otw_admin_session",
  vendor: "otw_vendor_session",
  franchise: "otw_franchise_session",
};
const SHORT_SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours
const LONG_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days ("Remember me" and partner portals)
const TEMP_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // no 0/O, 1/l/I

export function createAuth(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY, role TEXT NOT NULL, login_id TEXT NOT NULL UNIQUE, email TEXT, name TEXT,
      password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active', application_id TEXT UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT, password_changed_at TEXT);
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, role TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT);
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
    CREATE TABLE IF NOT EXISTS portal_data(account_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS password_resets(
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT);
    CREATE INDEX IF NOT EXISTS password_resets_account ON password_resets(account_id);
  `);
  // Older databases have no admin_role column. Adding it changes nobody's access: every admin keeps the
  // permissions they had; 'super_admin' only unlocks the Admin Accounts section (see ensureSuperAdmin below).
  if (
    !db
      .prepare("PRAGMA table_info(accounts)")
      .all()
      .some((c) => c.name === "admin_role")
  ) {
    db.exec("ALTER TABLE accounts ADD COLUMN admin_role TEXT");
  }
  // Partner bans (Admin > Client > Ban): columns added to older databases; nobody is banned by the upgrade.
  {
    const cols = db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
    for (const col of ["banned_at", "banned_until", "ban_reason", "banned_by"])
      if (!cols.includes(col)) db.exec(`ALTER TABLE accounts ADD COLUMN ${col} TEXT`);
  }

  const now = () => new Date().toISOString();
  const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

  // ---------- passwords ----------
  async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(String(password), salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
    });
    return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
  }
  async function verifyPassword(password, stored) {
    try {
      const [kind, N, r, p, saltB64, hashB64] = String(stored || "").split("$");
      if (kind !== "scrypt") return false;
      const expected = Buffer.from(hashB64, "base64");
      const actual = await scrypt(
        String(password),
        Buffer.from(saltB64, "base64"),
        expected.length,
        { N: Number(N), r: Number(r), p: Number(p) },
      );
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  function passwordProblem(password) {
    const p = String(password || "");
    if (p.length < 8) return "Use at least 8 characters.";
    if (p.length > 128) return "Use at most 128 characters.";
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p))
      return "Use both letters and numbers.";
    return "";
  }
  function tempPassword() {
    const pick = () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
    const group = () => Array.from({ length: 4 }, pick).join("");
    // Always contains letters and digits so it passes passwordProblem().
    let pw;
    do {
      pw = `${group()}-${group()}-${group()}`;
    } while (passwordProblem(pw));
    return pw;
  }

  // ---------- accounts ----------
  const q = {
    byId: db.prepare("SELECT * FROM accounts WHERE id=?"),
    byLogin: db.prepare("SELECT * FROM accounts WHERE login_id=?"),
    byEmailRole: db.prepare(
      "SELECT * FROM accounts WHERE lower(email)=? AND role=?",
    ),
    byApplication: db.prepare("SELECT * FROM accounts WHERE application_id=?"),
    adminByEmailOrLogin: db.prepare(
      `SELECT * FROM accounts WHERE role='admin' AND (lower(trim(email))=? OR lower(trim(login_id))=?)`,
    ),
    insert:
      db.prepare(`INSERT INTO accounts(id,role,login_id,email,name,password_hash,must_change_password,status,application_id,created_at,updated_at)
                        VALUES(@id,@role,@login_id,@email,@name,@password_hash,@must_change_password,@status,@application_id,@created_at,@updated_at)`),
  };
  // The current ban of a vendor / franchise login, or null. A ban with an end time stops by itself at that time;
  // without one it lasts until an admin unbans the partner.
  function banInfo(a) {
    if (!a || !a.banned_at || (a.role !== "vendor" && a.role !== "franchise")) return null;
    if (a.banned_until && a.banned_until <= now()) return null;
    return {
      since: a.banned_at,
      until: a.banned_until || "",
      reason: a.ban_reason || "",
      by: a.banned_by || "",
    };
  }
  function publicAccount(a) {
    if (!a) return null;
    return {
      ban: banInfo(a),
      loginId: a.login_id,
      role: a.role,
      name: a.name || "",
      email: a.email || "",
      status: a.status,
      mustChangePassword: !!a.must_change_password,
      lastLoginAt: a.last_login_at || null,
      createdAt: a.created_at,
      isSuperAdmin: a.role === "admin" && a.admin_role === "super_admin",
    };
  }
  // Partners type IDs in many ways ("vn-2", "VN000002", old "FR-000001"); normalise to the stored form.
  function normaliseLoginId(role, loginId) {
    const raw = String(loginId || "").trim();
    if (role === "admin" || raw.includes("@")) return raw.toLowerCase();
    const m = raw
      .toUpperCase()
      .replace(/\s+/g, "")
      .match(/^(VN|FP|FR)-?0*(\d{1,6})$/);
    if (!m) return raw.toUpperCase();
    const prefix = m[1] === "FR" ? "FP" : m[1];
    return `${prefix}-${m[2].padStart(6, "0")}`;
  }
  function findForLogin(role, loginId) {
    const id = normaliseLoginId(role, loginId);
    if (!id) return { account: null };
    if (role !== "admin" && id.includes("@")) {
      const rows = q.byEmailRole.all(id, role);
      if (rows.length > 1) return { account: null, ambiguous: true };
      return { account: rows[0] || null };
    }
    const a = q.byLogin.get(id);
    return { account: a && a.role === role ? a : null };
  }
  // All accounts an ID / email could mean (one for IDs; several partners may share an email).
  function findCandidates(role, loginId) {
    const id = normaliseLoginId(role, loginId);
    if (!id) return [];
    // Admin: the registered email, ignoring capitals and stray spaces (phones often add them).
    if (role === "admin") return q.adminByEmailOrLogin.all(id, id);
    if (id.includes("@")) return q.byEmailRole.all(id, role);
    const a = q.byLogin.get(id);
    return a && a.role === role ? [a] : [];
  }
  async function createAccount({
    role,
    loginId,
    email = "",
    name = "",
    password,
    mustChange = true,
    applicationId = null,
  }) {
    const t = now();
    const row = {
      id: crypto.randomUUID(),
      role,
      login_id: normaliseLoginId(role, loginId),
      email,
      name,
      password_hash: await hashPassword(password),
      must_change_password: mustChange ? 1 : 0,
      status: "active",
      application_id: applicationId,
      created_at: t,
      updated_at: t,
    };
    q.insert.run(row);
    return q.byId.get(row.id);
  }
  async function setPassword(accountId, password, { mustChange }) {
    const t = now();
    db.prepare(
      "UPDATE accounts SET password_hash=?,must_change_password=?,password_changed_at=?,updated_at=? WHERE id=?",
    ).run(await hashPassword(password), mustChange ? 1 : 0, t, t, accountId);
  }

  // ---------- sessions ----------
  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) {
        try {
          out[part.slice(0, i).trim()] = decodeURIComponent(
            part.slice(i + 1).trim(),
          );
        } catch {
          /* ignore a malformed cookie */
        }
      }
    }
    return out;
  }
  function cookieHeader(req, name, value, maxAgeMs) {
    const secure = req.secure || process.env.COOKIE_SECURE === "true";
    let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
    if (secure) c += "; Secure";
    if (maxAgeMs === 0) c += "; Max-Age=0";
    else if (maxAgeMs) c += `; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
    return c;
  }
  function startSession(req, res, account, { remember = false } = {}) {
    const token = crypto.randomBytes(32).toString("base64url");
    const life =
      account.role === "admin" && !remember
        ? SHORT_SESSION_MS
        : LONG_SESSION_MS;
    const t = now();
    db.prepare(
      "INSERT INTO sessions(token_hash,account_id,role,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)",
    ).run(
      sha256(token),
      account.id,
      account.role,
      t,
      new Date(Date.now() + life).toISOString(),
      t,
    );
    db.prepare("UPDATE accounts SET last_login_at=? WHERE id=?").run(
      t,
      account.id,
    );
    // Admin without "Remember me": browser-session cookie (cleared when the browser closes).
    res.append(
      "Set-Cookie",
      cookieHeader(
        req,
        COOKIE[account.role],
        token,
        account.role === "admin" && !remember ? null : life,
      ),
    );
  }
  function getSession(req, role) {
    const token = parseCookies(req)[COOKIE[role]];
    if (!token) return null;
    const s = db
      .prepare("SELECT * FROM sessions WHERE token_hash=?")
      .get(sha256(token));
    if (!s || s.role !== role || s.expires_at < now()) return null;
    const account = q.byId.get(s.account_id);
    if (!account || account.status !== "active" || account.role !== role)
      return null;
    if (banInfo(account)) return null; // banned: signed out everywhere
    return { account, tokenHash: s.token_hash };
  }
  function endSession(req, res, role) {
    const token = parseCookies(req)[COOKIE[role]];
    if (token)
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(token));
    res.append("Set-Cookie", cookieHeader(req, COOKIE[role], "", 0));
  }
  function endAllSessions(accountId, exceptTokenHash = null) {
    if (exceptTokenHash)
      db.prepare(
        "DELETE FROM sessions WHERE account_id=? AND token_hash<>?",
      ).run(accountId, exceptTokenHash);
    else db.prepare("DELETE FROM sessions WHERE account_id=?").run(accountId);
  }
  function cleanupSessions() {
    db.prepare("DELETE FROM sessions WHERE expires_at<?").run(now());
    db.prepare("DELETE FROM password_resets WHERE created_at<?").run(
      new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    );
  }

  // Express middleware: the request must come from a signed-in account of one of these roles
  // that has already replaced its temporary password.
  function requireRole(...roles) {
    return (req, res, next) => {
      for (const role of roles) {
        const s = getSession(req, role);
        if (!s) continue;
        if (s.account.must_change_password)
          return res
            .status(403)
            .json({
              error: "Please set a new password first.",
              code: "PASSWORD_CHANGE_REQUIRED",
            });
        req.account = s.account;
        req.session = s;
        if (role === "admin")
          req.adminEmail = s.account.email || s.account.login_id;
        return next();
      }
      return res
        .status(401)
        .json({ error: "Please sign in again.", code: "NOT_SIGNED_IN" });
    };
  }

  // ---------- admin password reset by email ----------
  // A link token is random, is stored only as a hash, works once, lasts 30 minutes, and only the newest link works.
  const RESET_MS = 30 * 60 * 1000;
  const RESET_LIMIT_WINDOW_MS = 60 * 60 * 1000;
  const RESET_LIMIT_PER_WINDOW = 5;
  // The active admin whose registered email (or login ID) is this address, or null when there is no single match.
  function findAdminByEmail(email) {
    const e = String(email || "")
      .trim()
      .toLowerCase();
    if (!e) return null;
    const rows = q.adminByEmailOrLogin
      .all(e, e)
      .filter((a) => a.status === "active");
    return rows.length === 1 ? rows[0] : null;
  }
  function recentResetCount(accountId, windowMs = RESET_LIMIT_WINDOW_MS) {
    const since = new Date(Date.now() - windowMs).toISOString();
    return db
      .prepare(
        "SELECT COUNT(*) AS n FROM password_resets WHERE account_id=? AND created_at>=?",
      )
      .get(accountId, since).n;
  }
  function createPasswordReset(accountId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = now();
    db.prepare(
      "UPDATE password_resets SET used_at=? WHERE account_id=? AND used_at IS NULL",
    ).run(t, accountId);
    db.prepare(
      "INSERT INTO password_resets(token_hash,account_id,created_at,expires_at) VALUES(?,?,?,?)",
    ).run(
      sha256(token),
      accountId,
      t,
      new Date(Date.now() + RESET_MS).toISOString(),
    );
    return token;
  }
  // Checks a link token and uses it up if it is valid. Returns the admin account, or null.
  function consumePasswordReset(token) {
    const raw = String(token || "");
    if (!/^[A-Za-z0-9_-]{20,}$/.test(raw)) return null;
    const row = db
      .prepare("SELECT * FROM password_resets WHERE token_hash=?")
      .get(sha256(raw));
    if (!row || row.used_at || row.expires_at < now()) return null;
    const account = q.byId.get(row.account_id);
    if (!account || account.role !== "admin" || account.status !== "active")
      return null;
    const used = db
      .prepare(
        "UPDATE password_resets SET used_at=? WHERE token_hash=? AND used_at IS NULL",
      )
      .run(now(), row.token_hash);
    return used.changes === 1 ? account : null;
  }

  // ---------- admin account management (Super Admin) ----------
  // Exactly one place decides who the Super Admin is. SUPER_ADMIN_EMAIL (backend/.env) names them; otherwise,
  // when nobody has been named yet, the earliest-created admin becomes Super Admin. Nothing else changes.
  function ensureSuperAdmin(preferredEmail = "") {
    const admins = db
      .prepare(
        `SELECT * FROM accounts WHERE role='admin' ORDER BY created_at, rowid`,
      )
      .all();
    if (!admins.length) return null;
    const wanted = String(preferredEmail || "")
      .trim()
      .toLowerCase();
    const named =
      wanted &&
      admins.find(
        (a) =>
          String(a.email || a.login_id)
            .trim()
            .toLowerCase() === wanted,
      );
    if (named && named.admin_role !== "super_admin") {
      db.prepare(`UPDATE accounts SET admin_role='super_admin' WHERE id=?`).run(
        named.id,
      );
    }
    if (!admins.some((a) => a.admin_role === "super_admin") && !named) {
      db.prepare(`UPDATE accounts SET admin_role='super_admin' WHERE id=?`).run(
        admins[0].id,
      );
    }
    return (
      db
        .prepare(
          `SELECT * FROM accounts WHERE role='admin' AND admin_role='super_admin' ORDER BY created_at LIMIT 1`,
        )
        .get() || null
    );
  }
  function isSuperAdmin(account) {
    return (
      !!account &&
      account.role === "admin" &&
      account.admin_role === "super_admin" &&
      account.status === "active"
    );
  }
  // Admin list for the Super Admin screen: never includes password hashes, reset tokens or session data.
  function listAdmins() {
    return db
      .prepare(
        `SELECT * FROM accounts WHERE role='admin' ORDER BY created_at, rowid`,
      )
      .all()
      .map((a) => ({
        loginId: a.login_id,
        name: a.name || "",
        email: (a.email || a.login_id || "").trim(),
        status: a.status,
        isSuperAdmin: a.admin_role === "super_admin",
        mustChangePassword: !!a.must_change_password,
        lastLoginAt: a.last_login_at || null,
        passwordChangedAt: a.password_changed_at || null,
        createdAt: a.created_at,
      }));
  }
  function adminByLoginId(loginId) {
    const a = q.byLogin.get(
      String(loginId || "")
        .trim()
        .toLowerCase(),
    );
    return a && a.role === "admin" ? a : null;
  }
  // Switches an admin on or off. Refuses to switch off yourself or the last active Super Admin.
  function setAdminStatus(loginId, status, actorAccountId) {
    const a = adminByLoginId(loginId);
    if (!a)
      return {
        ok: false,
        status: 404,
        error: "That admin account was not found.",
      };
    if (!["active", "disabled"].includes(status))
      return { ok: false, status: 400, error: "Unknown status." };
    if (status === "disabled") {
      if (a.id === actorAccountId)
        return {
          ok: false,
          status: 400,
          error: "You cannot switch off your own account.",
        };
      const others = db
        .prepare(
          `SELECT COUNT(*) AS n FROM accounts WHERE role='admin' AND admin_role='super_admin' AND status='active' AND id<>?`,
        )
        .get(a.id).n;
      if (a.admin_role === "super_admin" && !others)
        return {
          ok: false,
          status: 400,
          error:
            "This is the last active Super Admin and cannot be switched off.",
        };
    }
    db.prepare("UPDATE accounts SET status=?,updated_at=? WHERE id=?").run(
      status,
      now(),
      a.id,
    );
    if (status === "disabled") endAllSessions(a.id);
    return { ok: true, account: q.byId.get(a.id) };
  }

  // ---------- Super Admin: admin names and registered emails ----------
  // An admin's registered email is also their sign-in ID (login_id), so it must be unique across all accounts.
  const ADMIN_EMAIL_RE = /^[^\s@<>()\\",;:]+@[^\s@<>()\\",;:]+\.[^\s@<>()\\",;:]+$/;
  function checkAdminName(name) {
    const n = String(name ?? "").replace(/\s+/g, " ").trim();
    if (!n) return { error: "Enter the admin's full name.", field: "name" };
    if (n.length > 100)
      return { error: "The name is too long (100 characters at most).", field: "name" };
    return { value: n };
  }
  function checkAdminEmail(email, exceptId = null) {
    const e = String(email ?? "").trim().toLowerCase();
    if (!e || e.length > 254 || !ADMIN_EMAIL_RE.test(e))
      return { error: "Enter a valid email address.", field: "email" };
    const clash =
      q.byLogin.get(e) ||
      db
        .prepare(
          "SELECT * FROM accounts WHERE role='admin' AND lower(trim(email))=?",
        )
        .get(e);
    if (clash && clash.id !== exceptId)
      return {
        error: "Another account already uses this email address.",
        field: "email",
        status: 409,
      };
    return { value: e };
  }
  // Changes an admin's name and / or registered email. The password stays the same; reset links sent to the old
  // address stop working. Returns {ok, account, changes, previousEmail} or {ok:false, status, error, field}.
  function updateAdminDetails(loginId, { name, email } = {}) {
    const a = adminByLoginId(loginId);
    if (!a)
      return { ok: false, status: 404, error: "That admin account was not found." };
    const fail = (c) => ({ ok: false, status: c.status || 400, error: c.error, field: c.field });
    const previousEmail = (a.email || a.login_id || "").trim().toLowerCase();
    let newName = a.name || "",
      newEmail = previousEmail;
    const changes = [];
    if (name !== undefined) {
      const c = checkAdminName(name);
      if (c.error) return fail(c);
      if (c.value !== newName) {
        newName = c.value;
        changes.push("name");
      }
    }
    if (email !== undefined) {
      const c = checkAdminEmail(email, a.id);
      if (c.error) return fail(c);
      if (c.value !== previousEmail || c.value !== a.login_id) {
        newEmail = c.value;
        if (c.value !== previousEmail) changes.push("email");
      }
    }
    if (!changes.length && newEmail === a.login_id)
      return { ok: true, account: a, changes, previousEmail };
    const t = now();
    db.prepare(
      "UPDATE accounts SET name=?,email=?,login_id=?,updated_at=? WHERE id=?",
    ).run(newName, newEmail, newEmail, t, a.id);
    if (changes.includes("email"))
      db.prepare(
        "UPDATE password_resets SET used_at=? WHERE account_id=? AND used_at IS NULL",
      ).run(t, a.id);
    return { ok: true, account: q.byId.get(a.id), changes, previousEmail };
  }
  // Adds an admin with a temporary password (returned once). They must choose their own password at first sign-in.
  async function addAdmin({ name, email } = {}) {
    const n = checkAdminName(name);
    if (n.error) return { ok: false, status: 400, error: n.error, field: n.field };
    const e = checkAdminEmail(email);
    if (e.error)
      return { ok: false, status: e.status || 400, error: e.error, field: e.field };
    const password = tempPassword();
    const account = await createAccount({
      role: "admin",
      loginId: e.value,
      email: e.value,
      name: n.value,
      password,
      mustChange: true,
    });
    return { ok: true, account, password };
  }

  // ---------- partner accounts (created when an application is accepted) ----------
  function roleForApplication(app) {
    return String(app.type || "").toLowerCase() === "vendor"
      ? "vendor"
      : "franchise";
  }
  // Creates the login for an accepted application, or re-enables / updates an existing one.
  // With reset=true (or when no login exists yet) a new temporary password is issued and returned once.
  async function ensurePartnerAccount(app, { reset = false } = {}) {
    const role = roleForApplication(app),
      loginId = normaliseLoginId(role, app.appId);
    const email = String(app.email || "").trim(),
      name = String(app.name || "").trim();
    let account = q.byApplication.get(app.id),
      password = null,
      created = false;
    if (!account) {
      password = tempPassword();
      account = await createAccount({
        role,
        loginId,
        email,
        name,
        password,
        mustChange: true,
        applicationId: app.id,
      });
      created = true;
    } else {
      db.prepare(
        "UPDATE accounts SET role=?,login_id=?,email=?,name=?,status=?,updated_at=? WHERE id=?",
      ).run(role, loginId, email, name, "active", now(), account.id);
      if (account.role !== role) endAllSessions(account.id);
      if (reset) {
        password = tempPassword();
        await setPassword(account.id, password, { mustChange: true });
        endAllSessions(account.id);
      }
      account = q.byId.get(account.id);
    }
    return { account, password, created };
  }
  // Keeps an existing login in step with its application (type / ID / name / email changes).
  function syncPartnerAccount(app) {
    const account = q.byApplication.get(app.id);
    if (!account) return null;
    const role = roleForApplication(app);
    db.prepare(
      "UPDATE accounts SET role=?,login_id=?,email=?,name=?,updated_at=? WHERE id=?",
    ).run(
      role,
      normaliseLoginId(role, app.appId),
      String(app.email || ""),
      String(app.name || ""),
      now(),
      account.id,
    );
    if (account.role !== role) endAllSessions(account.id);
    return q.byId.get(account.id);
  }
  // Bans the portal login of an application's partner: they are signed out now and cannot sign in until the ban ends
  // (until = ISO time) or an admin unbans them (until = ""). The application status is not changed.
  function banPartner(applicationId, { until = "", reason = "", actor = "" } = {}) {
    const account = q.byApplication.get(applicationId);
    if (!account || (account.role !== "vendor" && account.role !== "franchise"))
      return {
        ok: false,
        status: 400,
        error: "This application has no portal login yet, so there is nothing to ban.",
      };
    let untilIso = null;
    if (String(until || "").trim()) {
      const t = Date.parse(until);
      if (!Number.isFinite(t))
        return { ok: false, status: 400, error: "The end of the ban is not a valid date." };
      if (t <= Date.now() + 60_000)
        return { ok: false, status: 400, error: "The ban must end in the future." };
      if (t > Date.now() + 5 * 366 * 86400000)
        return {
          ok: false,
          status: 400,
          error: "A ban can last at most 5 years. Choose \"Until I unban\" instead.",
        };
      untilIso = new Date(t).toISOString();
    }
    const t = now();
    db.prepare(
      "UPDATE accounts SET banned_at=?,banned_until=?,ban_reason=?,banned_by=?,updated_at=? WHERE id=?",
    ).run(
      t,
      untilIso,
      String(reason || "").replace(/\s+/g, " ").trim().slice(0, 300),
      String(actor || "").slice(0, 254),
      t,
      account.id,
    );
    endAllSessions(account.id);
    const saved = q.byId.get(account.id);
    return { ok: true, account: saved, ban: banInfo(saved) };
  }
  function unbanPartner(applicationId) {
    const account = q.byApplication.get(applicationId);
    if (!account)
      return { ok: false, status: 400, error: "This application has no portal login." };
    db.prepare(
      "UPDATE accounts SET banned_at=NULL,banned_until=NULL,ban_reason=NULL,banned_by=NULL,updated_at=? WHERE id=?",
    ).run(now(), account.id);
    return { ok: true, account: q.byId.get(account.id) };
  }
  function disablePartnerAccount(applicationId) {
    const account = q.byApplication.get(applicationId);
    if (!account) return null;
    db.prepare("UPDATE accounts SET status=?,updated_at=? WHERE id=?").run(
      "disabled",
      now(),
      account.id,
    );
    endAllSessions(account.id);
    return q.byId.get(account.id);
  }
  function accountsByApplication() {
    const map = new Map();
    for (const a of db
      .prepare("SELECT * FROM accounts WHERE application_id IS NOT NULL")
      .all())
      map.set(a.application_id, publicAccount(a));
    return map;
  }

  return {
    ROLES,
    hashPassword,
    verifyPassword,
    passwordProblem,
    tempPassword,
    normaliseLoginId,
    findForLogin,
    findCandidates,
    createAccount,
    setPassword,
    publicAccount,
    startSession,
    getSession,
    endSession,
    endAllSessions,
    cleanupSessions,
    requireRole,
    ensurePartnerAccount,
    syncPartnerAccount,
    disablePartnerAccount,
    accountsByApplication,
    accountForApplication: (id) => q.byApplication.get(id),
    accountById: (id) => q.byId.get(id),
    accountByLogin: (id) => q.byLogin.get(id),
    findAdminByEmail,
    recentResetCount,
    createPasswordReset,
    consumePasswordReset,
    ensureSuperAdmin,
    isSuperAdmin,
    listAdmins,
    adminByLoginId,
    setAdminStatus,
    updateAdminDetails,
    addAdmin,
    banInfo,
    banPartner,
    unbanPartner,
    RESET_LIMIT_PER_WINDOW,
    RESET_MS,
  };
}
