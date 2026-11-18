// Location Management rules. Uses Node's built-in SQLite so it runs without extra packages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHubService } from "../hubs.js";
import {
  createLocationService,
  validateLocationInput,
  cleanMapUrl,
  LocationError,
  LOCATION_STATUS,
} from "../locations.js";

const good = {
  name: "Anantapur Main Hub",
  state: "Andhra Pradesh",
  city: "Anantapur",
  district: "Anantapur",
  area: "Srinagar Colony",
  pin: "515001",
};
const vendor = { id: "acc-vendor-1", login_id: "VEN-001", role: "vendor", name: "Ravi Vendor" };
const franchise = { id: "acc-fr-1", login_id: "FRN-001", role: "franchise", name: "Asha Franchise" };

function setup() {
  const db = new DatabaseSync(":memory:");
  let n = 0;
  const audits = [];
  const audit = (who, action, details) => audits.push({ who, action, details });
  const hubService = createHubService({ db, audit, seedRows: [] });
  const svc = createLocationService({
    db,
    audit,
    now: () => `2026-11-16T10:00:${String(n++ % 60).padStart(2, "0")}.000Z`,
    randomId: () => "LOC-" + String(100000 + n++),
    hubService,
  });
  return { db, svc, audits };
}

test("all five fields are mandatory", () => {
  for (const key of ["name", "city", "district", "area", "pin"]) {
    const input = { ...good, [key]: "   " };
    assert.throws(() => validateLocationInput(input), (e) => e instanceof LocationError && e.field === key);
  }
});

test("PIN code must be 6 digits and cannot start with 0", () => {
  for (const pin of ["12345", "1234567", "012345", "51500A", "abcdef"])
    assert.throws(() => validateLocationInput({ ...good, pin }), (e) => e.field === "pin");
  assert.equal(validateLocationInput({ ...good, pin: " 515001 " }).pin, "515001");
});

test("text fields reject unsafe characters and accept Indian place names", () => {
  assert.throws(() => validateLocationInput({ ...good, city: "<script>x</script>" }), (e) => e.field === "city");
  assert.equal(validateLocationInput({ ...good, area: "Vidya Nagar, Phase-2 (East)" }).area, "Vidya Nagar, Phase-2 (East)");
  assert.equal(validateLocationInput({ ...good, city: "అనంతపురం" }).city, "అనంతపురం");
});

test("submit saves a Pending Approval location with a Location ID and owner details", () => {
  const { svc } = setup();
  const out = svc.submit(vendor, good, "key-1");
  assert.equal(out.duplicate, false);
  assert.match(out.location.id, /^LOC-\d+$/);
  assert.equal(out.location.status, LOCATION_STATUS.PENDING);
  assert.equal(out.location.name, good.name);
  const admin = svc.listAll();
  assert.equal(admin.length, 1);
  assert.equal(admin[0].appliedBy, "Ravi Vendor");
  assert.equal(admin[0].appliedRole, "vendor");
});

test("a repeated submission key returns the same location instead of a second one", () => {
  const { svc } = setup();
  const first = svc.submit(vendor, good, "dup-key");
  const again = svc.submit(vendor, good, "dup-key");
  assert.equal(again.duplicate, true);
  assert.equal(again.location.id, first.location.id);
  assert.equal(svc.listAll().length, 1);
});

test("the same location cannot be submitted twice by one partner", () => {
  const { svc } = setup();
  svc.submit(vendor, good, "k1");
  assert.throws(
    () => svc.submit(vendor, { ...good, name: "  anantapur   MAIN hub " }, "k2"),
    (e) => e.status === 409,
  );
});

test("partners see only their own locations", () => {
  const { svc } = setup();
  svc.submit(vendor, good, "a");
  svc.submit(franchise, { ...good, name: "Franchise Hub" }, "b");
  assert.equal(svc.listOwn(vendor).length, 1);
  assert.equal(svc.listOwn(franchise).length, 1);
  assert.equal(svc.listOwn(vendor)[0].name, good.name);
  assert.equal(svc.listOwn(vendor)[0].appliedBy, undefined); // admin-only details are not in the partner view
});

test("admin approve makes the location Active, and approving again changes nothing", () => {
  const { svc, audits } = setup();
  const { location } = svc.submit(vendor, good, "a");
  const active = svc.approve(location.id, "admin@x.in").location;
  assert.equal(active.status, LOCATION_STATUS.ACTIVE);
  assert.equal(active.decidedBy, "admin@x.in");
  assert.equal(svc.approve(location.id, "admin@x.in").location.status, LOCATION_STATUS.ACTIVE);
  assert.equal(svc.listOwn(vendor)[0].status, LOCATION_STATUS.ACTIVE);
  assert.ok(audits.some((a) => a.action === "location.approve"));
});

