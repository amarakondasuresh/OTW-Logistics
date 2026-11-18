// HTTP routes for Helpline / Support. Storage: support-tickets.js. Email: support-mail.js. Incoming Gmail:
// support-inbound.js. Email wording: support-email-text.js.
//
//   POST /api/support                            Vendor / Franchise / public form: saves a ticket, emails support + admin
//   GET  /api/support/mine                       partner: own tickets and their status
//   GET  /api/support/mine/:id                   partner: one own ticket and its replies
//   GET  /api/support/mine/:id/photo             partner: photo of an own ticket
//   POST /api/support/mine/:id/messages          partner: follow-up on an own ticket (emails support + admin)
//   GET  /api/admin/support/tickets              admin: summary and table (filters: status, portal, q)
//   GET  /api/admin/support/tickets/:id          admin: ticket, full communication history, email jobs
//   GET  /api/admin/support/tickets/:id/photo    admin: photo
//   POST /api/admin/support/tickets/:id/reply    admin: saves the reply and emails it to the customer
//   POST /api/admin/support/tickets/:id/status   admin: ticket status (kept separate from email status)
//   POST /api/admin/support/emails/:jobId/retry  admin: retry a Failed email
//   GET  /api/admin/support/inbound              admin: incoming Gmail connection status
//   POST /api/admin/support/inbound/check        admin: check the support inbox now
import fs from "node:fs";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { partnerPortalType, SUPPORT_PHOTO_MAX_BYTES, SUPPORT_STATUSES, SupportError } from "./support-tickets.js";
import {
  FOLLOWUP_SUBJECT,
  followUpBody,
  NEW_TICKET_SUBJECT,
  newTicketBody,
  REPLY_SUBJECT,
  replyBody,
} from "./support-email-text.js";

const PHONE_OK = /^[6-9]\d{9}$/;
const EMAIL_OK = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

// What the person who submitted sees about the email, in plain words. Only "Sent" means the server accepted it.
function emailSentence(job) {
  if (!job) return "";
  if (job.status === "Sent") return "Our support team has been emailed about it.";
  if (job.status === "Failed")
    return "The email alert to our team failed, so the team will look at your ticket in the portal.";
  return "The email alert is queued and will be retried automatically.";
}

