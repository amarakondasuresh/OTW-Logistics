// Submitted Locations -> Approve -> Hub List. Uses Node's built-in SQLite, the same database layout as server.js.
// Run with:  node --test test/location-hub-approval.test.mjs   (from the backend folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHubService, HubError } from "../hubs.js";
import { createLocationService, LocationError, LOCATION_STATUS, registerLocationRoutes } from "../locations.js";
import { INDIA_STATES } from "../india-states.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "hubs-seed.json"), "utf8"));

const vendor = { id: "acc-vendor-1", login_id: "VEN-001", role: "vendor", name: "Ravi Vendor" };
const franchise = { id: "acc-fr-1", login_id: "FRN-001", role: "franchise", name: "Asha Franchise" };
const good = {
  name: "Anantapur Main Hub",
  state: "Andhra Pradesh",
  city: "Anantapur",
  district: "Anantapur",
  area: "Srinagar Colony",
  pin: "515001",
  url: "https://maps.app.goo.gl/abc123",
};

// The same database as server.js: hubs, partner_locations, accounts and partner_applications.
function setup({ seed = SEED, verifyFranchise = true, wrapHubs } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE accounts(id TEXT PRIMARY KEY, role TEXT NOT NULL, login_id TEXT NOT NULL, name TEXT, application_id TEXT);
    CREATE TABLE partner_applications(id TEXT PRIMARY KEY, name TEXT NOT NULL, mobile TEXT, state TEXT, status TEXT NOT NULL);
    INSERT INTO accounts VALUES('acc-vendor-1','vendor','VEN-001','Ravi Vendor',NULL);
    INSERT INTO accounts VALUES('acc-fr-1','franchise','FRN-001','Asha Franchise','app-fr-1');
    INSERT INTO partner_applications VALUES('app-fr-1','Asha Kumari','9876543210','Andhra Pradesh','${verifyFranchise ? "Accepted" : "New"}');
  `);
  const audits = [];
  const audit = (who, action, details) => audits.push({ who, action, details });
  const hubs = createHubService({ db, audit, seedRows: seed });
  let n = 0;
  const hubService = wrapHubs ? wrapHubs(hubs) : hubs;
  const svc = createLocationService({
    db,
    audit,
    now: () => `2026-11-17T10:00:${String(n++ % 60).padStart(2, "0")}.000Z`,
    randomId: () => "LOC-" + String(100000 + n++),
    hubService,
  });
  return { db, svc, hubs, audits };
}

const hubByName = (hubs, name) => hubs.list().find((h) => h.name === name);
const countLinked = (db) => db.prepare("SELECT COUNT(*) AS n FROM hubs WHERE source_location_id<>''").get().n;

// ---------- the Franchise / Vendor location fields are mapped into the hub ----------
test("approve creates one hub with the mapped fields and the source Location ID", () => {
  const { svc, hubs } = setup();
  const { location } = svc.submit(franchise, good, "k1");
  const out = svc.approve(location.id, "admin@x.in");
  assert.equal(out.hubCreated, true);
  assert.equal(out.location.status, LOCATION_STATUS.ACTIVE);
  const hub = hubByName(hubs, good.name);
  assert.ok(hub, "hub is in Hub List");
  assert.equal(hub.sourceLocationId, location.id);
  assert.equal(hub.name, good.name); // Location Name -> Hub Name
  assert.equal(hub.location, good.area); // Area -> Hub Location
  assert.equal(hub.city, good.city);
  assert.equal(hub.district, good.district);
  assert.equal(hub.state, good.state); // the State the partner chose
  assert.equal(hub.pincode, good.pin); // PIN -> Hub Pincode
  assert.equal(hub.url, good.url); // Location URL -> Hub URL
  assert.equal(hub.status, "Active"); // Hub Status
});

test("In-Charge and Phone come from the verified applicant; blank when not verified", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  svc.approve(a.id, "admin");
  const hub = hubByName(hubs, good.name);
  assert.equal(hub.hiName, "Asha Kumari");
  assert.equal(hub.phone, "9876543210");

  const unverified = setup({ verifyFranchise: false });
  const b = unverified.svc.submit(franchise, good, "k2").location;
  unverified.svc.approve(b.id, "admin");
  const blank = hubByName(unverified.hubs, good.name);
  assert.equal(blank.hiName, "");
  assert.equal(blank.phone, "");
});

test("a vendor without an application keeps In-Charge and Phone blank, and optional fields stay empty", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(vendor, { ...good, url: "" }, "v1").location;
  svc.approve(a.id, "admin");
  const hub = hubByName(hubs, good.name);
  assert.equal(hub.hiName, "");
  assert.equal(hub.phone, "");
  assert.equal(hub.url, "");
  assert.equal(hub.address, "");
  assert.equal(hub.email, "");
  assert.equal(hub.manager, "");
  assert.equal(hub.openingDate, "");
  assert.equal(hub.contactNumber, "");
});

// ---------- one approved location makes exactly one hub ----------
test("repeated approval clicks never create a second hub", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  const first = svc.approve(a.id, "admin");
  const second = svc.approve(a.id, "admin");
  const third = svc.approve(a.id, "admin");
  assert.equal(first.hubCreated, true);
  assert.equal(second.hubCreated, false);
  assert.equal(third.hubCreated, false);
  assert.equal(second.hub.id, first.hub.id);
  assert.equal(hubs.list().filter((h) => h.name === good.name).length, 1);
});

test("the database refuses a second hub for the same location even if one is inserted directly", () => {
  const { db, svc } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  svc.approve(a.id, "admin");
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO hubs(id,name,name_key,state,status,created_at,updated_at,source_location_id) VALUES(?,?,?,?,?,?,?,?)")
        .run("XH-999", "Other", "other", "Andhra Pradesh", "Active", "x", "x", a.id),
    /UNIQUE constraint failed/,
  );
});

test("a hub that already exists for the location is returned, not duplicated (retry after a lost response)", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  const first = svc.approve(a.id, "admin");
  // A retry that reaches the hub service again (for example after a lost response) gets the hub it already made.
  const again = hubs.createFromLocation({ id: a.id, name: good.name, state: good.state, city: good.city, district: good.district, area: good.area, pin: good.pin, url: good.url }, {}, "admin");
  assert.equal(again.created, false);
  assert.equal(again.hub.id, first.hub.id);
  assert.equal(hubs.list().filter((h) => h.name === good.name).length, 1);
});

// ---------- a failed approval changes nothing ----------
test("a hub name already in Hub List blocks approval, and the location stays Pending", () => {
  const { svc, hubs } = setup();
  // A hub already in Hub List with the same name as the location.
  const existing = hubs.create({ name: good.name, state: "Andhra Pradesh", city: "Anantapur" }, "admin");
  const a = svc.submit(franchise, good, "k1").location;
  assert.throws(() => svc.approve(a.id, "admin"), (e) => e instanceof HubError && e.status === 409 && /already in Hub List/.test(e.message));
  const row = svc.listAll().find((x) => x.id === a.id);
  assert.equal(row.status, LOCATION_STATUS.PENDING);
  assert.equal(row.hub, null);
  assert.equal(hubs.list().length, SEED.length + 1, "no second hub was added");
  assert.equal(hubs.get(existing.id).name, existing.name);
  assert.equal(hubs.get(existing.id).sourceLocationId, "", "the existing hub was not linked or overwritten");
});

test("if the hub cannot be saved, the location approval is rolled back as well", () => {
  const { svc, hubs, db } = setup({
    wrapHubs: (real) => ({
      ...real,
      createFromLocation(loc, contact, actor) {
        real.createFromLocation(loc, contact, actor); // the hub row is written...
        throw new Error("disk full"); // ...then the save fails
      },
    }),
  });
  const a = svc.submit(franchise, good, "k1").location;
  assert.throws(() => svc.approve(a.id, "admin"), /disk full/);
  assert.equal(svc.listAll()[0].status, LOCATION_STATUS.PENDING, "location still Pending");
  assert.equal(countLinked(db), 0, "no hub left behind");
  assert.equal(hubs.list().length, SEED.length);
});

test("a location without a State cannot be approved until Edit gives it one", () => {
  const { db, svc, hubs } = setup();
  // A location submitted before the State field existed.
  const a = svc.submit(franchise, good, "k1").location;
  db.prepare("UPDATE partner_locations SET state='' WHERE id=?").run(a.id);
  assert.throws(() => svc.approve(a.id, "admin"), (e) => e instanceof LocationError && e.field === "state");
  assert.equal(countLinked(db), 0);
  svc.update(a.id, { state: "Telangana" }, "admin");
  assert.equal(svc.approve(a.id, "admin").hubCreated, true);
  assert.equal(hubByName(hubs, good.name).state, "Telangana");
});

// ---------- State must be a real State or Union Territory ----------
test("State is required on submit and must be an official State or Union Territory name", () => {
  const { svc } = setup();
  assert.throws(() => svc.submit(vendor, { ...good, state: "" }, "s1"), (e) => e.field === "state");
  assert.throws(() => svc.submit(vendor, { ...good, state: "Andhra" }, "s2"), (e) => e.field === "state");
  assert.throws(() => svc.submit(vendor, { ...good, state: "Atlantis" }, "s3"), (e) => e.field === "state");
  assert.equal(svc.submit(vendor, { ...good, state: "andhra pradesh" }, "s4").location.state, "Andhra Pradesh");
  assert.equal(INDIA_STATES.length, 36);
});

// ---------- Reject ----------
test("reject does not add a hub; the reason is saved for the partner", () => {
  const { svc, hubs, db } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  const rejected = svc.reject(a.id, "admin", "PIN does not match the area");
  assert.equal(rejected.status, LOCATION_STATUS.REJECTED);
  assert.equal(countLinked(db), 0);
  assert.equal(hubByName(hubs, good.name), undefined);
  assert.equal(svc.listOwn(franchise)[0].rejectReason, "PIN does not match the area");
});

test("an approved location cannot be rejected; deleting it is the way to remove it", () => {
  const { svc } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  svc.approve(a.id, "admin");
  assert.throws(() => svc.reject(a.id, "admin", "x"), (e) => e.status === 409);
});

// ---------- Edit ----------
test("editing a pending location does not create a hub", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  svc.update(a.id, { area: "Old Town" }, "admin");
  assert.equal(hubByName(hubs, good.name), undefined);
  assert.equal(svc.listAll()[0].status, LOCATION_STATUS.PENDING);
});

test("editing an approved location updates its hub and never creates another", () => {
  const { svc, hubs, db } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  const { hub } = svc.approve(a.id, "admin");
  svc.update(a.id, { name: "Anantapur Central Hub", area: "Old Town", pin: "515002", state: "Telangana", url: "" }, "admin");
  const updated = hubs.get(hub.id);
  assert.equal(updated.name, "Anantapur Central Hub");
  assert.equal(updated.location, "Old Town");
  assert.equal(updated.pincode, "515002");
  assert.equal(updated.state, "Telangana");
  assert.equal(updated.url, "");
  assert.equal(updated.status, "Active");
  assert.equal(countLinked(db), 1);
  assert.equal(hubs.list().length, SEED.length + 1);
});

test("an edit that clashes with another hub name is refused and changes neither the location nor the hub", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  const { hub } = svc.approve(a.id, "admin");
  const other = hubs.create({ name: "Hindupur Branch", state: "Andhra Pradesh" }, "admin");
  assert.throws(() => svc.update(a.id, { name: other.name }, "admin"), (e) => e.status === 409);
  assert.equal(svc.listAll()[0].name, good.name);
  assert.equal(hubs.get(hub.id).name, good.name);
});

test("an edit to an approved location does not change the status", () => {
  const { svc } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  svc.approve(a.id, "admin");
  assert.equal(svc.update(a.id, { city: "Hindupur" }, "admin").status, LOCATION_STATUS.ACTIVE);
});

// ---------- Delete ----------
test("deleting an approved location sets its hub to Inactive and keeps the hub's details", () => {
  const { svc, hubs, db } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  const { hub } = svc.approve(a.id, "admin");
  const result = svc.remove(a.id, "admin");
  assert.equal(result.hub.status, "Inactive");
  const kept = hubs.get(hub.id);
  assert.ok(kept, "hub is not deleted");
  assert.equal(kept.status, "Inactive");
  assert.equal(kept.name, good.name);
  assert.equal(kept.phone, hub.phone);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partner_locations").get().n, 0);
});

test("a hub that came from a location cannot be deleted from Hub List directly", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  const { hub } = svc.approve(a.id, "admin");
  assert.throws(() => hubs.remove(hub.id, "admin"), (e) => e instanceof HubError && e.status === 409);
  assert.ok(hubs.get(hub.id));
});

test("deleting a pending location removes it without touching any hub", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  const result = svc.remove(a.id, "admin");
  assert.equal(result.hub, null);
  assert.equal(hubs.list().length, SEED.length);
});

// ---------- the existing 100 hubs ----------
test("the 100 existing hubs are unchanged after approvals, edits and deletes", () => {
  const { svc, hubs } = setup();
  const before = JSON.stringify(hubs.list().filter((h) => !h.sourceLocationId));
  assert.equal(hubs.list().length, 100);
  const a = svc.submit(franchise, good, "k1").location;
  svc.approve(a.id, "admin");
  const b = svc.submit(vendor, { ...good, name: "Vendor Branch", area: "Gandhi Nagar", pin: "515003" }, "k2").location;
  svc.approve(b.id, "admin");
  svc.update(a.id, { city: "Hindupur" }, "admin");
  svc.remove(b.id, "admin");
  const after = JSON.stringify(hubs.list().filter((h) => !h.sourceLocationId));
  assert.equal(after, before);
  assert.equal(hubs.list().length, 102, "100 existing + 2 approved (one is Inactive after its location was deleted)");
});

test("approved hubs are added after the existing records and the search finds them", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  svc.approve(a.id, "admin");
  const list = hubs.list();
  assert.equal(list.length, 101);
  assert.equal(list[list.length - 1].name, good.name, "new hub is last");
  const q = "srinagar"; // searched against all hub fields, as the Hub List search does
  assert.ok(list.filter((h) => JSON.stringify(h).toLowerCase().includes(q)).some((h) => h.name === good.name));
});

test("an approved hub can be set Inactive and Active again from Hub List, like any hub", () => {
  const { svc, hubs } = setup();
  const a = svc.submit(franchise, good, "k1").location;
  const { hub } = svc.approve(a.id, "admin");
  assert.equal(hubs.update(hub.id, { status: "Inactive" }, "admin").hub.status, "Inactive");
  assert.equal(hubs.update(hub.id, { status: "Active" }, "admin").hub.status, "Active");
});

// ---------- upgrading an existing database ----------
test("an existing hubs table gets the source link column without losing its rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hubs(id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
    hi_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '', pincode TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
    district TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', contact_number TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '', manager TEXT NOT NULL DEFAULT '', opening_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Active', url TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '',
    pod TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', contacts TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '');
    CREATE TABLE hub_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO hubs(id,name,name_key,state,created_at,updated_at) VALUES('XH-001','Old Hub','old hub','Andhra Pradesh','t','t');
    INSERT INTO hub_meta VALUES('seed_v1','100');`);
  const hubs = createHubService({ db, seedRows: SEED });
  assert.equal(hubs.list().length, 1);
  assert.equal(hubs.get("XH-001").name, "Old Hub");
  assert.equal(hubs.get("XH-001").sourceLocationId, "");
  // and a second start does not duplicate anything
  createHubService({ db, seedRows: SEED });
  assert.equal(hubs.list().length, 1);
});

