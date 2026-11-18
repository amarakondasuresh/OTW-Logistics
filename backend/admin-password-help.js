// Admin password help when reset emails cannot be sent (email not set up in backend/.env, or the email settings are
// wrong). server.js uses this for POST /api/auth/forgot-password in that case, and for the Super Admin's
// "Temporary password" action in Settings > Admin Accounts.
//
// Rules:
// - The answer to a help request is the same whether or not the email belongs to an admin, so the form cannot be used
//   to find out who is an admin. Only active admins are recorded.
// - A request is shown to the Super Admin until the admin signs in, the password is changed, or a temporary password
//   is issued. Requests older than 7 days are not shown.
// - Only the Super Admin can issue a temporary password, never for their own account (they use Change password), and
//   only for an active admin. The admin must choose their own password at the next sign-in; every device is signed
//   out and any unused email reset link stops working. The password is returned once and never stored in clear.
// - Every request and every temporary password is written to the audit log.

export const HELP_REQUEST_MESSAGE =
  "Reset emails cannot be sent from this server right now, so no link was emailed. " +
  "If that email belongs to an authorized admin account, your Super Admin has been asked to help: " +
  "they can give you a temporary password from Settings > Admin Accounts. Please contact them.";
const EMAIL_RE = /^[^\s@<>()\\",;:]+@[^\s@<>()\\",;:]+\.[^\s@<>()\\",;:]+$/;
const SHOW_DAYS = 7;

export function createPasswordHelpService({
  db,
  auth,
  audit = () => {},
  now = () => new Date().toISOString(),
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_password_help(
    account_id TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL,
    times INTEGER NOT NULL DEFAULT 1
  );`);

  function requestHelp({ email }) {
    const answer = { ok: true, mode: "super_admin", message: HELP_REQUEST_MESSAGE };
    const address = String(email ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 254);
    if (!EMAIL_RE.test(address)) return answer;
    const account = auth.findAdminByEmail(address); // active admins only
    if (!account) return answer;
    db.prepare(
      `INSERT INTO admin_password_help(account_id, requested_at, times) VALUES(?,?,1)
       ON CONFLICT(account_id) DO UPDATE SET requested_at=excluded.requested_at, times=admin_password_help.times+1`,
    ).run(account.id, now());
    audit(account.email || account.login_id, "password_help_requested", {
      by: "self",
    });
    return answer;
  }

  // Open requests by login ID: {requestedAt, times}. A request ends when the admin signs in or the password changes.
  function openRequests() {
    const since = new Date(Date.parse(now()) - SHOW_DAYS * 86400000).toISOString();
    const rows = db
      .prepare(
        `SELECT a.login_id, h.requested_at, h.times FROM admin_password_help h
         JOIN accounts a ON a.id = h.account_id
         WHERE a.role = 'admin' AND a.status = 'active' AND h.requested_at >= ?
           AND (a.last_login_at IS NULL OR a.last_login_at < h.requested_at)
           AND (a.password_changed_at IS NULL OR a.password_changed_at < h.requested_at)`,
      )
      .all(since);
    return new Map(
      rows.map((r) => [r.login_id, { requestedAt: r.requested_at, times: r.times }]),
    );
  }

  async function issueTemporaryPassword({ loginId, actorAccountId, actorEmail }) {
    const target = auth.adminByLoginId(loginId);
    if (!target)
      return { ok: false, status: 404, error: "That admin account was not found." };
    if (target.id === actorAccountId)
      return {
        ok: false,
        status: 400,
        error: "Use Change password for your own account.",
      };
    if (target.status !== "active")
      return {
        ok: false,
        status: 400,
        error: "Switch this admin on before giving a temporary password.",
      };
    const password = auth.tempPassword();
    await auth.setPassword(target.id, password, { mustChange: true });
    auth.endAllSessions(target.id);
    db.prepare(
      "UPDATE password_resets SET used_at=? WHERE account_id=? AND used_at IS NULL",
    ).run(now(), target.id);
    db.prepare("DELETE FROM admin_password_help WHERE account_id=?").run(target.id);
    audit(actorEmail, "temporary_password_issued", {
      target: target.email || target.login_id,
    });
    return {
      ok: true,
      password,
      loginId: target.login_id,
      email: target.email || target.login_id,
      name: target.name || "",
    };
  }

  return { requestHelp, openRequests, issueTemporaryPassword };
}