test("approval is blocked when an identical location is already Active", () => {
  const { svc } = setup();
  const a = svc.submit(vendor, good, "a").location;
  svc.submit(franchise, good, "b"); // different partner, still pending: allowed
  const b = svc.listAll().find((x) => x.ownerLoginId === "FRN-001");
  svc.approve(a.id, "admin");
  assert.throws(() => svc.approve(b.id, "admin"), (e) => e.status === 409);
});

test("admin reject records the reason and the partner sees it", () => {
  const { svc } = setup();
  const { location } = svc.submit(vendor, good, "a");
  const rejected = svc.reject(location.id, "admin", "PIN does not match the area");
  assert.equal(rejected.status, LOCATION_STATUS.REJECTED);
  const own = svc.listOwn(vendor)[0];
  assert.equal(own.status, "Rejected");
  assert.equal(own.rejectReason, "PIN does not match the area");
});

test("admin edit changes details but keeps the status", () => {
  const { svc } = setup();
  const { location } = svc.submit(vendor, good, "a");
  svc.approve(location.id, "admin");
  const edited = svc.update(location.id, { area: "Old Town", pin: "515002" }, "admin");
  assert.equal(edited.area, "Old Town");
  assert.equal(edited.pin, "515002");
  assert.equal(edited.status, LOCATION_STATUS.ACTIVE);
  assert.throws(() => svc.update(location.id, { city: "" }, "admin"), (e) => e.field === "city");
  assert.throws(() => svc.update(location.id, { pin: "000000" }, "admin"), (e) => e.field === "pin");
});

test("admin delete removes the location from both lists", () => {
  const { svc } = setup();
  const { location } = svc.submit(vendor, good, "a");
  svc.remove(location.id, "admin");
  assert.equal(svc.listAll().length, 0);
  assert.equal(svc.listOwn(vendor).length, 0);
  assert.throws(() => svc.remove(location.id, "admin"), (e) => e.status === 404);
});

test("counts reflect each status", () => {
  const { svc } = setup();
  const a = svc.submit(vendor, good, "a").location;
  svc.submit(vendor, { ...good, name: "Second" }, "b");
  svc.approve(a.id, "admin");
  assert.deepEqual(svc.counts(), { pending: 1, active: 1, rejected: 0, total: 2 });
});

// ---------- HTTP routes (tested with a small stand-in for Express) ----------
import { registerLocationRoutes } from "../locations.js";

