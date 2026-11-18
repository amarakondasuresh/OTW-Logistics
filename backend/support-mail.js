// Support email outbox. Every support email is a row in support_email_jobs, so its status is always visible
// and it survives a restart.
//
//   Pending   queued, not tried yet
//   Sending   a send attempt is in progress
//   Sent      the SMTP server accepted the message for every recipient (acceptance, not final delivery)
//   Retrying  an attempt failed; another attempt is scheduled automatically
//   Failed    every automatic attempt failed; an admin can retry it by hand
//
// Email status is kept apart from the ticket's own status. A job is marked Sent only when the server's reply
// lists every recipient as accepted. Nothing is shown as Sent otherwise.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const EMAIL_STATUSES = ["Pending", "Sending", "Sent", "Retrying", "Failed"];
// Waiting time before attempts 2, 3, 4, 5 and 6 (seconds). After the sixth failed attempt the job is Failed.
export const RETRY_DELAYS_SEC = [60, 300, 900, 3600, 7200];
export const MAX_AUTO_ATTEMPTS = RETRY_DELAYS_SEC.length + 1;

const splitAddresses = (v) =>
  String(v || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
const normal = (a) => a.trim().toLowerCase();

export function createSupportMailer({ db, transport, uploadDir, log = console, now = () => new Date() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_email_jobs(
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      cc_addr TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      attachment_path TEXT NOT NULL DEFAULT '',
      attachment_name TEXT NOT NULL DEFAULT '',
      in_reply_to TEXT NOT NULL DEFAULT '',
      source_event_id INTEGER,
      status TEXT NOT NULL DEFAULT 'Pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT ${MAX_AUTO_ATTEMPTS},
      next_attempt_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      accepted TEXT NOT NULL DEFAULT '',
      rejected TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      UNIQUE(ticket_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS support_email_due ON support_email_jobs(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS support_email_attempts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS support_email_attempts_job ON support_email_attempts(job_id, id);
  `);
  // Every attempt is written to the log, so the full history of an email can be read later.
  const logAttempt = (jobId, attemptNo, outcome, detail) =>
    db
      .prepare("INSERT INTO support_email_attempts(job_id,attempt_no,at,outcome,detail) VALUES(?,?,?,?,?)")
      .run(jobId, attemptNo, new Date().toISOString(), outcome, String(detail || "").slice(0, 500));

  const iso = () => now().toISOString();
  const rowOf = (id) => db.prepare("SELECT * FROM support_email_jobs WHERE id=?").get(id);

  // Queues an email. A job with the same ticket and dedupeKey already exists -> returns it, nothing new is queued.
  function enqueue({ ticketId, dedupeKey, kind, to, cc = [], subject, body, attachment = null, inReplyTo = "", sourceEventId = null }) {
    const existing = db.prepare("SELECT * FROM support_email_jobs WHERE ticket_id=? AND dedupe_key=?").get(ticketId, dedupeKey);
    if (existing) return { job: existing, created: false };
    const at = iso();
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO support_email_jobs(id,ticket_id,dedupe_key,kind,to_addr,cc_addr,subject,body,attachment_path,attachment_name,
        in_reply_to,source_event_id,status,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      ticketId,
      dedupeKey,
      kind,
      splitAddresses(to).join(", "),
      splitAddresses(cc).join(", "),
      subject,
      body,
      attachment ? attachment.path : "",
      attachment ? attachment.name : "",
      inReplyTo,
      sourceEventId,
      "Pending",
      at,
      at,
      at,
    );
    return { job: rowOf(id), created: true };
  }

  // Atomically claims a job for sending. Two workers cannot both claim the same job.
  function claim(id) {
    const at = iso();
    const r = db
      .prepare(
        "UPDATE support_email_jobs SET status='Sending', attempts=attempts+1, updated_at=? WHERE id=? AND status IN ('Pending','Retrying') AND next_attempt_at<=?",
      )
      .run(at, id, at);
    return r.changes === 1;
  }

  function recipientsOf(job) {
    return [...splitAddresses(job.to_addr), ...splitAddresses(job.cc_addr)];
  }

  // Sends one job. Resolves with the job's new row. Never throws for a delivery problem.
  async function attempt(id) {
    if (!claim(id)) return publicJob(rowOf(id));
    const job = rowOf(id);
    const at = iso();
    try {
      const message = {
        to: job.to_addr,
        cc: job.cc_addr || undefined,
        subject: job.subject,
        text: job.body,
        headers: { "X-OTW-Ticket": job.ticket_id },
      };
      if (job.in_reply_to) {
        message.inReplyTo = job.in_reply_to;
        message.references = job.in_reply_to;
      }
      if (job.attachment_path) {
        const abs = path.join(uploadDir, job.attachment_path);
        if (!abs.startsWith(path.join(uploadDir, "support") + path.sep)) throw new Error("Attachment path is not allowed.");
        message.attachments = [{ filename: job.attachment_name || "photo", content: fs.readFileSync(abs) }];
      }
      const info = await transport.sendMail(message);
      const accepted = (info.accepted || []).map((a) => String(a));
      const rejected = (info.rejected || []).map((a) => String(a));
      const missing = recipientsOf(job).filter((r) => !accepted.some((a) => normal(a) === normal(r)));
      if (rejected.length || missing.length || !accepted.length)
        throw new Error(
          `The mail server did not accept ${[...rejected, ...missing].join(", ") || "any recipient"}`,
        );
      db.prepare(
        "UPDATE support_email_jobs SET status='Sent', message_id=?, accepted=?, rejected='', last_error='', sent_at=?, updated_at=? WHERE id=?",
      ).run(info.messageId || "", accepted.join(", "), at, at, id);
      // Link this email's Message-ID to the conversation entry it came from, so customer replies thread back.
      if (job.source_event_id && info.messageId)
        db.prepare("UPDATE support_ticket_events SET message_id=? WHERE id=?").run(info.messageId, job.source_event_id);
      logAttempt(id, job.attempts, "Sent", info.messageId || "accepted");
      log.log?.(`[support-email] ${job.kind} ${job.ticket_id} accepted by the server (${info.messageId || "no id"})`);
    } catch (e) {
      const row = rowOf(id);
      const failedAt = now();
      const gaveUp = row.attempts >= row.max_attempts;
      const delay = RETRY_DELAYS_SEC[row.attempts - 1] || RETRY_DELAYS_SEC.at(-1);
      const nextAt = new Date(failedAt.getTime() + delay * 1000).toISOString();
      db.prepare(
        "UPDATE support_email_jobs SET status=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?",
      ).run(gaveUp ? "Failed" : "Retrying", String(e.message || e).slice(0, 500), gaveUp ? row.next_attempt_at : nextAt, at, id);
      logAttempt(id, row.attempts, gaveUp ? "Failed" : "Retrying", e.message);
      log.error?.(
        `[support-email] ${job.kind} ${job.ticket_id} attempt ${row.attempts} failed: ${e.message}` +
          (gaveUp ? " (no more automatic attempts)" : `, retry at ${nextAt}`),
      );
    }
    return publicJob(rowOf(id));
  }

  // Sends every job that is due. Called on a timer and after each admin action.
  async function runDue(limit = 25) {
    const at = iso();
    // A job left in Sending by a crash during a send is put back to Retrying.
    db.prepare("UPDATE support_email_jobs SET status='Retrying', next_attempt_at=? WHERE status='Sending' AND updated_at<?").run(
      at,
      new Date(now().getTime() - 10 * 60_000).toISOString(),
    );
    const due = db
      .prepare("SELECT id FROM support_email_jobs WHERE status IN ('Pending','Retrying') AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT ?")
      .all(at, limit);
    const out = [];
    for (const { id } of due) out.push(await attempt(id));
    return out;
  }

  // An admin asks for another try on a Failed job. It is queued and sent at once.
  async function retry(id) {
    const row = rowOf(id);
    if (!row) return null;
    if (row.status !== "Failed") throw new Error("Only a failed email can be retried.");
    db.prepare(
      "UPDATE support_email_jobs SET status='Pending', max_attempts=attempts+1, next_attempt_at=?, updated_at=? WHERE id=?",
    ).run(iso(), iso(), id);
    return attempt(id);
  }

  function forTicket(ticketId) {
    return db
      .prepare("SELECT * FROM support_email_jobs WHERE ticket_id=? ORDER BY created_at")
      .all(ticketId)
      .map(publicJob);
  }

  // Status of the notification for a new ticket, shown next to the ticket's own status.
  function newTicketStatus(ticketId) {
    const r = db.prepare("SELECT * FROM support_email_jobs WHERE ticket_id=? AND dedupe_key='new'").get(ticketId);
    return r ? publicJob(r) : null;
  }

  function failedCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM support_email_jobs WHERE status='Failed'").get().n;
  }

  function attemptsFor(jobId) {
    return db
      .prepare("SELECT attempt_no, at, outcome, detail FROM support_email_attempts WHERE job_id=? ORDER BY id")
      .all(jobId)
      .map((a) => ({ attemptNo: a.attempt_no, at: a.at, outcome: a.outcome, detail: a.detail }));
  }

  function publicJob(r) {
    return {
      id: r.id,
      ticketId: r.ticket_id,
      kind: r.kind,
      to: r.to_addr,
      cc: r.cc_addr,
      subject: r.subject,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      messageId: r.message_id,
      nextAttemptAt: r.status === "Retrying" ? r.next_attempt_at : "",
      sentAt: r.sent_at || "",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      canRetry: r.status === "Failed",
      attemptLog: attemptsFor(r.id),
    };
  }

  return { enqueue, attempt, runDue, retry, forTicket, newTicketStatus, failedCount, publicJob, rowOf };
}
