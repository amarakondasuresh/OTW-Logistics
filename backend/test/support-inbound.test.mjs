// Incoming customer email: parsing, matching to tickets, duplicate protection, ignored mail, and
// marking a message read only after it has been saved. The Gmail API is replaced by a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSupportService } from "../support-tickets.js";
import { createSupportMailer } from "../support-mail.js";
import { buildRawMessage, createGmailApi, createGmailInbound, customerText, extractText, parseFrom, parseGmailMessage } from "../support-inbound.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}
const t = DatabaseSync ? test : test.skip;
const quiet = { log() {}, error() {} };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");

// ----- pure parsing -----
t("parseFrom reads a name and address, or a bare address", () => {
  assert.deepEqual(parseFrom('"Ravi Kumar" <Ravi@Example.com>'), { name: "Ravi Kumar", email: "ravi@example.com" });
  assert.deepEqual(parseFrom("ravi@example.com"), { name: "", email: "ravi@example.com" });
});

t("customerText keeps the customer's words and drops quoted text", () => {
  const raw = "My rider app is wrong.\nPlease check.\n\nOn Tue, 17 Nov 2026, ON THE WAY wrote:\n> Your ticket is open\n> thanks";
  assert.equal(customerText(raw), "My rider app is wrong.\nPlease check.");
  assert.equal(customerText("Hi\n> quoted\nNew line"), "Hi\nNew line");
});

t("extractText decodes plain text inside multipart mail and falls back to HTML", () => {
  const plain = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("Plain words") } }, { mimeType: "text/html", body: { data: b64("<p>HTML</p>") } }] };
  assert.equal(extractText(plain), "Plain words");
  const htmlOnly = { mimeType: "text/html", body: { data: b64("<p>Only HTML</p>") } };
  assert.match(extractText(htmlOnly), /Only HTML/);
});

t("parseGmailMessage reads headers, threading ids and the body", () => {
  const msg = parseGmailMessage({
    id: "g1",
    threadId: "th1",
    payload: {
      headers: [
        { name: "From", value: '"Asha" <asha@example.com>' },
        { name: "Subject", value: "Problem" },
        { name: "Message-ID", value: "<abc@mail.gmail.com>" },
        { name: "In-Reply-To", value: "<prev@ontheway>" },
        { name: "References", value: "<old@ontheway> <prev@ontheway>" },
      ],
      mimeType: "text/plain",
      body: { data: b64("Hello") },
    },
  });
  assert.equal(msg.from.email, "asha@example.com");
  assert.equal(msg.messageId, "<abc@mail.gmail.com>");
  assert.equal(msg.inReplyTo, "<prev@ontheway>");
  assert.equal(msg.text, "Hello");
});