function fakeApp() {
  const routes = [];
  const add = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return { routes, get: add("GET"), post: add("POST"), patch: add("PATCH"), delete: add("DELETE") };
}
function call(app, method, path, { params = {}, body = {}, query = {}, account = null, adminEmail = "" } = {}) {
  const route = app.routes.find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} is registered`);
  const req = { params, body, query, account, adminEmail };
  let status = 200;
  let payload;
  const res = {
    set() { return this; },
    status(c) { status = c; return this; },
    json(p) { payload = p; return this; },
  };
  // Run guard first, then the handler. A guard that rejects does not call the handler.
  let i = 0;
  const next = () => route.handlers[++i]?.(req, res, next);
  route.handlers[0](req, res, next);
  return { status, body: payload };
}

test("routes: guards run first and partners cannot reach admin routes", () => {
  const { svc } = setup();
  const app = fakeApp();
  const pass = (req, res, next) => next();
  const requireAdmin = (req, res, next) =>
    req.adminEmail ? next() : res.status(401).json({ error: "Please sign in again." });
  const requirePartner = (req, res, next) =>
    req.account ? next() : res.status(401).json({ error: "Please sign in again." });
  registerLocationRoutes(app, { partnerGuard: requirePartner, adminGuard: requireAdmin, service: svc });
  void pass;

  const noAdmin = call(app, "GET", "/api/admin/locations", {});
  assert.equal(noAdmin.status, 401);
  const partnerOnAdmin = call(app, "GET", "/api/admin/locations", { account: vendor });
  assert.equal(partnerOnAdmin.status, 401);
});

test("routes: submit returns 201, duplicates return 200, bad input returns 400 with field list", () => {
  const { svc } = setup();
  const app = fakeApp();
  registerLocationRoutes(app, {
    partnerGuard: (req, res, next) => (req.account ? next() : res.status(401).json({})),
    adminGuard: (req, res, next) => (req.adminEmail ? next() : res.status(401).json({})),
    service: svc,
  });
  const ok = call(app, "POST", "/api/portal/locations", { account: vendor, body: { ...good, submissionKey: "r1" } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.location.status, "Pending Approval");
  assert.equal(ok.body.message, "Location submitted successfully. Waiting for Admin Approval.");

  const again = call(app, "POST", "/api/portal/locations", { account: vendor, body: { ...good, submissionKey: "r1" } });
  assert.equal(again.status, 200);
  assert.equal(again.body.location.id, ok.body.location.id);

  const bad = call(app, "POST", "/api/portal/locations", { account: vendor, body: { ...good, pin: "12" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "pin");
  assert.equal(bad.body.errors.length, 1);
});

test("routes: admin approve then partner list shows Active; admin edit and delete work over HTTP", () => {
  const { svc } = setup();
  const app = fakeApp();
  registerLocationRoutes(app, {
    partnerGuard: (req, res, next) => (req.account ? next() : res.status(401).json({})),
    adminGuard: (req, res, next) => (req.adminEmail ? next() : res.status(401).json({})),
    service: svc,
  });
  const created = call(app, "POST", "/api/portal/locations", { account: franchise, body: { ...good, submissionKey: "x" } }).body.location;
  const approved = call(app, "POST", "/api/admin/locations/:id/approve", { params: { id: created.id }, adminEmail: "admin@x.in" });
  assert.equal(approved.status, 200);
  const mine = call(app, "GET", "/api/portal/locations", { account: franchise });
  assert.equal(mine.body.locations[0].status, "Active");
  const edited = call(app, "PATCH", "/api/admin/locations/:id", { params: { id: created.id }, body: { city: "Hindupur" }, adminEmail: "admin@x.in" });
  assert.equal(edited.body.location.city, "Hindupur");
  const gone = call(app, "DELETE", "/api/admin/locations/:id", { params: { id: created.id }, adminEmail: "admin@x.in" });
  assert.equal(gone.status, 200);
  assert.equal(call(app, "GET", "/api/portal/locations", { account: franchise }).body.locations.length, 0);
});

// ---------- Map link (optional) ----------
test("map link: blank is allowed, web links are kept, other schemes are refused", () => {
  assert.equal(cleanMapUrl(""), "");
  assert.equal(cleanMapUrl("   "), "");
  assert.equal(cleanMapUrl("https://maps.app.goo.gl/abc123"), "https://maps.app.goo.gl/abc123");
  assert.equal(cleanMapUrl("maps.google.com/?q=anantapur"), "https://maps.google.com/?q=anantapur");
  assert.throws(() => cleanMapUrl("javascript:alert(1)"), (e) => e.field === "url");
  assert.throws(() => cleanMapUrl("ftp://example.com/x"), (e) => e.field === "url");
  assert.throws(() => cleanMapUrl("not a link"), (e) => e.field === "url");
  assert.throws(() => cleanMapUrl("https://" + "a".repeat(520) + ".com"), (e) => e.field === "url");
});

test("map link: saved on submit, shown to partner and admin, changed or cleared by admin", () => {
  const { svc } = setup();
  const created = svc.submit(vendor, { ...good, url: "maps.app.goo.gl/xyz" }, "u1").location;
  assert.equal(created.url, "https://maps.app.goo.gl/xyz");
  assert.equal(svc.listOwn(vendor)[0].url, "https://maps.app.goo.gl/xyz");
  assert.equal(svc.listAll()[0].url, "https://maps.app.goo.gl/xyz");
  const changed = svc.update(created.id, { url: "https://maps.google.com/?q=new" }, "admin");
  assert.equal(changed.url, "https://maps.google.com/?q=new");
  const cleared = svc.update(created.id, { url: "" }, "admin");
  assert.equal(cleared.url, "");
  // an edit without a url field keeps the saved link
  svc.update(created.id, { url: "https://maps.app.goo.gl/keep" }, "admin");
  assert.equal(svc.update(created.id, { city: "Hindupur" }, "admin").url, "https://maps.app.goo.gl/keep");
});

test("map link: an invalid link is refused and nothing is saved", () => {
  const { svc } = setup();
  assert.throws(() => svc.submit(vendor, { ...good, url: "javascript:x" }, "bad"), (e) => e.field === "url");
  assert.equal(svc.listAll().length, 0);
});

test("map link: a database created before this version gets the column on start", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE partner_locations(id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, owner_login_id TEXT NOT NULL,
    owner_role TEXT NOT NULL, applied_by_name TEXT NOT NULL DEFAULT '', location_name TEXT NOT NULL, city TEXT NOT NULL,
    district TEXT NOT NULL, area TEXT NOT NULL, pin_code TEXT NOT NULL, duplicate_key TEXT NOT NULL, status TEXT NOT NULL,
    reject_reason TEXT NOT NULL DEFAULT '', submission_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL DEFAULT '', decided_at TEXT, decided_by TEXT NOT NULL DEFAULT '')`);
  const svc = createLocationService({ db, hubService: createHubService({ db, seedRows: [] }) });
  const out = svc.submit(vendor, { ...good, url: "https://maps.app.goo.gl/old" }, "m1");
  assert.equal(out.location.url, "https://maps.app.goo.gl/old");
});
