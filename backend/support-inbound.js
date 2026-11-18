// Gmail API (OAuth 2.0) for the support mailbox. One client does two jobs:
//
//   send  - outgoing support email (new-ticket notices, customer confirmations, admin replies) is sent
//           through users.messages.send, so it leaves the authorised support account itself.
//   read  - incoming customer email is read from the inbox (users.messages.list / get) and processed:
//
//   For each unread inbox message:
//     1. Skip it if it was already processed (stored by Gmail message id), so no duplicate tickets are made.
//     2. If it quotes a ticket number, or replies to one of our emails, and comes from that ticket's customer
//        address, add it to that ticket's conversation (reopening the ticket if it was finished).
//     3. Otherwise open a new ticket and queue the customer confirmation.
//     4. Mark the message read only after it is saved. A failed save is retried on the next check.
//     5. Notify the admin address(es).
//
// No credentials are written to logs or responses. Settings come from backend/.env (GMAIL_OAUTH_*).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sameAddress, TICKET_NO_PATTERN } from "./support-tickets.js";
import {
  CONFIRM_SUBJECT,
  confirmationBody,
  noticeBody,
  NOTICE_SUBJECT,
  NEW_TICKET_SUBJECT,
  newTicketBody,
} from "./support-email-text.js";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export function gmailConfigFrom(env) {
  return {
    clientId: (env.GMAIL_OAUTH_CLIENT_ID || "").trim(),
    clientSecret: (env.GMAIL_OAUTH_CLIENT_SECRET || "").trim(),
    refreshToken: (env.GMAIL_OAUTH_REFRESH_TOKEN || "").trim(),
    supportAddress: (env.SUPPORT_EMAIL || "supportontheway@gmail.com").trim(),
  };
}

const b64url = (s) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const wrap76 = (b64) => b64.replace(/.{1,76}/g, (m) => m + "\r\n");