// ----- with a database and a fake Gmail -----
function setup({ configured = true, ownAddress = "ontheway5579@gmail.com" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otw-in-"));
  const db = new DatabaseSync(path.join(dir, "i.sqlite"));
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY, role TEXT, login_id TEXT, email TEXT, status TEXT DEFAULT 'active')");
  db.exec("INSERT INTO accounts VALUES('adm','admin','ADMIN','admin@example.com','active')");
  const service = createSupportService({ db, uploadDir: dir });
  const sentMail = [];
  const mailer = createSupportMailer({
    db,
    uploadDir: dir,
    log: quiet,
    transport: {
      async sendMail(m) {
        sentMail.push(m);
        return { messageId: `<out${sentMail.length}@ontheway>`, accepted: [m.to, ...(m.cc ? m.cc.split(", ") : [])], rejected: [] };
      },
    },
  });
  const inbox = new Map(); // gmail id -> json
  const modified = [];
  let failModify = false;
  const fetchImpl = async (url, opts = {}) => {
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
    if (url.endsWith("/profile")) return json({ emailAddress: ownAddress });
    if (url.includes("/messages?q=")) return json({ messages: [...inbox.keys()].filter((id) => !modified.includes(id) || inbox.get(id).__stillUnread).map((id) => ({ id })) });
    const m = url.match(/\/messages\/([^/?]+)(\?|\/modify|$)/);
    if (url.endsWith("/modify")) {
      if (failModify) return json({ error: { message: "quota" } }, 500);
      modified.push(m[1]);
      return json({});
    }
    if (m && inbox.has(m[1])) return json(inbox.get(m[1]));
    return json({ error: { message: "not found" } }, 404);
  };
  const api = createGmailApi({
    config: configured
      ? { clientId: "cid", clientSecret: "sec", refreshToken: "rt", supportAddress: "supportontheway@gmail.com" }
      : { clientId: "", clientSecret: "", refreshToken: "", supportAddress: "supportontheway@gmail.com" },
    fetchImpl,
    log: quiet,
  });
  const inbound = createGmailInbound({
    db,
    api,
    service,
    mailer,
    adminRecipients: () => ["admin@example.com"],
    supportEmail: "supportontheway@gmail.com",
    log: quiet,
  });
  const put = (id, { from, subject = "", text = "", inReplyTo = "", autoSubmitted = "" }) => {
    const headers = [
      { name: "From", value: from },
      { name: "Subject", value: subject },
      { name: "Message-ID", value: `<${id}@mail>` },
    ];
    if (inReplyTo) headers.push({ name: "In-Reply-To", value: inReplyTo });
    if (autoSubmitted) headers.push({ name: "Auto-Submitted", value: autoSubmitted });
    inbox.set(id, { id, threadId: "th-" + id, payload: { headers, mimeType: "text/plain", body: { data: b64(text) } } });
  };
  return { db, dir, service, mailer, inbound, put, inbox, modified, sentMail, setFailModify: (v) => (failModify = v) };
}

t("a new customer email with no ticket number becomes a new ticket, once, and support is emailed", async () => {
  const env = setup();
  env.put("g1", { from: '"Asha Rao" <asha@example.com>', subject: "Rider app not loading", text: "The app shows a blank page since today." });
  assert.equal(await env.inbound.pollOnce(), 1);
  await env.mailer.runDue(); // the outbox worker sends queued mail
  const tickets = env.service.listForAdmin().tickets;
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].portalType, "Email");
  assert.equal(tickets[0].email, "asha@example.com");
  assert.equal(tickets[0].customerName, "Asha Rao");
  assert.match(tickets[0].description, /Subject: Rider app not loading/);
  assert.match(tickets[0].description, /blank page/);
  assert.deepEqual(env.modified, ["g1"], "message marked read after saving");
  const job = env.mailer.newTicketStatus(tickets[0].id);
  assert.equal(job.status, "Sent");
  assert.equal(env.sentMail[0].to, "supportontheway@gmail.com");
  assert.match(env.sentMail[0].subject, /^New Support Ticket – ON THE WAY LOGISTICS – OTW-SUP-/);
});

t("the same Gmail message seen again creates no second ticket", async () => {
  const env = setup();
  env.put("g1", { from: "asha@example.com", subject: "Help", text: "Please help" });
  await env.inbound.pollOnce();
  // Gmail still lists it as unread (mark-read failed earlier): it must not create a second ticket
  env.setFailModify(false);
  env.inbox.get("g1").__stillUnread = true;
  await env.inbound.pollOnce();
  assert.equal(env.service.listForAdmin().tickets.length, 1);
});

t("a reply quoting a ticket number from the same customer is added to that ticket and reopens it", async () => {
  const env = setup();
  const existing = env.service.create({
    portalType: "Vendor",
    signedIn: false,
    name: "Asha",
    email: "asha@example.com",
    description: "First issue",
    photo: null,
  }).ticket;
  env.service.setStatus(existing.id, "admin", "Resolved");
  env.put("g2", { from: "asha@example.com", subject: `Re: ${existing.ticket_no}`, text: "It is still broken." });
  await env.inbound.pollOnce();
  const detail = env.service.getForAdmin(existing.id);
  assert.equal(env.service.listForAdmin().tickets.length, 1, "no duplicate ticket");
  assert.equal(detail.ticket.status, "Pending", "a resolved ticket reopens when the customer writes again");
  const last = detail.events.at(-1);
  assert.equal(last.kind, "customer_email");
  assert.equal(last.body, "It is still broken.");
  assert.equal(env.mailer.forTicket(existing.id).some((j) => j.kind === "admin_notice"), true, "admin is told");
});

