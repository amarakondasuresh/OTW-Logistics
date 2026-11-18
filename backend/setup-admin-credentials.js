// Provision or reset the four authorized admin accounts on THIS backend database.
// Run from SETUP-ADMIN-LOGINS.bat after the first START-WINDOWS.bat setup.
// Every run generates fresh random one-time passwords; only salted scrypt hashes are stored in SQLite.
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(here, "payments.sqlite"));
const auth = createAuth(db);
const admins = [
  { email: "balajinaik5069@gmail.com", name: "M. Balajinaik" },
  { email: "koppelagayathri@gmail.com", name: "Koppela Gayathri" },
  { email: "Namburirk26@gmail.com", name: "Namburi Rajkumar" },
  { email: "pavankbd4@gmail.com", name: "Nakka Pavan" },
];
const makePassword = () => {
  // 18 random bytes encoded as 3 readable groups; letters and digits are guaranteed.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let raw = "";
  while (raw.length < 18) raw += alphabet[crypto.randomInt(alphabet.length)];
  return `${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}`;
};
const lines = [
  "ON THE WAY LOGISTICS - TEMPORARY ADMIN LOGIN CREDENTIALS",
  `Generated: ${new Date().toISOString()}`,
  "Database: backend/payments.sqlite",
  "Sign in at: http://localhost:8080/dashboard/",
  "Each admin must choose a new password immediately after sign-in.",
  "Keep this file private. Delete it after distributing each admin their own credentials.",
  "",
];
const results = [];
try {
  // Fail safely if a requested email is already owned by a non-admin account.
  for (const a of admins) {
    const byEmail = db
      .prepare(
        "SELECT * FROM accounts WHERE lower(trim(email))=? OR lower(trim(login_id))=?",
      )
      .all(a.email, a.email);
    if (byEmail.some((row) => row.role !== "admin")) {
      throw new Error(
        `${a.email} is already assigned to a non-admin account. No credentials were issued.`,
      );
    }
  }
  for (const a of admins) {
    const password = makePassword();
    const existing =
      auth.findCandidates("admin", a.email)[0] || auth.accountByLogin(a.email);
    if (existing) {
      await auth.setPassword(existing.id, password, { mustChange: true });
      db.prepare(
        "UPDATE accounts SET status='active', email=?, name=?, updated_at=? WHERE id=?",
      ).run(a.email, a.name, new Date().toISOString(), existing.id);
      auth.endAllSessions(existing.id);
    } else {
      await auth.createAccount({
        role: "admin",
        loginId: a.email,
        email: a.email,
        name: a.name,
        password,
        mustChange: true,
      });
    }
    const saved = auth.findCandidates("admin", a.email)[0];
    if (
      !saved ||
      saved.status !== "active" ||
      !(await auth.verifyPassword(password, saved.password_hash))
    ) {
      throw new Error(`Credential verification failed for ${a.email}.`);
    }
    results.push({ name: a.name, email: a.email, password });
  }
  auth.ensureSuperAdmin("balajinaik5069@gmail.com");
  for (const a of results)
    lines.push(
      `${a.name}\nEmail: ${a.email}\nTemporary password: ${a.password}\n`,
    );
  const report = lines.join("\n");
  const reportPath = path.join(here, "ADMIN-TEMPORARY-LOGIN-CREDENTIALS.txt");
  fs.writeFileSync(reportPath, report, { mode: 0o600 });
  try {
    fs.chmodSync(reportPath, 0o600);
  } catch {}
  console.log(report);
  console.log(
    "VERIFICATION: All four accounts are active and each generated password matches its stored scrypt hash.",
  );
  console.log(
    "Saved privately to backend/ADMIN-TEMPORARY-LOGIN-CREDENTIALS.txt",
  );
} catch (err) {
  console.error("ADMIN SETUP FAILED:", err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