// Builds the RFC 2822 message Gmail expects (base64url). Returns { raw, messageId }.
export function buildRawMessage({ from, to, cc = "", subject, text, inReplyTo = "", references = "", headers = {}, attachments = [] }) {
  const domain = (from.split("@")[1] || "localhost").trim();
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const head = [
    `From: ON THE WAY LOGISTICS Support <${from}>`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references || inReplyTo}`] : []),
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  const bodyPart = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(text, "utf8").toString("base64")),
  ].join("\r\n");
  let body;
  if (attachments.length) {
    const boundary = "otw_" + crypto.randomBytes(12).toString("hex");
    const parts = [`--${boundary}\r\n${bodyPart}`];
    for (const a of attachments) {
      const type = /\.png$/i.test(a.filename) ? "image/png" : /\.webp$/i.test(a.filename) ? "image/webp" : "image/jpeg";
      parts.push(
        `--${boundary}\r\nContent-Type: ${type}; name="${a.filename.replace(/"/g, "")}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename.replace(/"/g, "")}"\r\n\r\n${wrap76(Buffer.from(a.content).toString("base64"))}`,
      );
    }
    body = `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`;
  } else {
    body = `${bodyPart}\r\n`;
  }
  const raw = Buffer.from(head.join("\r\n") + "\r\n" + body, "utf8").toString("base64url");
  return { raw, messageId };
}

// Extracts the plain text from a Gmail message payload. HTML is used only when no plain text exists.
export function extractText(part) {
  const plain = [];
  const html = [];
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data) plain.push(b64url(p.body.data));
    else if (p.mimeType === "text/html" && p.body?.data) html.push(b64url(p.body.data).replace(/<[^>]+>/g, " "));
    for (const c of p.parts || []) walk(c);
  };
  walk(part);
  return (plain.length ? plain : html).join("\n").replace(/\r\n/g, "\n");
}

// Keeps the customer's own words: drops quoted text and everything after a reply header.
export function customerText(text) {
  const kept = [];
  for (const line of String(text || "").split("\n")) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*On .{5,200} wrote:\s*$/.test(line) || /^\s*-{2,}\s*(Original|Forwarded) message/i.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

// "Name <email@x>" or "email@x" -> { name, email }
export function parseFrom(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(.*?)<([^>]+)>\s*$/);
  if (m) return { name: m[1].replace(/"/g, "").trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: s.toLowerCase() };
}

export function parseGmailMessage(json) {
  const headers = {};
  for (const h of json.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
  return {
    gmailId: json.id,
    threadId: json.threadId || "",
    from: parseFrom(headers.from),
    subject: headers.subject || "",
    messageId: headers["message-id"] || "",
    inReplyTo: headers["in-reply-to"] || "",
    references: headers.references || "",
    autoSubmitted: /auto-|bulk/i.test(headers["auto-submitted"] || headers.precedence || ""),
    text: customerText(extractText(json.payload)),
  };
}

// The shared Gmail client. Returns a sendMail(message) function compatible with support-mail.js.
export function createGmailApi({ config, fetchImpl = fetch, log = console }) {
  let token = { value: "", expiresAt: 0 };
  const configured = () => !!(config.clientId && config.clientSecret && config.refreshToken);

  async function accessToken() {
    if (token.value && Date.now() < token.expiresAt - 60_000) return token.value;
    const r = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const hint =
        j.error === "invalid_grant"
          ? " The refresh token was revoked or expired: run node gmail-authorize.js again."
          : "";
      throw new Error(`Gmail sign-in failed (${j.error || r.status}): ${j.error_description || "check GMAIL_OAUTH_* settings"}.${hint}`);
    }
    token = { value: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return token.value;
  }

  async function call(p, { method = "GET", body } = {}) {
    const r = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me${p}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint =
        r.status === 403 && /insufficient|scope/i.test(j.error?.message || "")
          ? " The authorisation does not allow this. Run node gmail-authorize.js again and grant both Gmail permissions."
          : "";
      throw new Error(`Gmail API ${method} ${p} failed (${r.status}): ${j.error?.message || "no details"}.${hint}`);
    }
    return j;
  }

  // Sends one message. Gmail accepts it for every recipient in the message, or the call fails.
  async function sendMail(message) {
    const recipients = [message.to, message.cc].filter(Boolean).join(",").split(",").map((s) => s.trim()).filter(Boolean);
    const { raw, messageId } = buildRawMessage({ ...message, from: config.supportAddress });
    const sent = await call("/messages/send", { method: "POST", body: { raw } });
    log.log?.(`[support-gmail] sent ${sent.id || ""} to ${recipients.join(", ")}`);
    return { messageId, accepted: recipients, rejected: [], gmailId: sent.id || "" };
  }

  return { configured, call, sendMail };
}

export function createGmailInbound({ db, api, service, mailer, adminRecipients, supportEmail, baseUrl = "", log = console }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_inbound_messages(
      gmail_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL DEFAULT '',
      from_addr TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      ticket_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );
  `);

  const state = { lastPollAt: "", lastError: "", lastCount: 0, polling: false, mailbox: "" };
  const enabled = () => api.configured();
  const seen = (gmailId) => db.prepare("SELECT 1 FROM support_inbound_messages WHERE gmail_id=?").get(gmailId);
  const record = (msg, ticketNo, action, at) =>
    db
      .prepare("INSERT OR IGNORE INTO support_inbound_messages VALUES(?,?,?,?,?,?,?,?)")
      .run(msg.gmailId, msg.threadId, msg.from.email, msg.subject, ticketNo, action, at, at);

  function queueAdminNotice(ticket, reason, gmailId) {
    mailer.enqueue({
      ticketId: ticket.id,
      dedupeKey: `notice:${gmailId}`,
      kind: "admin_notice",
      to: adminRecipients().join(", "),
      subject: NOTICE_SUBJECT(ticket.ticket_no),
      body: noticeBody(ticket, { baseUrl, reason }),
    });
  }

  // Decides what one message becomes.
  function handle(msg) {
    const at = new Date().toISOString();
    const own = msg.from.email === state.mailbox || msg.from.email === supportEmail.toLowerCase();
    if (own || msg.autoSubmitted) {
      record(msg, "", own ? "ignored-own" : "ignored-automatic", at);
      return { action: own ? "ignored-own" : "ignored-automatic", ticketNo: "" };
    }

    const mentioned = (`${msg.subject}\n${msg.text}`.match(TICKET_NO_PATTERN) || [])[0] || "";
    let ticket = mentioned ? service.rowByNumber(mentioned) : null;
    if (!ticket) ticket = service.ticketForMessageRefs([msg.inReplyTo, ...msg.references.split(/\s+/)]);
    let note = "";
    // Only the customer who opened a ticket may add to it. Anyone else gets a new ticket of their own.
    if (ticket && !sameAddress(ticket.email, msg.from.email)) {
      note = `This email mentions ${ticket.ticket_no}, but it was sent from a different address than the ticket. It was opened as a new ticket.\n\n`;
      ticket = null;
    }

    if (ticket) {
      const r = service.addMessage(ticket, {
        kind: "customer_email",
        authorRole: "customer",
        author: msg.from.email,
        body: msg.text,
        messageId: msg.messageId,
      });
      queueAdminNotice(r.ticket, `A customer replied by email to ${r.ticket.ticket_no}.`, msg.gmailId);
      record(msg, r.ticket.ticket_no, "attached", at);
      return { action: "attached", ticketNo: r.ticket.ticket_no };
    }

    const created = service.create({
      portalType: "Email",
      signedIn: false,
      account: null,
      name: msg.from.name || msg.from.email,
      email: msg.from.email,
      phone: null,
      description: `${note}Subject: ${msg.subject || "(no subject)"}\n\n${msg.text || "(no text in this email)"}`,
      photo: null,
      submissionKey: `gmail:${msg.gmailId}`,
      subject: msg.subject,
    });
    if (!created.duplicate) queueTicketEmails(created.ticket);
    record(msg, created.ticket.ticket_no, created.duplicate ? "already-created" : "created", at);
    return { action: created.duplicate ? "already-created" : "created", ticketNo: created.ticket.ticket_no };
  }

  // The support copy and the customer's confirmation for a new ticket. Queued only; the outbox sends them.
  function queueTicketEmails(t) {
    const submitted = service.events(t.id).find((e) => e.kind === "submitted");
    mailer.enqueue({
      ticketId: t.id,
      dedupeKey: "new",
      kind: "new_ticket",
      to: supportEmail,
      cc: adminRecipients(),
      subject: NEW_TICKET_SUBJECT(t.ticket_no),
      body: newTicketBody(t, { baseUrl }),
      attachment: t.photo_path ? { path: t.photo_path, name: t.photo_name || "problem-photo" } : null,
      sourceEventId: submitted ? submitted.id : null,
    });
    if (t.email && !sameAddress(t.email, supportEmail)) {
      mailer.enqueue({
        ticketId: t.id,
        dedupeKey: "confirm",
        kind: "customer_confirmation",
        to: t.email,
        subject: CONFIRM_SUBJECT(t.ticket_no),
        body: confirmationBody(t),
      });
    }
  }

  // One pass over unread support mail. Returns how many messages were handled.
  async function pollOnce() {
    if (!enabled())
      throw new Error("Incoming Gmail is not connected: set GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and GMAIL_OAUTH_REFRESH_TOKEN in backend/.env (run node gmail-authorize.js)");
    if (state.polling) return 0;
    state.polling = true;
    let handled = 0;
    try {
      if (!state.mailbox) state.mailbox = String((await api.call("/profile")).emailAddress || "").toLowerCase();
      const list = await api.call("/messages?q=" + encodeURIComponent("is:unread in:inbox") + "&maxResults=25");
      for (const m of list.messages || []) {
        if (seen(m.id)) {
          await api.call(`/messages/${m.id}/modify`, { method: "POST", body: { removeLabelIds: ["UNREAD"] } }).catch(() => {});
          continue;
        }
        const msg = parseGmailMessage(await api.call(`/messages/${m.id}?format=full`));
        const result = handle(msg);
        handled++;
        log.log?.(`[support-inbound] from ${msg.from.email} -> ${result.action} ${result.ticketNo}`.trim());
        // Mark read only after the save above, so nothing is lost if this step fails.
        await api.call(`/messages/${m.id}/modify`, { method: "POST", body: { removeLabelIds: ["UNREAD"] } });
      }
      state.lastError = "";
      state.lastCount = handled;
    } catch (e) {
      state.lastError = e.message;
      log.error?.(`[support-inbound] ${e.message}`);
    } finally {
      state.lastPollAt = new Date().toISOString();
      state.polling = false;
    }
    return handled;
  }

  function status() {
    return {
      enabled: enabled(),
      mailbox: state.mailbox || supportEmail,
      lastPollAt: state.lastPollAt,
      lastError: state.lastError,
      lastCount: state.lastCount,
      setupNote: enabled()
        ? ""
        : "Incoming customer email is not connected yet. Set GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and GMAIL_OAUTH_REFRESH_TOKEN in backend/.env (run node gmail-authorize.js), then restart the server.",
    };
  }

  function start(intervalMs = 60_000) {
    if (!enabled()) return null;
    const timer = setInterval(() => pollOnce(), intervalMs);
    timer.unref?.();
    pollOnce();
    return timer;
  }

  return { enabled, pollOnce, status, start, handle, queueTicketEmails };
}