t("a reply threaded by In-Reply-To attaches to the ticket even without the ticket number", async () => {
  const env = setup();
  const ticket = env.service.create({ portalType: "Franchise", signedIn: false, name: "Ravi", email: "ravi@example.com", description: "x", photo: null }).ticket;
  env.service.addMessage(ticket, { kind: "reply", authorRole: "admin", author: "admin", body: "We are checking.", messageId: "<ourreply@ontheway>" });
  env.put("g3", { from: "ravi@example.com", subject: "Re: Your support request", text: "Any update?", inReplyTo: "<ourreply@ontheway>" });
  await env.inbound.pollOnce();
  assert.equal(env.service.listForAdmin().tickets.length, 1);
  assert.equal(env.service.getForAdmin(ticket.id).events.at(-1).body, "Any update?");
});

t("someone else quoting a ticket number does not get added to that ticket", async () => {
  const env = setup();
  const ticket = env.service.create({ portalType: "Vendor", signedIn: false, name: "Asha", email: "asha@example.com", description: "private", photo: null }).ticket;
  env.put("g4", { from: "stranger@example.com", subject: `About ${ticket.ticket_no}`, text: "Please give me access" });
  await env.inbound.pollOnce();
  const all = env.service.listForAdmin().tickets;
  assert.equal(all.length, 2, "a new ticket is opened instead");
  const detail = env.service.getForAdmin(ticket.id);
  assert.equal(detail.events.length, 1, "the original ticket is untouched");
  const fresh = all.find((x) => x.id !== ticket.id);
  assert.match(fresh.description, /sent from a different address/);
});

t("emails from the support account itself and automatic replies are ignored", async () => {
  const env = setup();
  env.put("g5", { from: "ontheway5579@gmail.com", subject: "Sent by us", text: "copy" });
  env.put("g6", { from: "noreply@bank.example", subject: "Receipt", text: "auto", autoSubmitted: "auto-replied" });
  await env.inbound.pollOnce();
  assert.equal(env.service.listForAdmin().tickets.length, 0);
  const rows = env.db.prepare("SELECT action FROM support_inbound_messages ORDER BY gmail_id").all().map((r) => r.action);
  assert.deepEqual(rows, ["ignored-own", "ignored-automatic"]);
});

t("when marking read fails, the message is not lost and is not made into a second ticket", async () => {
  const env = setup();
  env.put("g7", { from: "asha@example.com", subject: "Once", text: "Only once" });
  env.setFailModify(true);
  await env.inbound.pollOnce();
  assert.equal(env.service.listForAdmin().tickets.length, 1, "saved before the failure");
  assert.match(env.inbound.status().lastError, /quota/);
  env.setFailModify(false);
  env.inbox.get("g7").__stillUnread = true;
  await env.inbound.pollOnce();
  assert.equal(env.service.listForAdmin().tickets.length, 1, "no duplicate after the retry");
});

t("without the Gmail OAuth settings, incoming email is reported as not connected and nothing is read", async () => {
  const env = setup({ configured: false });
  assert.equal(env.inbound.enabled(), false);
  assert.equal(env.inbound.status().enabled, false);
  assert.match(env.inbound.status().setupNote, /GMAIL_OAUTH_/);
  await assert.rejects(() => env.inbound.pollOnce(), /not connected/);
});

