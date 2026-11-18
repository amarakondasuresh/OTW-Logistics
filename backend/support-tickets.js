// Helpline / Support tickets: the single store behind the Admin Portal > Support Management page, the
// Vendor / Franchise portals' Helpline forms, and customer emails that arrive at the support Gmail.
//
// - Every request is saved here (support_tickets) with a unique ticket number such as OTW-SUP-20261117-0001,
//   before any email is sent. A failed email never loses a complaint.
// - Photos are written to backend/uploads/support/. Only the relative path is stored, so photos survive a restart.
// - Every message in the conversation is kept in support_ticket_events. Emails we send and receive keep their
//   Message-ID, so a customer's reply can be matched back to the right ticket.
// - Ticket status and email delivery status are separate. Email is handled in support-mail.js.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SUPPORT_STATUSES = ["New", "Pending", "In Progress", "Resolved", "Rejected", "Closed"];
export const SUPPORT_PORTAL_TYPES = ["Vendor", "Franchise", "Email", "Unknown"];
export const SUPPORT_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const TICKET_NO_PATTERN = /OTW-SUP-\d{8}-\d{4}/;
const PHOTO_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const TEXT_LIMITS = { name: 120, email: 254, phone: 30, description: 3000, reply: 3000, followUp: 2000 };
const FINISHED = ["Resolved", "Rejected", "Closed"];

export class SupportError extends Error {
  constructor(status, message, field = "") {
    super(message);
    this.status = status;
    this.field = field;
  }
}

// Checks the real file signature, not just the type the browser claims.
export function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  )
    return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// Indian date for the ticket number, so a late-night ticket keeps that day's number.
