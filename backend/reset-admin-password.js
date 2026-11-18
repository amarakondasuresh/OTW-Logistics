// Reset an admin's password, or add a new admin, from the command line (run inside the backend folder).
//
//   node reset-admin-password.js admin@example.com               -> new temporary password for that admin
//   node reset-admin-password.js new.admin@example.com "Full Name"  -> adds a new admin (if the email is new)
//   node reset-admin-password.js --list                           -> shows the admin accounts in this folder's database
//
// On Windows, double-click RESET-ADMIN-PASSWORD.bat in the project folder instead.
// The temporary password is printed once. The admin must choose their own password at the next sign-in,
// and any devices where they were signed in are signed out.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";

const [, , emailArg, nameArg] = process.argv;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = path.join(__dirname, "payments.sqlite");
if (!fs.existsSync(dbFile)) {
  console.log(`No database in this folder (${dbFile}). Start the server once from this folder first.`);
  process.exit(1);
}
const db = new Database(dbFile);
db.pragma("busy_timeout = 5000"); // the server may be running at the same time
const auth = createAuth(db);

if (emailArg === "--list") {
  const admins = db
    .prepare(
      "SELECT name, email, status, admin_role, must_change_password, last_login_at FROM accounts WHERE role='admin' ORDER BY created_at",
    )
    .all();
  console.log(`Admin accounts in ${dbFile}:\n`);
  if (!admins.length) console.log("  (none yet - start the server once to create them)");
  admins.forEach((a, i) => {
    const notes = [
      a.admin_role === "super_admin" ? "Super Admin" : "",
      a.status !== "active" ? "NOT ACTIVE" : "",
      a.must_change_password ? "still on a temporary password" : "has chosen own password",
      a.last_login_at ? "last sign-in " + String(a.last_login_at).slice(0, 10) : "never signed in",
    ].filter(Boolean);
    console.log(`  ${i + 1}. ${String(a.name || "").padEnd(20)} ${String(a.email || "").padEnd(34)} ${notes.join(", ")}`);
  });
  process.exit(0);
}

const email = String(emailArg || "")
  .trim()
  .toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.log(
    'Usage:\n  node reset-admin-password.js --list\n  node reset-admin-password.js admin@example.com\n  node reset-admin-password.js new.admin@example.com "Full Name"',
  );
  process.exit(1);
}
const password = auth.tempPassword();
const existing =
  auth.findCandidates("admin", email)[0] || auth.accountByLogin(email) || null;

if (existing && existing.role !== "admin") {
  console.log(`${email} belongs to a ${existing.role} account, not an admin.`);
  process.exit(1);
}
if (existing) {
  await auth.setPassword(existing.id, password, { mustChange: true });
  db.prepare("UPDATE accounts SET status='active' WHERE id=?").run(existing.id);
  auth.endAllSessions(existing.id);
  console.log(`Password reset for admin ${email}.`);
} else {
  if (!nameArg) {
    console.log(
      `No admin with the email ${email}. To add them as a new admin, also give their name:\n  node reset-admin-password.js ${email} "Full Name"`,
    );
    process.exit(1);
  }
  await auth.createAccount({
    role: "admin",
    loginId: email,
    email,
    name: String(nameArg).trim(),
    password,
    mustChange: true,
  });
  console.log(`New admin added: ${nameArg} <${email}>.`);
}
console.log(
  `Temporary password: ${password}\nThey will be asked to choose their own password when they sign in at /dashboard/.`,
);
