// List the admin accounts on this server, read-only. Shows each admin's name, registered email, status and
// sign-in history. It never shows passwords, password hashes or email settings.
//
//   node admin-accounts.js        (run inside the backend folder, on the machine that runs the server)
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ADMIN_ROWS_SQL = `SELECT name, login_id, email, status, must_change_password, last_login_at, password_changed_at, created_at
  FROM accounts WHERE role='admin' ORDER BY created_at, login_id`;

// Works with any database object that has prepare(sql).all() (better-sqlite3 or node:sqlite).
export function adminAccountRows(db) {
  return db
    .prepare(ADMIN_ROWS_SQL)
    .all()
    .map((r) => ({
      name: r.name || "",
      email: (r.email || r.login_id || "").trim(),
      status: r.status,
      passwordChosenByAdmin: !r.must_change_password,
      lastSignIn: r.last_login_at || "",
      createdAt: r.created_at || "",
      isGmail: /@gmail\.com$/i.test((r.email || r.login_id || "").trim()),
    }));
}

// Text report. `mailReady` says whether reset emails can be sent; the sender address is shown, never the password.
export function formatAdminReport(rows, { mailReady, mailFrom = "" }) {
  const lines = [];
  lines.push(`Admin accounts: ${rows.length}`, "");
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.name || "(no name)"}`);
    lines.push(
      `   Registered email : ${r.email}${r.isGmail ? "" : "   <-- not a Gmail address; confirm this is the admin's registered address"}`,
    );
    lines.push(`   Status           : ${r.status}`);
    lines.push(
      `   Password         : ${r.passwordChosenByAdmin ? "chosen by the admin" : "temporary, must be chosen at the next sign-in"}`,
    );
    lines.push(
      `   Last sign-in     : ${r.lastSignIn ? new Date(r.lastSignIn).toLocaleString() : "never"}`,
    );
    lines.push("");
  });
  lines.push(
    mailReady
      ? `Forgot-password emails: ready (sent from ${mailFrom}).`
      : "Forgot-password emails: NOT ready. Add GMAIL_APP_PASSWORD (or SMTP settings) to backend/.env and restart the server.",
  );
  return lines.join("\n");
}

async function main() {
  const { default: Database } = await import("better-sqlite3");
  const { default: dotenv } = await import("dotenv");
  const here = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.join(here, ".env") });
  const db = new Database(path.join(here, "payments.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  const rows = adminAccountRows(db);
  const pass = String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  const usingSmtp = !!process.env.SMTP_HOST;
  const mailReady = usingSmtp || (!!pass && !pass.startsWith("replace_"));
  const mailFrom =
    process.env.GMAIL_USER ||
    process.env.SUPPORT_EMAIL ||
    "the configured mailbox";
  console.log(
    formatAdminReport(rows, {
      mailReady,
      mailFrom: usingSmtp
        ? process.env.SMTP_USER || process.env.GMAIL_USER || "SMTP account"
        : mailFrom,
    }),
  );
  db.close();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((err) => {
    console.error(
      err.code === "SQLITE_CANTOPEN" ||
        /does not exist|unable to open/i.test(err.message)
        ? "No database yet: start the server once (node server.js) so the database and first admins are created."
        : "Could not read the admin accounts: " + err.message,
    );
    process.exit(1);
  });
}