function istDay(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
export const sameAddress = (a, b) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// The portal a partner account belongs to. Only vendor and franchise accounts have My Support Requests.
export function partnerPortalType(role) {
  return role === "vendor" ? "Vendor" : role === "franchise" ? "Franchise" : null;
}

export function createSupportService({ db, uploadDir }) {
  fs.mkdirSync(path.join(uploadDir, "support"), { recursive: true, mode: 0o700 });

  db.exec(`
    CREATE TABLE IF NOT EXISTS support_tickets(
      id TEXT PRIMARY KEY,
      ticket_no TEXT NOT NULL UNIQUE,
      portal_type TEXT NOT NULL,
      signed_in INTEGER NOT NULL DEFAULT 0,
      account_id TEXT,
      account_login TEXT,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      description TEXT NOT NULL,
      photo_path TEXT NOT NULL,
      photo_mime TEXT NOT NULL,
      photo_name TEXT,
      photo_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'New',
      submission_key TEXT UNIQUE,
      submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      notify_status TEXT NOT NULL DEFAULT 'pending',
      notify_error TEXT
    );
    CREATE INDEX IF NOT EXISTS support_tickets_account ON support_tickets(account_id, submitted_at);
    CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets(status, submitted_at);
    CREATE INDEX IF NOT EXISTS support_tickets_portal ON support_tickets(account_id, portal_type, submitted_at);
    CREATE TABLE IF NOT EXISTS support_ticket_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      author_role TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT,
      status TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS support_events_ticket ON support_ticket_events(ticket_id, id);
    CREATE INDEX IF NOT EXISTS support_events_message ON support_ticket_events(message_id);
    CREATE TABLE IF NOT EXISTS support_counter(day TEXT PRIMARY KEY, last INTEGER NOT NULL);
  `);
  // Databases made by the previous version have no message_id column. Adding it changes no existing row.
  if (!db.prepare("PRAGMA table_info(support_ticket_events)").all().some((c) => c.name === "message_id"))
    db.exec("ALTER TABLE support_ticket_events ADD COLUMN message_id TEXT");

  // Runs fn in one transaction. Works with better-sqlite3 and node:sqlite alike.
  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  function nextTicketNo(now) {
    const day = istDay(now);
    const row = db.prepare("SELECT last FROM support_counter WHERE day=?").get(day);
    const last = (row ? row.last : 0) + 1;
    db.prepare(
      "INSERT INTO support_counter(day,last) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET last=excluded.last",
    ).run(day, last);
    return `OTW-SUP-${day.replace(/-/g, "")}-${String(last).padStart(4, "0")}`;
  }

  function addEvent(ticketId, { kind, authorRole, author, body = null, status = null, messageId = null }, at) {
    const r = db
      .prepare(
        "INSERT INTO support_ticket_events(ticket_id,kind,author_role,author,body,status,message_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(ticketId, kind, authorRole, author, body, status, messageId, at);
    return Number(r.lastInsertRowid);
  }

  function rowById(id) {
    return db.prepare("SELECT * FROM support_tickets WHERE id=?").get(String(id || ""));
  }
  function rowByNumber(no) {
    return db.prepare("SELECT * FROM support_tickets WHERE ticket_no=?").get(String(no || "").toUpperCase());
  }

  // Creates a ticket. A repeated submissionKey returns the existing ticket (double tap, retry, or the same
  // Gmail message seen twice), so nothing is saved or emailed twice.
  // photo is optional: pass null for a ticket made from an email with no attachment.
  function create({ portalType, signedIn, account, name, email, phone, description, photo, submissionKey, subject }) {
    if (submissionKey) {
      const existing = db.prepare("SELECT * FROM support_tickets WHERE submission_key=?").get(submissionKey);
      if (existing) return { ticket: existing, duplicate: true };
    }
    // A ticket can only belong to an account of the portal it was sent from.
    if (account) {
      const owner = partnerPortalType(account.role);
      if (owner && portalType !== owner)
        throw new SupportError(403, "This request does not match the portal you are signed in to.");
    }
    let mime = "";
    if (photo) {
      mime = detectImageType(photo.buffer) || "";
      if (!mime) throw new SupportError(400, "The attachment must be a JPG, PNG or WEBP image.", "photo");
      if (photo.buffer.length > SUPPORT_PHOTO_MAX_BYTES)
        throw new SupportError(400, "The photo is too large. Please attach an image under 8 MB.", "photo");
    }
    const id = crypto.randomUUID();
    const now = new Date();
    const at = now.toISOString();
    const photoRel = photo ? path.join("support", `${id}.${PHOTO_EXT[mime]}`) : "";
    const photoAbs = photo ? path.join(uploadDir, photoRel) : "";
    if (photo) fs.writeFileSync(photoAbs, photo.buffer, { mode: 0o600 });
    const text = String(description || "").trim().slice(0, TEXT_LIMITS.description);
    try {
      const ticket = tx(() => {
        const ticketNo = nextTicketNo(now);
        db.prepare(`INSERT INTO support_tickets(
            id,ticket_no,portal_type,signed_in,account_id,account_login,customer_name,email,phone,description,
            photo_path,photo_mime,photo_name,photo_size,status,submission_key,submitted_at,updated_at,notify_status)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id,
          ticketNo,
          portalType,
          signedIn ? 1 : 0,
          account ? account.id : null,
          account ? account.login_id : null,
          clean(name, TEXT_LIMITS.name) || clean(email, TEXT_LIMITS.email),
          clean(email, TEXT_LIMITS.email),
          clean(phone, TEXT_LIMITS.phone) || null,
          text,
          photoRel,
          mime,
          photo ? path.basename(photo.originalname || "support-photo").slice(0, 100) : clean(subject, 120),
          photo ? photo.buffer.length : 0,
          "New",
          submissionKey || null,
          at,
          at,
          "pending",
        );
        addEvent(
          id,
          {
            kind: "submitted",
            authorRole: portalType === "Vendor" || portalType === "Franchise" ? portalType.toLowerCase() : "customer",
            author: account ? account.login_id : clean(email, TEXT_LIMITS.email),
            body: text,
          },
          at,
        );
        return db.prepare("SELECT * FROM support_tickets WHERE id=?").get(id);
      });
      return { ticket, duplicate: false };
    } catch (e) {
      if (photoAbs) fs.rmSync(photoAbs, { force: true });
      if (submissionKey && /UNIQUE/i.test(String(e.message))) {
        const existing = db.prepare("SELECT * FROM support_tickets WHERE submission_key=?").get(submissionKey);
        if (existing) return { ticket: existing, duplicate: true };
      }
      throw e;
    }
  }

  // The conversation for one ticket, oldest first.
  function events(ticketId) {
    return db
      .prepare("SELECT * FROM support_ticket_events WHERE ticket_id=? ORDER BY id")
      .all(ticketId)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        authorRole: e.author_role,
        author: e.author,
        body: e.body || "",
        status: e.status || "",
        messageId: e.message_id || "",
        createdAt: e.created_at,
      }));
  }

  function publicTicket(row) {
    const lastReply = db
      .prepare("SELECT body, author, created_at FROM support_ticket_events WHERE ticket_id=? AND kind='reply' ORDER BY id DESC LIMIT 1")
      .get(row.id);
    const hasPhoto = !!row.photo_path;
    // True when the customer has written (by email or in the portal) after the last admin reply.
    const last = (kinds) =>
      db
        .prepare(`SELECT id, created_at FROM support_ticket_events WHERE ticket_id=? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`)
        .get(row.id, ...kinds);
    const lastCustomer = last(["customer_email", "followup"]);
    const lastAdmin = last(["reply"]);
    const awaitingReply = !!lastCustomer && (!lastAdmin || lastCustomer.id > lastAdmin.id);
    return {
      awaitingReply,
      lastCustomerMessageAt: lastCustomer ? lastCustomer.created_at : "",
      id: row.id,
      ticketId: row.ticket_no,
      portalType: row.portal_type,
      signedIn: !!row.signed_in,
      accountLogin: row.account_login || "",
      customerName: row.customer_name,
      email: row.email,
      phone: row.phone || "",
      description: row.description,
      subject: hasPhoto ? "" : row.photo_name || "",
      photo: hasPhoto ? { name: row.photo_name || "", mime: row.photo_mime, size: row.photo_size } : null,
      status: row.status,
      adminResponse: lastReply ? lastReply.body : "",
      adminResponseAt: lastReply ? lastReply.created_at : "",
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at || "",
    };
  }

  function summaryCounts() {
    const counts = Object.fromEntries(SUPPORT_STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status").all())
      counts[r.status] = (counts[r.status] || 0) + r.n;
    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      new: counts.New,
      pending: counts.Pending,
      inProgress: counts["In Progress"],
      resolved: counts.Resolved,
      rejectedClosed: counts.Rejected + counts.Closed,
    };
  }

  // ----- admin side -----
  function listForAdmin({ status = "", portal = "", q = "" } = {}) {
    const where = [];
    const args = [];
    if (status && SUPPORT_STATUSES.includes(status)) {
      where.push("status=?");
      args.push(status);
    }
    if (portal && SUPPORT_PORTAL_TYPES.includes(portal)) {
      where.push("portal_type=?");
      args.push(portal);
    }
    const term = String(q || "").trim().toLowerCase();
    if (term) {
      where.push(
        "(LOWER(ticket_no) LIKE ? OR LOWER(customer_name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(COALESCE(phone,'')) LIKE ? OR LOWER(COALESCE(account_login,'')) LIKE ?)",
      );
      const like = `%${term}%`;
      args.push(like, like, like, like, like);
    }
    const sql = `SELECT * FROM support_tickets${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY submitted_at DESC LIMIT 1000`;
    return { summary: summaryCounts(), tickets: db.prepare(sql).all(...args).map(publicTicket) };
  }

  function getForAdmin(id) {
    const row = rowById(id);
    if (!row) throw new SupportError(404, "Ticket not found.");
    return { ticket: publicTicket(row), events: events(row.id) };
  }

  function touch(id, status, at, resolvedAt = null) {
    db.prepare("UPDATE support_tickets SET status=?, updated_at=?, resolved_at=? WHERE id=?").run(status, at, resolvedAt, id);
  }

  // Saves an admin reply. Returns the event id, so the email to the customer can be linked to it.
  function adminReply(id, actor, body) {
    const text = String(body || "").trim().slice(0, TEXT_LIMITS.reply);
    if (!text) throw new SupportError(400, "Please type your reply before sending.", "reply");
    const row = rowById(id);
    if (!row) throw new SupportError(404, "Ticket not found.");
    const at = new Date().toISOString();
    const eventId = tx(() => {
      const eid = addEvent(row.id, { kind: "reply", authorRole: "admin", author: actor, body: text }, at);
      // A reply moves a brand-new ticket into progress; other statuses are left for the admin to set.
      touch(row.id, row.status === "New" ? "In Progress" : row.status, at, row.resolved_at);
      return eid;
    });
    return { eventId, ticket: rowById(row.id), detail: getForAdmin(row.id) };
  }

  function setStatus(id, actor, status, note = "") {
    if (!SUPPORT_STATUSES.includes(status)) throw new SupportError(400, "Unknown status.", "status");
    const row = rowById(id);
    if (!row) throw new SupportError(404, "Ticket not found.");
    const at = new Date().toISOString();
    tx(() => {
      touch(row.id, status, at, FINISHED.includes(status) ? at : null);
      addEvent(row.id, {
        kind: "status",
        authorRole: "admin",
        author: actor,
        body: String(note || "").trim().slice(0, TEXT_LIMITS.reply) || null,
        status,
      }, at);
    });
    return getForAdmin(row.id);
  }

  // A customer's email (or a partner follow-up) added to an existing ticket. A finished ticket is reopened.
  function addMessage(ticketRow, { kind, author, authorRole, body, messageId = null }) {
    const text = String(body || "").trim().slice(0, TEXT_LIMITS.followUp) || "(no text in this message)";
    const at = new Date().toISOString();
    const eventId = tx(() => {
      const eid = addEvent(ticketRow.id, { kind, authorRole, author, body: text, messageId }, at);
      touch(ticketRow.id, FINISHED.includes(ticketRow.status) ? "Pending" : ticketRow.status, at, null);
      return eid;
    });
    return { eventId, ticket: rowById(ticketRow.id), detail: getForAdmin(ticketRow.id) };
  }

  // Finds the ticket an email reply belongs to, from the Message-IDs of our earlier emails.
  function ticketForMessageRefs(refs) {
    const ids = refs.map((r) => String(r || "").trim()).filter(Boolean);
    if (!ids.length) return null;
    const marks = ids.map(() => "?").join(",");
    const row = db
      .prepare(`SELECT ticket_id FROM support_ticket_events WHERE message_id IN (${marks}) ORDER BY id DESC LIMIT 1`)
      .get(...ids);
    return row ? rowById(row.ticket_id) : null;
  }

  // Photo to serve, or null. A path can only point inside the support photo folder.
  function photoFor(row) {
    if (!row || !row.photo_path) return null;
    const abs = path.join(uploadDir, row.photo_path);
    if (!abs.startsWith(path.join(uploadDir, "support") + path.sep)) return null;
    return { abs, mime: row.photo_mime, name: row.photo_name || "support-photo" };
  }

  // ----- partner side (vendor / franchise) -----
  // Every partner query is limited to the verified account AND that account's portal type. The account comes
  // from the server-side session (never from the request body), so a vendor can never reach a franchise ticket.
  function partnerScope(account) {
    const portalType = partnerPortalType(account && account.role);
    if (!account || !account.id || !portalType)
      throw new SupportError(403, "Only vendor and franchise accounts can use My Support Requests.");
    return { accountId: account.id, portalType };
  }

  // The ticket row, if this account of this portal owns it. Otherwise null (never reveals other tickets).
  function rowForAccount(id, account) {
    const { accountId, portalType } = partnerScope(account);
    const row = rowById(id);
    if (!row || row.account_id !== accountId || row.portal_type !== portalType) return null;
    return row;
  }

  function listForAccount(account) {
    const { accountId, portalType } = partnerScope(account);
    return db
      .prepare(
        "SELECT * FROM support_tickets WHERE account_id=? AND portal_type=? ORDER BY submitted_at DESC LIMIT 500",
      )
      .all(accountId, portalType)
      .map(publicTicket);
  }

  function getForAccount(id, account) {
    const row = rowForAccount(id, account);
    if (!row) throw new SupportError(404, "Ticket not found.");
    return { ticket: publicTicket(row), events: events(row.id).filter((e) => e.kind !== "email_out") };
  }

  // A partner adds more information to its own ticket.
  function partnerFollowUp(id, account, body) {
    const text = String(body || "").trim().slice(0, TEXT_LIMITS.followUp);
    if (!text) throw new SupportError(400, "Please write your follow-up message.", "message");
    const row = rowForAccount(id, account);
    if (!row) throw new SupportError(404, "Ticket not found.");
    if (row.status === "Closed") throw new SupportError(409, "This ticket is closed. Please submit a new support request.");
    const r = addMessage(row, { kind: "followup", authorRole: account.role, author: account.login_id, body: text });
    return { eventId: r.eventId, ticket: r.ticket, detail: getForAccount(row.id, account) };
  }

  return {
    create,
    rowById,
    rowByNumber,
    publicTicket,
    summaryCounts,
    listForAdmin,
    getForAdmin,
    adminReply,
    setStatus,
    addMessage,
    ticketForMessageRefs,
    photoFor,
    listForAccount,
    getForAccount,
    rowForAccount,
    partnerFollowUp,
    events,
    clean,
    TEXT_LIMITS,
  };
}