t("a new customer email also queues the customer confirmation, sent once", async () => {
  const env = setup();
  env.put("g9", { from: "newcust@example.com", subject: "Help", text: "Help me" });
  await env.inbound.pollOnce();
  await env.mailer.runDue();
  const jobs = env.mailer.forTicket(env.service.listForAdmin().tickets[0].id);
  const confirm = jobs.find((j) => j.kind === "customer_confirmation");
  assert.equal(confirm.to, "newcust@example.com");
  assert.equal(confirm.status, "Sent");
  assert.match(confirm.subject, /^We received your support request – ON THE WAY LOGISTICS – OTW-SUP-/);
});

t("the sent message is built as a valid base64url RFC 2822 message with the photo attached", () => {
  const { raw, messageId } = buildRawMessage({
    from: "supportontheway@gmail.com",
    to: "customer@example.com",
    cc: "admin@example.com",
    subject: "New Support Ticket – ON THE WAY LOGISTICS – OTW-SUP-20261117-0001",
    text: "Problem: app blank",
    inReplyTo: "<earlier@ontheway>",
    attachments: [{ filename: "p.jpg", content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) }],
  });
  const text = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(text, /^From: ON THE WAY LOGISTICS Support <supportontheway@gmail.com>/m);
  assert.match(text, /^To: customer@example.com/m);
  assert.match(text, /^Cc: admin@example.com/m);
  assert.match(text, /^Subject: =\?UTF-8\?B\?/m, "non-ASCII subject is encoded");
  assert.match(text, /^In-Reply-To: <earlier@ontheway>/m);
  assert.match(text, /^Message-ID: <.+@supportontheway\.gmail\.com>|^Message-ID: <.+>/m);
  assert.match(text, /Content-Type: multipart\/mixed/);
  assert.match(text, /filename="p\.jpg"/);
  assert.ok(messageId.startsWith("<") && messageId.endsWith(">"));
});

t("sending through the Gmail API posts the raw message and reports every recipient as accepted", async () => {
  const posts = [];
  const fetchImpl = async (url, opts = {}) => {
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
    if (url.endsWith("/messages/send")) {
      posts.push(JSON.parse(opts.body));
      return json({ id: "gm-123", threadId: "th" });
    }
    return json({ error: { message: "unexpected" } }, 500);
  };
  const api = createGmailApi({ config: { clientId: "c", clientSecret: "s", refreshToken: "r", supportAddress: "supportontheway@gmail.com" }, fetchImpl, log: quiet });
  const out = await api.sendMail({ to: "a@example.com", cc: "admin@example.com", subject: "Hi", text: "Body" });
  assert.equal(posts.length, 1);
  assert.ok(posts[0].raw.length > 20);
  assert.deepEqual(out.accepted, ["a@example.com", "admin@example.com"]);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.gmailId, "gm-123");
  assert.ok(out.messageId.startsWith("<"));
});

t("a Gmail send refused for missing permission says how to fix it, without showing any secret", async () => {
  const fetchImpl = async (url) => {
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
    return json({ error: { message: "Request had insufficient authentication scopes." } }, 403);
  };
  const api = createGmailApi({ config: { clientId: "c", clientSecret: "SECRET-VALUE", refreshToken: "r", supportAddress: "x@y" }, fetchImpl, log: quiet });
  await assert.rejects(
    () => api.sendMail({ to: "a@example.com", subject: "x", text: "y" }),
    (e) => /gmail-authorize\.js/.test(e.message) && !/SECRET-VALUE/.test(e.message),
  );
});

t("a revoked refresh token gives a clear message and does not expose the token", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "Token has been expired or revoked." }) });
  const api = createGmailApi({ config: { clientId: "c", clientSecret: "s", refreshToken: "REFRESH-SECRET", supportAddress: "x@y" }, fetchImpl, log: quiet });
  await assert.rejects(() => api.sendMail({ to: "a@example.com", subject: "x", text: "y" }), (e) => /revoked|expired/.test(e.message) && !/REFRESH-SECRET/.test(e.message));
});
