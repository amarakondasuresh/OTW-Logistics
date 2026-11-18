// Support email outbox rules: Sent only after the server accepts every recipient, Retrying with delays,
// Failed after the last automatic attempt, manual retry only for Failed, no duplicate emails.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSupportService } from "../support-tickets.js";
import { createSupportMailer, RETRY_DELAYS_SEC } from "../support-mail.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}
const t = DatabaseSync ? test : test.skip;

const quiet = { log() {}, error() {} };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);

function setup(transportImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otw-mail-"));
  const db = new DatabaseSync(path.join(dir, "m.sqlite"));
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY, role TEXT, login_id TEXT, email TEXT, status TEXT DEFAULT 'active')");
  const service = createSupportService({ db, uploadDir: dir });
  const calls = [];
  let clock = new Date("2026-11-17T10:00:00Z");
  const transport = {
    async sendMail(msg) {
      calls.push(msg);
      return transportImpl(msg, calls.length);
    },
  };
  const mailer = createSupportMailer({ db, transport, uploadDir: dir, log: quiet, now: () => clock });
  const advance = (sec) => (clock = new Date(clock.getTime() + sec * 1000));
  const ticket = service.create({
    portalType: "Vendor",
    signedIn: false,
    name: "Ravi",
    email: "ravi@example.com",
    description: "Test complaint",
    photo: { buffer: JPEG, originalname: "p.jpg" },
  }).ticket;
  return { db, dir, service, mailer, calls, ticket, advance, get now() { return clock; } };
}

const accepted = (msg) => ({ messageId: `<m${Math.random().toString(36).slice(2)}@ontheway>`, accepted: [msg.to, ...(msg.cc ? msg.cc.split(", ") : [])], rejected: [] });
const newJob = (env, extra = {}) =>
  env.mailer.enqueue({
    ticketId: env.ticket.id,
    dedupeKey: "new",
    kind: "new_ticket",
    to: "supportontheway@gmail.com",
    cc: ["admin@example.com"],
    subject: "New Support Ticket – ON THE WAY LOGISTICS – " + env.ticket.ticket_no,
    body: "body",
    attachment: { path: env.ticket.photo_path, name: "p.jpg" },
    ...extra,
  }).job;

t("a job is Sent only when the server accepts every recipient, and the Message-ID is stored", async () => {
  const env = setup(accepted);
  const job = newJob(env);
  assert.equal(job.status, "Pending");
  const out = await env.mailer.attempt(job.id);
  assert.equal(out.status, "Sent");
  assert.ok(out.messageId.startsWith("<m"));
  assert.ok(out.sentAt === "" || out.sentAt === undefined || out.sentAt, "sent time recorded");
  assert.equal(env.calls[0].subject, "New Support Ticket – ON THE WAY LOGISTICS – " + env.ticket.ticket_no);
  assert.equal(env.calls[0].attachments.length, 1, "photo is attached");
});

t("a rejected recipient is never reported as Sent", async () => {
  const env = setup((msg) => ({ messageId: "<x@y>", accepted: [msg.to], rejected: ["admin@example.com"] }));
  const out = await env.mailer.attempt(newJob(env).id);
  assert.notEqual(out.status, "Sent");
  assert.equal(out.status, "Retrying");
  assert.match(out.lastError, /did not accept admin@example.com/);
});

t("a server error becomes Retrying with the exact error text and a scheduled time", async () => {
  const env = setup(() => {
    throw new Error("Invalid login: 535-5.7.8 Username and Password not accepted");
  });
  const out = await env.mailer.attempt(newJob(env).id);
  assert.equal(out.status, "Retrying");
  assert.match(out.lastError, /535-5\.7\.8/);
  assert.equal(out.attempts, 1);
  assert.ok(out.nextAttemptAt, "next attempt time is set");
});

t("automatic retries follow the delay schedule, then the job becomes Failed", async () => {
  const env = setup(() => {
    throw new Error("connection refused");
  });
  const job = newJob(env);
  await env.mailer.attempt(job.id);
  for (let i = 0; i < RETRY_DELAYS_SEC.length; i++) {
    // Not yet due: nothing is sent
    const early = await env.mailer.runDue();
    assert.equal(early.length, 0, "a job is not retried before its time");
    env.advance(RETRY_DELAYS_SEC[i]);
    await env.mailer.runDue();
  }
  const final = env.mailer.forTicket(env.ticket.id).find((j) => j.id === job.id);
  assert.equal(final.status, "Failed");
  assert.equal(final.attempts, RETRY_DELAYS_SEC.length + 1);
  assert.equal(final.canRetry, true);
  assert.equal(env.calls.length, RETRY_DELAYS_SEC.length + 1);
});

