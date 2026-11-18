// One-time helper: connects the support Gmail account for incoming customer email.
//
//   1. In Google Cloud Console: enable the Gmail API, create an OAuth client (type "Web application"),
//      and add the redirect URI  http://localhost:8765/oauth2callback
//   2. Put GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in backend/.env
//   3. Run:  node gmail-authorize.js
//      Open the printed link, sign in as the support account (supportontheway@gmail.com) and allow access.
//   4. Copy the printed GMAIL_OAUTH_REFRESH_TOKEN into backend/.env, then restart the server.
//
// The token is printed once and not saved by this script. Keep it secret.
// Scopes: gmail.send (send support email as this account) and gmail.modify (read incoming mail, mark it read).
// Sign in as the support account: messages are sent from that account.
import http from "node:http";
import dotenv from "dotenv";

dotenv.config();
const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in backend/.env first.");
  process.exit(1);
}
const redirect = "http://localhost:8765/oauth2callback";
const url =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.modify"].join(" "),
    access_type: "offline",
    prompt: "consent",
  });
console.log("Open this link and sign in as the support account:\n\n" + url + "\n");

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, redirect);
    if (u.pathname !== "/oauth2callback") return res.end();
    const code = u.searchParams.get("code");
    if (!code) {
      res.end("Authorization was not completed. You can close this tab.");
      return;
    }
    try {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        }),
      });
      const j = await r.json();
      if (!j.refresh_token) throw new Error(j.error_description || j.error || "No refresh token returned.");
      console.log("\nGMAIL_OAUTH_REFRESH_TOKEN=" + j.refresh_token + "\n");
      res.end("Connected. You can close this tab and return to the terminal.");
    } catch (e) {
      console.error("Connection failed:", e.message);
      res.end("Connection failed. See the terminal.");
    } finally {
      setTimeout(() => process.exit(0), 500);
    }
  })
  .listen(8765, "127.0.0.1", () => console.log("Waiting for Google to redirect back on http://localhost:8765 ..."));