// ---------- HTTP responses ----------
function fakeApp() {
  const routes = [];
  const add = (method) => (p, ...handlers) => routes.push({ method, path: p, handlers });
  return { routes, get: add("GET"), post: add("POST"), patch: add("PATCH"), delete: add("DELETE") };
}
function call(app, method, p, { params = {}, body = {}, account = null, adminEmail = "" } = {}) {
  const route = app.routes.find((r) => r.method === method && r.path === p);
  const req = { params, body, query: {}, account, adminEmail };
  let status = 200, payload;
  const res = { set() { return this; }, status(c) { status = c; return this; }, json(x) { payload = x; return this; } };
  route.handlers[route.handlers.length - 1](req, res, () => {});
  return { status, body: payload };
}

test("routes: approve returns the success message and the hub; a second approve says it is already there", () => {
  const { svc } = setup();
  const app = fakeApp();
  registerLocationRoutes(app, {
    partnerGuard: (req, res, next) => next(),
    adminGuard: (req, res, next) => next(),
    service: svc,
  });
  const created = call(app, "POST", "/api/portal/locations", { account: franchise, body: { ...good, submissionKey: "h1" } }).body.location;
  const first = call(app, "POST", "/api/admin/locations/:id/approve", { params: { id: created.id }, adminEmail: "admin" });
  assert.equal(first.status, 200);
  assert.equal(first.body.message, "Location approved and successfully added to Hub List.");
  assert.equal(first.body.hub.name, good.name);
  const again = call(app, "POST", "/api/admin/locations/:id/approve", { params: { id: created.id }, adminEmail: "admin" });
  assert.equal(again.body.hubCreated, false);
  assert.equal(again.body.message, "This location is already in Hub List.");
});

