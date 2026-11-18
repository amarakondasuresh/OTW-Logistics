// Support ticket rules: numbering, duplicate protection, photo checks, partner isolation, replies and status.
// Uses Node's built-in SQLite so it runs without installing packages.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSupportService,
  detectImageType,
  partnerPortalType,
  SupportError,
} from "../support-tickets.js";

// node:sqlite exists from Node 22.5; on older Node these tests are skipped instead of failing.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}
const t = DatabaseSync ? test : test.skip;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 2),
]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(40, 3)]);

function setup() {
  if (!DatabaseSync) throw new Error("node:sqlite unavailable");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otw-support-"));
  const db = new DatabaseSync(path.join(dir, "test.sqlite"));
  // Minimal accounts table, same shape the auth module creates.
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY, role TEXT, login_id TEXT, email TEXT, status TEXT DEFAULT 'active')`);
  const service = createSupportService({ db, uploadDir: dir });
  return { db, dir, service };
}
const photo = (buffer = JPEG, originalname = "problem.jpg") => ({ buffer, originalname, mimetype: "image/jpeg" });
const vendor = { id: "acc-vendor-1", role: "vendor", login_id: "VEN-001" };
const franchise = { id: "acc-fran-1", role: "franchise", login_id: "FRA-009" };

function submit(service, overrides = {}) {
  return service.create({
    portalType: "Vendor",
    signedIn: true,
    account: vendor,
    name: "Ravi Kumar",
    email: "ravi@example.com",
    phone: "9876543210",
    description: "Rider app shows wrong hub.",
    photo: photo(),
    submissionKey: null,
    ...overrides,
  });
}

t("detects JPG, PNG and WEBP by signature and rejects other files", () => {
  assert.equal(detectImageType(JPEG), "image/jpeg");
  assert.equal(detectImageType(PNG), "image/png");
  assert.equal(detectImageType(WEBP), "image/webp");
  assert.equal(detectImageType(Buffer.from("%PDF-1.4 not an image really")), null);
  assert.equal(detectImageType(Buffer.alloc(3)), null);
});

t("saves a ticket with a unique number, stores the photo on disk and records the submission", () => {
  const { service, dir, db } = setup();
  const { ticket, duplicate } = submit(service);
  assert.equal(duplicate, false);
  assert.match(ticket.ticket_no, /^OTW-SUP-\d{8}-0001$/);
  assert.equal(ticket.status, "New");
  assert.equal(ticket.portal_type, "Vendor");
  const abs = path.join(dir, ticket.photo_path);
  assert.ok(fs.existsSync(abs), "photo file must be on disk");
  assert.deepEqual(fs.readFileSync(abs), JPEG);
  const events = db.prepare("SELECT kind FROM support_ticket_events WHERE ticket_id=?").all(ticket.id);
  assert.deepEqual(events.map((e) => e.kind), ["submitted"]);
});

t("ticket numbers count up within the same day", () => {
  const { service } = setup();
  const a = submit(service).ticket.ticket_no;
  const b = submit(service).ticket.ticket_no;
  assert.notEqual(a, b);
  assert.ok(a.endsWith("-0001") && b.endsWith("-0002"), `${a} ${b}`);
});

t("a repeated submission key returns the same ticket and saves nothing twice", () => {
  const { service, db } = setup();
  const first = submit(service, { submissionKey: "sub-abcdef-123456" });
  const again = submit(service, { submissionKey: "sub-abcdef-123456" });
  assert.equal(again.duplicate, true);
  assert.equal(again.ticket.id, first.ticket.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM support_tickets").get().n, 1);
});

t("a file that is not a JPG, PNG or WEBP is refused and leaves no ticket or file behind", () => {
  const { service, dir, db } = setup();
  assert.throws(
    () => submit(service, { photo: photo(Buffer.from("this is plain text, not a picture")) }),
    (e) => e instanceof SupportError && e.status === 400 && e.field === "photo",
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM support_tickets").get().n, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, "support")), []);
});

t("PNG and WEBP photos are accepted with the right extension", () => {
  const { service, dir } = setup();
  const png = submit(service, { photo: photo(PNG, "a.png") }).ticket;
  const webp = submit(service, { photo: photo(WEBP, "b.webp") }).ticket;
  assert.ok(png.photo_path.endsWith(".png"));
  assert.ok(webp.photo_path.endsWith(".webp"));
  assert.ok(fs.existsSync(path.join(dir, png.photo_path)));
});

t("partners see only their own tickets", () => {
  const { service } = setup();
  const mine = submit(service).ticket;
  submit(service, { account: franchise, portalType: "Franchise" });
  const list = service.listForAccount(vendor);
  assert.deepEqual(list.map((t) => t.ticketId), [mine.ticket_no]);
  assert.throws(() => service.getForAccount(mine.id, franchise), (e) => e.status === 404);
  assert.equal(service.getForAccount(mine.id, vendor).ticket.ticketId, mine.ticket_no);
});

t("admin reply is saved against the ticket and moves a New ticket to In Progress", () => {
  const { service } = setup();
  const { ticket } = submit(service);
  const out = service.adminReply(ticket.id, "admin@example.com", "We are checking the hub mapping.");
  assert.equal(out.ticket.status, "In Progress");
  assert.equal(out.detail.ticket.adminResponse, "We are checking the hub mapping.");
  assert.ok(out.eventId > 0);
  const reply = out.detail.events.find((e) => e.kind === "reply");
  assert.equal(reply.author, "admin@example.com");
  assert.throws(() => service.adminReply(ticket.id, "admin@example.com", "   "), (e) => e.status === 400);
});

t("status changes are recorded, and Resolved sets the resolved time", () => {
  const { service, db } = setup();
  const { ticket } = submit(service);
  const out = service.setStatus(ticket.id, "admin@example.com", "Resolved", "Hub mapping fixed.");
  assert.equal(out.ticket.status, "Resolved");
  assert.ok(out.ticket.resolvedAt);
  const last = out.events.at(-1);
  assert.equal(last.kind, "status");
  assert.equal(last.status, "Resolved");
  assert.equal(db.prepare("SELECT resolved_at FROM support_tickets WHERE id=?").get(ticket.id).resolved_at !== null, true);
  assert.throws(() => service.setStatus(ticket.id, "admin", "Unknown"), (e) => e.status === 400);
});

t("a partner follow-up on a resolved ticket reopens it as Pending; a closed ticket refuses follow-ups", () => {
  const { service } = setup();
  const { ticket } = submit(service);
  service.setStatus(ticket.id, "admin@example.com", "Resolved");
  const out = service.partnerFollowUp(ticket.id, vendor, "The problem came back today.");
  assert.equal(out.ticket.status, "Pending");
  assert.equal(out.detail.events.at(-1).kind, "followup");
  service.setStatus(ticket.id, "admin@example.com", "Closed");
  assert.throws(() => service.partnerFollowUp(ticket.id, vendor, "Hello?"), (e) => e.status === 409);
});

t("a partner cannot follow up on another partner's ticket", () => {
  const { service } = setup();
  const { ticket } = submit(service);
  assert.throws(() => service.partnerFollowUp(ticket.id, franchise, "Let me in"), (e) => e.status === 404);
});

t("summary counts group Rejected and Closed together", () => {
  const { service } = setup();
  const a = submit(service).ticket;
  const b = submit(service).ticket;
  const c = submit(service).ticket;
  submit(service);
  service.setStatus(a.id, "admin", "Rejected");
  service.setStatus(b.id, "admin", "Closed");
  service.adminReply(c.id, "admin", "On it");
  const s = service.summaryCounts();
  assert.equal(s.total, 4);
  assert.equal(s.rejectedClosed, 2);
  assert.equal(s.inProgress, 1);
  assert.equal(s.new, 1);
});

t("admin list filters by portal and search text", () => {
  const { service } = setup();
  submit(service);
  submit(service, { portalType: "Franchise", account: franchise, name: "Anita Rao", email: "anita@example.com" });
  assert.equal(service.listForAdmin({ portal: "Franchise" }).tickets.length, 1);
  assert.equal(service.listForAdmin({ q: "anita" }).tickets[0].customerName, "Anita Rao");
  assert.equal(service.listForAdmin({ status: "Resolved" }).tickets.length, 0);
});

t("photo paths can only point inside the support photo folder", () => {
  const { service, dir } = setup();
  const { ticket } = submit(service);
  assert.ok(service.photoFor(ticket).abs.startsWith(path.join(dir, "support") + path.sep));
  assert.equal(service.photoFor({ photo_path: "../../etc/passwd", photo_mime: "image/png" }), null);
});

t("portal type is part of every partner check, not only the account", () => {
  const { service, db } = setup();
  const mine = submit(service).ticket;
  // A row that names this vendor account but a franchise portal must never reach the vendor.
  db.prepare("UPDATE support_tickets SET portal_type='Franchise' WHERE id=?").run(mine.id);
  assert.deepEqual(service.listForAccount(vendor), []);
  assert.throws(() => service.getForAccount(mine.id, vendor), (e) => e.status === 404);
  assert.equal(service.rowForAccount(mine.id, vendor), null);
  assert.throws(() => service.partnerFollowUp(mine.id, vendor, "Hello"), (e) => e.status === 404);
});

t("a ticket cannot be saved under an account of the other portal", () => {
  const { service } = setup();
  assert.throws(() => submit(service, { portalType: "Franchise", account: vendor }), (e) => e.status === 403);
  assert.equal(service.listForAdmin().tickets.length, 0);
});

t("tickets sent without a signed-in account are never listed for any partner", () => {
  const { service } = setup();
  const orphan = service.create({
    portalType: "Vendor", signedIn: false, name: "Asha", email: "asha@example.com", description: "no login", photo: null,
  }).ticket;
  assert.deepEqual(service.listForAccount(vendor), []);
  assert.deepEqual(service.listForAccount(franchise), []);
  assert.equal(service.rowForAccount(orphan.id, vendor), null);
  assert.equal(service.listForAdmin().tickets.length, 1, "admin still sees it");
});

t("a partner with no vendor or franchise role gets nothing", () => {
  const { service } = setup();
  submit(service);
  const admin = { id: "acc-admin", role: "admin", login_id: "admin@example.com" };
  assert.throws(() => service.listForAccount(admin), (e) => e.status === 403);
  assert.throws(() => service.listForAccount(null), (e) => e.status === 403);
});

t("partnerPortalType maps only vendor and franchise", () => {
  assert.equal(partnerPortalType("vendor"), "Vendor");
  assert.equal(partnerPortalType("franchise"), "Franchise");
  assert.equal(partnerPortalType("admin"), null);
});

t("reopening an existing database keeps every ticket and its photo", () => {
  const { service, db, dir } = setup();
  const mine = submit(service).ticket;
  const reopened = createSupportService({ db, uploadDir: dir });
  assert.deepEqual(reopened.listForAccount(vendor).map((x) => x.ticketId), [mine.ticket_no]);
  assert.ok(fs.existsSync(path.join(dir, mine.photo_path)));
});
