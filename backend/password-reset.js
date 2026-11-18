// Admin "forgot password" by email. server.js exposes this as POST /api/auth/forgot-password and
// POST /api/auth/reset-password. It has no web-framework dependency so its rules can be tested directly.
//
// Rules:
// - The answer to a reset request is the same whether or not the email belongs to an admin, so the form cannot
//   be used to find out who is an admin. The email itself is sent in the background, so response time does not
//   reveal it either.
// - The link is sent only to the admin's registered email. Its token is random, stored only as a hash, works once,
//   expires after 30 minutes, and a newer link replaces older ones. Each admin gets at most 5 links per hour.
// - The token sits after '#' in the link, so it is never sent to the web server or written to its logs.
// - No password is ever put in an email or returned to the browser. Gmail / SMTP credentials are read from
//   backend/.env only and are never stored in the database.

export const RESET_REQUEST_MESSAGE =
  "If that email belongs to an authorized admin account, a password reset link has been sent to it. " +
  "Check your inbox and spam folder. The link expires in 30 minutes.";
const EMAIL_RE = /^[^\s@<>()\\",;:]+@[^\s@<>()\\",;:]+\.[^\s@<>()\\",;:]+$/;
const oneLine = (v) =>
  String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();

export function resetEmailText({ name, address, link, expiresMinutes }) {
  return [
    `Hello ${oneLine(name) || "admin"},`,
    "",
    `We received a request to reset the password for your On The Way Logistics admin account (${address}).`,
    "",
    `Open this link to choose a new password. It works once and expires in ${expiresMinutes} minutes:`,
    "",
    link,
    "",
    "If you did not ask for this, ignore this email. Your password will not change.",
    "Do not share this link with anyone.",
    "",
    "On The Way Logistics",
  ].join("\n");
}

export function createPasswordResetService({
  auth,
  sendMail,
  audit = () => {},
  log = console,
}) {
  // Starts a reset. Returns the same message for every input; the email (if any) is sent in the background.
  // `done` resolves once that background send has finished (used by tests; the server does not wait for it).
  function requestReset({ email, baseUrl }) {
    const address = String(email ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 254);
    const answer = {
      ok: true,
      message: RESET_REQUEST_MESSAGE,
      done: Promise.resolve(),
    };
    if (!EMAIL_RE.test(address)) return answer;
    const account = auth.findAdminByEmail(address);
    if (!account) return answer;
    if (auth.recentResetCount(account.id) >= auth.RESET_LIMIT_PER_WINDOW)
      return answer;

    const token = auth.createPasswordReset(account.id);
    const to = account.email || account.login_id;
    audit(to, "password_reset_requested", { by: "self" });
    const link = `${String(baseUrl || "").replace(/\/+$/, "")}/dashboard/#reset=${token}`;
    const minutes = Math.round(auth.RESET_MS / 60000);
    answer.done = Promise.resolve()
      .then(() =>
        sendMail({
          to,
          subject: "Reset your On The Way Logistics admin password",
          text: resetEmailText({
            name: account.name,
            address: to,
            link,
            expiresMinutes: minutes,
          }),
        }),
      )
      .then(() => audit(to, "password_reset_link_sent", {}))
      .catch((err) => {
        log.error("Password reset email failed:", err && err.message);
        audit(to, "password_reset_email_failed", { by: "self" });
      });
    return answer;
  }

  // The Super Admin sends a reset link to another admin. The link goes only to that admin's registered email,
  // never to the Super Admin, and the Super Admin never sees a password or the link itself.
  // Unlike requestReset this waits for the email, so the Super Admin learns whether it was really sent.
  async function requestResetForAdmin({ account, actorEmail, baseUrl }) {
    if (!account || account.role !== "admin" || account.status !== "active") {
      return {
        ok: false,
        status: 400,
        error: "Only an active admin account can be sent a reset link.",
      };
    }
    const to = account.email || account.login_id;
    if (!EMAIL_RE.test(String(to).trim())) {
      return {
        ok: false,
        status: 400,
        error:
          "This admin has no valid registered email address, so no link can be sent.",
      };
    }
    if (auth.recentResetCount(account.id) >= auth.RESET_LIMIT_PER_WINDOW) {
      return {
        ok: false,
        status: 429,
        error:
          "Too many reset links were sent to this admin in the last hour. Try again later.",
      };
    }
    const token = auth.createPasswordReset(account.id);
    const link = `${String(baseUrl || "").replace(/\/+$/, "")}/dashboard/#reset=${token}`;
    audit(actorEmail, "password_reset_requested", {
      by: "super_admin",
      target: to,
    });
    try {
      await sendMail({
        to,
        subject: "Reset your On The Way Logistics admin password",
        text: resetEmailText({
          name: account.name,
          address: to,
          link,
          expiresMinutes: Math.round(auth.RESET_MS / 60000),
        }),
      });
    } catch (err) {
      log.error("Password reset email failed:", err && err.message);
      audit(actorEmail, "password_reset_email_failed", {
        by: "super_admin",
        target: to,
      });
      return {
        ok: false,
        status: 502,
        error:
          "The reset email could not be sent. Check the email settings in backend/.env.",
      };
    }
    audit(actorEmail, "password_reset_link_sent", {
      by: "super_admin",
      target: to,
    });
    return { ok: true, sentTo: to };
  }

  // Sets the new password when the link is valid. The password rules are checked before the link is used up,
  // so a mistyped password does not waste the link.
  async function completeReset({ token, newPassword }) {
    const problem = auth.passwordProblem(newPassword);
    if (problem) return { ok: false, status: 400, error: problem };
    const account = auth.consumePasswordReset(token);
    if (!account) {
      audit("(unknown)", "password_reset_invalid_link", {});
      return {
        ok: false,
        status: 400,
        error:
          "This reset link is no longer valid. It may have expired or already been used. Request a new one from the sign-in page.",
      };
    }
    await auth.setPassword(account.id, newPassword, { mustChange: false });
    auth.endAllSessions(account.id); // sign out every device; the admin signs in with the new password
    audit(account.email || account.login_id, "password_reset", {});
    return { ok: true };
  }

  return { requestReset, requestResetForAdmin, completeReset };
}