test("routes: a Hub List name clash is a clear 409 message, not a server error", () => {
  const { svc, hubs } = setup();
  const app = fakeApp();
  registerLocationRoutes(app, { partnerGuard: (q, s, n) => n(), adminGuard: (q, s, n) => n(), service: svc });
  const name = hubs.create({ name: good.name, state: "Andhra Pradesh" }, "admin").name;
  const created = call(app, "POST", "/api/portal/locations", { account: vendor, body: { ...good, submissionKey: "h2" } }).body.location;
  const out = call(app, "POST", "/api/admin/locations/:id/approve", { params: { id: created.id }, adminEmail: "admin" });
  assert.equal(out.status, 409);
  assert.match(out.body.error, /already in Hub List/);
});

test("routes: deleting an approved location says its hub is now Inactive", () => {
  const { svc } = setup();
  const app = fakeApp();
  registerLocationRoutes(app, { partnerGuard: (q, s, n) => n(), adminGuard: (q, s, n) => n(), service: svc });
  const created = call(app, "POST", "/api/portal/locations", { account: franchise, body: { ...good, submissionKey: "h3" } }).body.location;
  call(app, "POST", "/api/admin/locations/:id/approve", { params: { id: created.id }, adminEmail: "admin" });
  const gone = call(app, "DELETE", "/api/admin/locations/:id", { params: { id: created.id }, adminEmail: "admin" });
  assert.equal(gone.status, 200);
  assert.match(gone.body.message, /is now Inactive in Hub List/);
});