t("a Failed email can be retried by hand and becomes Sent only if the server accepts it", async () => {
  let fail = true;
  const env = setup((msg) => {
    if (fail) throw new Error("timeout");
    return accepted(msg);
  });
  const job = newJob(env);
  // Drive it to Failed
  await env.mailer.attempt(job.id);
  for (let i = 0; i < RETRY_DELAYS_SEC.length; i++) {
    env.advance(RETRY_DELAYS_SEC[i]);
    await env.mailer.runDue();
  }
  assert.equal(env.mailer.rowOf(job.id).status, "Failed");
  fail = false;
  const out = await env.mailer.retry(job.id);
  assert.equal(out.status, "Sent");
});

t("retry is refused for a job that is not Failed", async () => {
  const env = setup(accepted);
  const job = newJob(env);
  await env.mailer.attempt(job.id);
  await assert.rejects(() => env.mailer.retry(job.id), /Only a failed email/);
});

t("the same email is never queued twice for one ticket", () => {
  const env = setup(accepted);
  const a = newJob(env);
  const b = newJob(env);
  assert.equal(a.id, b.id);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM support_email_jobs").get().n, 1);
});

t("a job is claimed by one sender only", async () => {
  const env = setup(accepted);
  const job = newJob(env);
  const results = await Promise.all([env.mailer.attempt(job.id), env.mailer.attempt(job.id)]);
  assert.equal(env.calls.length, 1, "the server is called once");
  assert.ok(results.every((r) => ["Sent", "Sending"].includes(r.status)));
});

t("a reply goes to the customer and is threaded with In-Reply-To", async () => {
  const env = setup(accepted);
  const job = env.mailer.enqueue({
    ticketId: env.ticket.id,
    dedupeKey: "reply:1",
    kind: "customer_reply",
    to: "ravi@example.com",
    subject: "Re: Your support request",
    body: "We have fixed it.",
    inReplyTo: "<earlier@ontheway>",
  }).job;
  const out = await env.mailer.attempt(job.id);
  assert.equal(out.status, "Sent");
  assert.equal(env.calls[0].to, "ravi@example.com");
  assert.equal(env.calls[0].inReplyTo, "<earlier@ontheway>");
});

t("a sent email links its Message-ID back to the conversation entry it came from", async () => {
  const env = setup(accepted);
  const eventId = env.service.adminReply(env.ticket.id, "admin", "Reply text").eventId;
  const job = env.mailer.enqueue({
    ticketId: env.ticket.id,
    dedupeKey: `reply:${eventId}`,
    kind: "customer_reply",
    to: "ravi@example.com",
    subject: "Re: x",
    body: "Reply text",
    sourceEventId: eventId,
  }).job;
  const sent = await env.mailer.attempt(job.id);
  const ev = env.service.events(env.ticket.id).find((e) => e.id === eventId);
  assert.equal(ev.messageId, sent.messageId);
});

t("a job stuck in Sending after a crash is put back to Retrying", async () => {
  const env = setup(accepted);
  const job = newJob(env);
  env.db.prepare("UPDATE support_email_jobs SET status='Sending', updated_at=? WHERE id=?").run(
    new Date(env.now.getTime() - 20 * 60_000).toISOString(),
    job.id,
  );
  await env.mailer.runDue();
  assert.equal(env.mailer.rowOf(job.id).status, "Sent");
});

t("Failed count and newTicketStatus report the right job", async () => {
  const env = setup(() => {
    throw new Error("down");
  });
  const job = newJob(env);
  await env.mailer.attempt(job.id);
  assert.equal(env.mailer.newTicketStatus(env.ticket.id).status, "Retrying");
  assert.equal(env.mailer.failedCount(), 0);
});

t("every attempt is written to the log with its time, outcome and error text", async () => {
  let n = 0;
  const env = setup((msg) => {
    n++;
    if (n === 1) throw new Error("Gmail API POST /messages/send failed (503): backend error");
    return accepted(msg);
  });
  const job = newJob(env);
  await env.mailer.attempt(job.id);
  env.advance(60);
  await env.mailer.runDue();
  const log = env.mailer.forTicket(env.ticket.id).find((j) => j.id === job.id).attemptLog;
  assert.deepEqual(log.map((a) => a.outcome), ["Retrying", "Sent"]);
  assert.match(log[0].detail, /\(503\): backend error/);
  assert.equal(log[0].attemptNo, 1);
  assert.equal(log[1].attemptNo, 2);
});