export function registerSupportRoutes(app, { auth, service, mailer, inbound, supportEmail, adminRecipients, baseUrl = "" }) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SUPPORT_PHOTO_MAX_BYTES, files: 1, fields: 12, fieldSize: 20000 },
  });

  // Ten submissions every ten minutes per signed-in account (per IP when nobody is signed in).
  // Requests that fail validation are not counted.
  const submitLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req) => {
      const s = auth.getSession(req, "vendor") || auth.getSession(req, "franchise");
      return s ? `acct:${s.account.id}` : `ip:${req.ip}`;
    },
    message: {
      error: "You have sent several support requests in a short time. Please wait about ten minutes, then try again.",
    },
  });

  const partnerGuard = (req, res, next) => {
    const s = auth.getSession(req, "vendor") || auth.getSession(req, "franchise");
    if (!s) return res.status(401).json({ error: "Please sign in again.", code: "NOT_SIGNED_IN" });
    if (s.account.must_change_password)
      return res.status(403).json({ error: "Please set a new password first.", code: "PASSWORD_CHANGE_REQUIRED" });
    req.partner = s.account;
    next();
  };
  const adminGuard = auth.requireRole("admin");

  const fail = (res, err, context) => {
    if (err instanceof SupportError)
      return res.status(err.status).json({ error: err.message, ...(err.field ? { field: err.field } : {}) });
    console.error(context, err && err.message);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  };

  const admins = () => adminRecipients().filter(Boolean);
  const copyList = () => admins().filter((a) => a.toLowerCase() !== supportEmail.toLowerCase());
  const submittedEventId = (ticketId) => service.events(ticketId).find((e) => e.kind === "submitted")?.id ?? null;
  // Message-ID of the latest email we sent or received on this ticket, so the next email threads under it.
  const lastMessageId = (ticketId) => {
    const ids = service.events(ticketId).filter((e) => e.messageId);
    return ids.length ? ids[ids.length - 1].messageId : "";
  };

  // Queues the support copy and the customer confirmation (once per ticket), then tries them straight away.
  // Returns { newTicket, confirmation } as public job rows (or null when a job is missing).
  async function notifyNewTicket(ticket) {
    inbound.queueTicketEmails(ticket);
    const jobs = mailer.forTicket(ticket.id);
    for (const j of jobs) if (j.status === "Pending") await mailer.attempt(j.id);
    const now = mailer.forTicket(ticket.id);
    return {
      newTicket: now.find((j) => j.kind === "new_ticket") || null,
      confirmation: now.find((j) => j.kind === "customer_confirmation") || null,
    };
  }

  // ----- public submit (Vendor, Franchise, or not signed in) -----
  app.post("/api/support", submitLimiter, (req, res) => {
    upload.single("photo")(req, res, async (err) => {
      if (err)
        return res.status(400).json({
          error:
            err.code === "LIMIT_FILE_SIZE"
              ? "The photo is too large. Please attach an image under 8 MB."
              : "Could not read the attached photo. Please try another image.",
        });
      try {
        const sentPortal = String(req.body?.portal || "");
        const fromForm = sentPortal.startsWith("Vendor") ? "Vendor" : sentPortal.startsWith("Franchise") ? "Franchise" : "Unknown";
        // A request sent from a partner portal must come from a signed-in account of that same portal. It is never
        // saved without an account, because no partner could see it afterwards.
        const vendorSession = auth.getSession(req, "vendor");
        const franchiseSession = auth.getSession(req, "franchise");
        const signed =
          fromForm === "Vendor" ? vendorSession : fromForm === "Franchise" ? franchiseSession : vendorSession || franchiseSession;
        if (fromForm !== "Unknown" && !signed)
          return res.status(401).json({
            error: `Please sign in to the ${fromForm} Portal again, then send your request.`,
            code: "NOT_SIGNED_IN",
          });
        if (signed && signed.account.must_change_password)
          return res.status(403).json({ error: "Please set a new password first.", code: "PASSWORD_CHANGE_REQUIRED" });
        const portalType = signed ? partnerPortalType(signed.account.role) : fromForm;
        const oneLine = (v) => String(v || "").replace(/[\r\n]+/g, " ").trim();
        const name = oneLine(req.body?.name).slice(0, service.TEXT_LIMITS.name);
        const email = oneLine(req.body?.email).slice(0, service.TEXT_LIMITS.email);
        const phone = oneLine(req.body?.phone).slice(0, service.TEXT_LIMITS.phone);
        const description = String(req.body?.description || "").trim().slice(0, service.TEXT_LIMITS.description);
        const photo = req.file;
        if (!name || !email || !description || !photo)
          return res.status(400).json({ error: "Please provide your name, email, problem description, and a photo." });
        if (/\d/.test(name)) return res.status(400).json({ error: "The name cannot contain numbers.", field: "name" });
        let phoneDigits = phone.replace(/\D/g, "");
        if (phoneDigits.length === 12 && phoneDigits.startsWith("91")) phoneDigits = phoneDigits.slice(2);
        if (phoneDigits.length === 11 && phoneDigits.startsWith("0")) phoneDigits = phoneDigits.slice(1);
        if (phone && !PHONE_OK.test(phoneDigits))
          return res.status(400).json({ error: "The contact number must be a 10-digit mobile number.", field: "phone" });
        if (!EMAIL_OK.test(email)) return res.status(400).json({ error: "Please provide a valid email address.", field: "email" });

        const submissionKey = /^[A-Za-z0-9-]{8,64}$/.test(req.body?.submissionId || "") ? req.body.submissionId : null;
        const created = service.create({
          portalType,
          signedIn: !!signed,
          account: signed ? signed.account : null,
          name,
          email,
          phone: phoneDigits.length === 10 ? phoneDigits : phone,
          description,
          photo,
          submissionKey,
        });
        const ticket = created.ticket;
        // A repeated submission reports the email status it already has. Nothing is emailed twice.
        const jobs = created.duplicate
          ? { newTicket: mailer.newTicketStatus(ticket.id), confirmation: null }
          : await notifyNewTicket(ticket);
        const job = jobs.newTicket;
        const confirm = jobs.confirmation;
        return res.status(created.duplicate ? 200 : 201).json({
          ok: true,
          duplicate: created.duplicate,
          ticketId: ticket.ticket_no,
          emailStatus: job ? job.status : "Not queued",
          emailSent: !!job && job.status === "Sent",
          emailError: job && job.status !== "Sent" ? job.lastError : "",
          customerEmailStatus: confirm ? confirm.status : "Not queued",
          adminCopy: copyList().length > 0,
          message:
            `${created.duplicate ? "This request was already received." : "Your issue has been submitted."} ` +
            `Your Ticket ID is ${ticket.ticket_no}. ${emailSentence(job)}` +
            (confirm && confirm.status === "Sent" ? " A confirmation has been sent to your email address." : ""),
        });
      } catch (e) {
        fail(res, e, "Support submission failed:");
      }
    });
  });

  // ----- partner (Vendor / Franchise) -----
  app.get("/api/support/mine", partnerGuard, (req, res) => {
    res.json({ tickets: service.listForAccount(req.partner) });
  });
  app.get("/api/support/mine/:id", partnerGuard, (req, res) => {
    try {
      res.json(service.getForAccount(req.params.id, req.partner));
    } catch (e) {
      fail(res, e, "Support ticket read failed:");
    }
  });
  app.get("/api/support/mine/:id/photo", partnerGuard, (req, res) => {
    sendPhoto(req, res, (id) => service.rowForAccount(id, req.partner));
  });
  app.post("/api/support/mine/:id/messages", partnerGuard, async (req, res) => {
    try {
      const body = String(req.body?.message || "");
      const out = service.partnerFollowUp(req.params.id, req.partner, body);
      const ticket = out.ticket;
      const { job } = mailer.enqueue({
        ticketId: ticket.id,
        dedupeKey: `followup:${out.eventId}`,
        kind: "followup",
        to: supportEmail,
        cc: copyList(),
        subject: FOLLOWUP_SUBJECT(ticket.ticket_no),
        body: followUpBody({ ...ticket, ticket_no: ticket.ticket_no, customer_name: ticket.customer_name, portal_type: ticket.portal_type }, {
          author: req.partner.login_id,
          text: body.trim(),
          baseUrl,
        }),
        sourceEventId: null,
      });
      await mailer.attempt(job.id);
      res.json(out.detail);
    } catch (e) {
      fail(res, e, "Support follow-up failed:");
    }
  });

  // ----- admin -----
  app.get("/api/admin/support/tickets", adminGuard, (req, res) => {
    const out = service.listForAdmin({
      status: String(req.query.status || ""),
      portal: String(req.query.portal || ""),
      q: String(req.query.q || "").slice(0, 120),
    });
    out.tickets = out.tickets.map((t) => ({ ...t, newTicketEmail: mailer.newTicketStatus(t.id) }));
    out.summary = { ...out.summary, failedEmails: mailer.failedCount() };
    res.json(out);
  });
  app.get("/api/admin/support/tickets/:id", adminGuard, (req, res) => {
    try {
      const d = service.getForAdmin(req.params.id);
      res.json({ ...d, emailJobs: mailer.forTicket(d.ticket.id) });
    } catch (e) {
      fail(res, e, "Support ticket read failed:");
    }
  });
  app.get("/api/admin/support/tickets/:id/photo", adminGuard, (req, res) => {
    sendPhoto(req, res, (id) => service.rowById(id));
  });
  app.post("/api/admin/support/tickets/:id/reply", adminGuard, async (req, res) => {
    try {
      const actor = req.adminEmail || req.account.login_id;
      const out = service.adminReply(req.params.id, actor, req.body?.message);
      const t = out.ticket;
      const { job } = mailer.enqueue({
        ticketId: t.id,
        dedupeKey: `reply:${out.eventId}`,
        kind: "customer_reply",
        to: t.email,
        subject: REPLY_SUBJECT(t.ticket_no),
        body: replyBody(t.ticket_no, String(req.body?.message || "").trim()),
        inReplyTo: lastMessageId(t.id),
        sourceEventId: out.eventId,
      });
      const sent = await mailer.attempt(job.id);
      res.json({ ...service.getForAdmin(t.id), emailJobs: mailer.forTicket(t.id), replyEmail: sent });
    } catch (e) {
      fail(res, e, "Support reply failed:");
    }
  });
  app.post("/api/admin/support/tickets/:id/status", adminGuard, (req, res) => {
    try {
      const status = String(req.body?.status || "");
      if (!SUPPORT_STATUSES.includes(status)) throw new SupportError(400, "Unknown status.", "status");
      const actor = req.adminEmail || req.account.login_id;
      const d = service.setStatus(req.params.id, actor, status, req.body?.note);
      res.json({ ...d, emailJobs: mailer.forTicket(d.ticket.id) });
    } catch (e) {
      fail(res, e, "Support status change failed:");
    }
  });
  app.post("/api/admin/support/emails/:jobId/retry", adminGuard, async (req, res) => {
    try {
      const job = await mailer.retry(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Email not found." });
      res.json({ job });
    } catch (e) {
      if (/Only a failed/.test(e.message)) return res.status(409).json({ error: e.message });
      fail(res, e, "Email retry failed:");
    }
  });
  app.get("/api/admin/support/inbound", adminGuard, (req, res) => {
    res.json(inbound.status());
  });
  app.post("/api/admin/support/inbound/check", adminGuard, async (req, res) => {
    if (!inbound.enabled()) return res.status(409).json({ error: inbound.status().setupNote });
    const handled = await inbound.pollOnce();
    res.json({ ...inbound.status(), handled });
  });

  // Streams a photo only after the caller's access check. Never public.
  function sendPhoto(req, res, lookup) {
    try {
      const row = lookup(req.params.id);
      if (!row) return res.status(404).json({ error: "Photo not found." });
      const file = service.photoFor(row);
      if (!file || !fs.existsSync(file.abs)) return res.status(404).json({ error: "Photo not found." });
      res.set({
        "Content-Type": file.mime,
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${row.ticket_no}.${file.mime.split("/")[1]}"`,
      });
      const stream = fs.createReadStream(file.abs);
      stream.on("error", () => {
        if (!res.headersSent) res.status(404).json({ error: "Photo not found." });
        else res.end();
      });
      stream.pipe(res);
    } catch (e) {
      fail(res, e, "Support photo failed:");
    }
  }
}