// ---------- partner edit / delete (My Locations) ----------
test("a partner can edit a pending location, and cannot edit another partner's location", () => {
  const { svc } = setup();
  const mine = svc.submit(franchise, good, "p1").location;
  const updated = svc.updateOwn(franchise, mine.id, { area: "Gandhi Nagar" });
  assert.equal(updated.area, "Gandhi Nagar");
  assert.equal(updated.status, LOCATION_STATUS.PENDING);
  assert.throws(() => svc.updateOwn(vendor, mine.id, { area: "Hijack" }), (e) => e instanceof LocationError && e.status === 404);
  assert.throws(() => svc.removeOwn(vendor, mine.id), (e) => e.status === 404);
  assert.equal(svc.listOwn(franchise)[0].area, "Gandhi Nagar");
});

test("a rejected location goes back to Pending Approval when the partner edits and saves it, and the reason is cleared", () => {
  const { svc } = setup();
  const mine = svc.submit(vendor, good, "p2").location;
  svc.reject(mine.id, "admin", "PIN does not match");
  const again = svc.updateOwn(vendor, mine.id, { pin: "515002" });
  assert.equal(again.status, LOCATION_STATUS.PENDING);
  assert.equal(again.rejectReason, "");
  assert.equal(again.pin, "515002");
});

test("an approved location is read-only for the partner, and the partner cannot delete it", () => {
  const { svc, hubs } = setup();
  const mine = svc.submit(franchise, good, "p3").location;
  svc.approve(mine.id, "admin");
  assert.throws(() => svc.updateOwn(franchise, mine.id, { area: "x" }), (e) => e.status === 409);
  assert.throws(() => svc.removeOwn(franchise, mine.id), (e) => e.status === 409);
  assert.equal(svc.listOwn(franchise)[0].status, LOCATION_STATUS.ACTIVE);
  assert.ok(hubs.findBySourceLocation(mine.id), "hub still exists");
});

test("a partner can delete a pending location, and the deletion is audited", () => {
  const { svc, audits } = setup();
  const mine = svc.submit(vendor, good, "p4").location;
  assert.equal(svc.removeOwn(vendor, mine.id).ok, true);
  assert.equal(svc.listOwn(vendor).length, 0);
  assert.ok(audits.some((a) => a.action === "location.partner_delete"));
});

test("a partner's edit cannot create a duplicate of their own pending location", () => {
  const { svc } = setup();
  svc.submit(vendor, good, "p5");
  const second = svc.submit(vendor, { ...good, name: "Second Branch" }, "p6").location;
  assert.throws(() => svc.updateOwn(vendor, second.id, { name: good.name }), (e) => e.status === 409);
});

test("the State defaults to the verified application's State when the partner leaves it blank", () => {
  const { svc } = setup();
  const out = svc.submit(franchise, { ...good, state: "" }, "p7");
  assert.equal(out.location.state, "Andhra Pradesh");
  assert.equal(svc.defaultState(franchise), "Andhra Pradesh");
  // a partner without a verified application still has to choose a State
  assert.equal(svc.defaultState(vendor), "");
  assert.throws(() => svc.submit(vendor, { ...good, state: "" }, "p8"), (e) => e.field === "state");
});

test("the partner routes: PATCH and DELETE work for the owner and return clear errors otherwise", () => {
  const { svc } = setup();
  const app = fakeApp();
  registerLocationRoutes(app, { partnerGuard: (q, s, n) => n(), adminGuard: (q, s, n) => n(), service: svc });
  const created = call(app, "POST", "/api/portal/locations", { account: franchise, body: { ...good, submissionKey: "r9" } }).body.location;
  const patched = call(app, "PATCH", "/api/portal/locations/:id", { params: { id: created.id }, account: franchise, body: { city: "Hindupur" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.location.city, "Hindupur");
  assert.equal(call(app, "PATCH", "/api/portal/locations/:id", { params: { id: created.id }, account: vendor, body: { city: "x" } }).status, 404);
  const listed = call(app, "GET", "/api/portal/locations", { account: franchise });
  assert.equal(listed.body.defaultState, "Andhra Pradesh");
  assert.equal(call(app, "DELETE", "/api/portal/locations/:id", { params: { id: created.id }, account: franchise }).status, 200);
});
