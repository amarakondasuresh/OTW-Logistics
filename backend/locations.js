// Location Management: partner-submitted locations (franchise and vendor portals) approved by the Admin Portal.
//
// Locations live in the `partner_locations` table of the same database as the rest of the backend, so both
// portals and the admin dashboard read the same rows. Rules (validation, duplicate checks, status changes, roles)
// are here so they can be tested without the web framework; registerLocationRoutes() exposes them over HTTP.
//
// Status flow:  Pending Approval --approve--> Active
//               Pending Approval --reject-->  Rejected  (a partner may submit the location again as a new entry)
//               Active / Rejected --edit-->   same status (edits never change the status)
// Partners can only submit and read their own locations. Only an admin can approve, reject, edit or delete.
//
// Approval (Pending Approval -> Active) also creates the matching hub in Hub Management > Hub List, in the same
// database transaction, so an approval never exists without its hub and a failed hub save leaves the location
// unchanged. The hub keeps this location's ID (hubs.source_location_id), so one location makes one hub.
// Deleting an approved location sets its hub to Inactive; a hub is never silently deleted.
import crypto from "node:crypto";
import { INDIA_STATES } from "./india-states.js";
import { HubError } from "./hubs.js";

export const LOCATION_STATUS = {
  PENDING: "Pending Approval",
  ACTIVE: "Active",
  REJECTED: "Rejected",
};
export const LOCATION_FIELDS = ["name", "state", "city", "district", "area", "pin"];
export const LOCATION_LABEL = {
  name: "Location Name",
  state: "State",
  city: "City / Town",
  district: "District",
  area: "Area",
  pin: "PIN Code",
};
const MAX_LENGTH = { name: 120, city: 80, district: 80, area: 120 };
// Letters in any language, digits, spaces and the punctuation used in Indian place names.
const TEXT_RE = /^[\p{L}\p{M}\p{N} .,'&()/-]+$/u;
const PIN_RE = /^[1-9][0-9]{5}$/; // Indian PIN: 6 digits, never starts with 0

export class LocationError extends Error {
  constructor(status, message, field = "", errors = []) {
    super(message);
    this.status = status;
    this.field = field;
    this.errors = errors;
  }
}

const clean = (v) =>
  (v === null || v === undefined ? "" : String(v)).replace(/\s+/g, " ").trim();
// Two submissions are the same location when these match (case and spacing ignored).
const sameKey = (v) => clean(v).toLowerCase();
const duplicateKey = (l) =>
  [l.name, l.city, l.district, l.area, l.pin].map(sameKey).join("|");
// Accepts only the official State / Union Territory names. Returns the official spelling, or "".
const STATE_BY_KEY = new Map(INDIA_STATES.map((n) => [sameKey(n), n]));
export const officialState = (value) => STATE_BY_KEY.get(sameKey(value)) || "";
const isUniqueViolation = (err) =>
  /UNIQUE constraint failed/.test(String(err?.message || ""));

// Checks the five mandatory fields. Returns the cleaned values or throws LocationError (400) listing every problem.
export function validateLocationInput(input = {}) {
  const values = {};
  const errors = [];
  for (const key of LOCATION_FIELDS) {
    const value = clean(input[key]);
    values[key] = value;
    const label = LOCATION_LABEL[key];
    if (!value) {
      errors.push({ field: key, message: `${label} is required.` });
      continue;
    }
    if (key === "state") {
      const official = officialState(value);
      if (!official) errors.push({ field: key, message: "Choose the State from the list." });
      else values[key] = official;
      continue;
    }
    if (key === "pin") {
      if (!PIN_RE.test(value))
        errors.push({
          field: key,
          message: "Enter a valid 6-digit PIN code (it cannot start with 0).",
        });
      continue;
    }
    if (value.length < 2)
      errors.push({ field: key, message: `${label} is too short.` });
    else if (value.length > MAX_LENGTH[key])
      errors.push({
        field: key,
        message: `${label} must be ${MAX_LENGTH[key]} characters or fewer.`,
      });
    else if (!TEXT_RE.test(value))
      errors.push({
        field: key,
        message: `${label} contains characters that are not allowed.`,
      });
  }
  if (errors.length)
    throw new LocationError(
      400,
      errors[0].message,
      errors[0].field,
      errors,
    );
  return values;
}

// Optional Google Maps (or any web) link to the location. Blank is allowed; anything else must be a real http(s) link.
export function cleanMapUrl(value) {
  const v = clean(value);
  if (!v) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : "https://" + v;
  let u;
  try {
    u = new URL(withScheme);
  } catch (e) {
    throw new LocationError(400, "Enter a full web link, for example a Google Maps link.", "url");
  }
  if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes("."))
    throw new LocationError(400, "Enter a full web link, for example a Google Maps link.", "url");
  if (u.href.length > 500)
    throw new LocationError(400, "This link is too long.", "url");
  return u.href;
}

export function createLocationService({
  db,
  audit = () => {},
  now = () => new Date().toISOString(),
  randomId = () => "LOC-" + crypto.randomInt(100000, 1000000),
  hubService,
}) {
  if (!hubService)
    throw new Error("createLocationService needs hubService: approving a location creates its hub.");

  db.exec(`
    CREATE TABLE IF NOT EXISTS partner_locations(
      id TEXT PRIMARY KEY,
      owner_account_id TEXT NOT NULL,
      owner_login_id TEXT NOT NULL,
      owner_role TEXT NOT NULL,
      applied_by_name TEXT NOT NULL DEFAULT '',
      location_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL,
      district TEXT NOT NULL,
      area TEXT NOT NULL,
      pin_code TEXT NOT NULL,
      location_url TEXT NOT NULL DEFAULT '',
      duplicate_key TEXT NOT NULL,
      status TEXT NOT NULL,
      reject_reason TEXT NOT NULL DEFAULT '',
      submission_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      decided_at TEXT,
      decided_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS partner_locations_owner ON partner_locations(owner_account_id);
    CREATE INDEX IF NOT EXISTS partner_locations_status ON partner_locations(status);
    CREATE UNIQUE INDEX IF NOT EXISTS partner_locations_submission
      ON partner_locations(owner_account_id, submission_key);
  `);

  // Databases created before the map link and the State field was added get the columns on first start.
  const columns = db.prepare("PRAGMA table_info(partner_locations)").all().map((c) => c.name);
  if (!columns.includes("location_url"))
    db.exec("ALTER TABLE partner_locations ADD COLUMN location_url TEXT NOT NULL DEFAULT ''");
  if (!columns.includes("state"))
    db.exec("ALTER TABLE partner_locations ADD COLUMN state TEXT NOT NULL DEFAULT ''");

  // Runs fn in one database transaction. If fn throws, every change it made is rolled back.
  function inTransaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch (_) {
        /* nothing to roll back */
      }
      throw err;
    }
  }

  // The verified applicant for a partner: the partner application that was accepted. Returns null when there
  // is none (or the accounts / applications tables are not present, as in a bare test database).
  function verifiedApplication(ownerId) {
    try {
      const account = db
        .prepare("SELECT application_id FROM accounts WHERE id=?")
        .get(ownerId);
      if (!account?.application_id) return null;
      const app = db
        .prepare("SELECT name, mobile, state, status FROM partner_applications WHERE id=?")
        .get(account.application_id);
      if (!app || !["Accepted", "Approved"].includes(app.status)) return null;
      return app;
    } catch (err) {
      if (/no such table/.test(String(err?.message || ""))) return null;
      throw err;
    }
  }
  // In-Charge and Phone for the hub come from the verified applicant (blank when there is none).
  function verifiedContact(ownerId) {
    const app = verifiedApplication(ownerId);
    return app ? { name: app.name || "", mobile: app.mobile || "" } : {};
  }
  // The State of the verified application, offered as the default State on the Add Location form.
  // Only an official State name is used; anything else is left for the partner to choose.
  function verifiedState(ownerId) {
    const app = verifiedApplication(ownerId);
    return app ? officialState(app.state || "") : "";
  }

  // The fields the hub is built from (see hubs.js fieldsFromLocation).
  const locationFor = (row) => ({
    id: row.id,
    name: row.location_name,
    state: row.state || "",
    city: row.city,
    district: row.district,
    area: row.area,
    pin: row.pin_code,
    url: row.location_url || "",
  });

  // Shape sent to the browser. Partners never see another partner's rows or the admin-only details.
  function toDto(row, { admin = false } = {}) {
    const dto = {
      id: row.id,
      name: row.location_name,
      state: row.state || "",
      city: row.city,
      district: row.district,
      area: row.area,
      pin: row.pin_code,
      url: row.location_url || "",
      status: row.status,
      rejectReason: row.reject_reason || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedAt: row.decided_at || "",
    };
    if (admin) {
      dto.appliedBy = row.applied_by_name || row.owner_login_id;
      dto.appliedRole = row.owner_role;
      dto.ownerLoginId = row.owner_login_id;
      dto.updatedBy = row.updated_by || "";
      dto.decidedBy = row.decided_by || "";
      const hub = hubService.findBySourceLocation(row.id);
      dto.hub = hub ? { id: hub.id, name: hub.name, status: hub.status } : null;
    }
    return dto;
  }

  const getRow = (id) =>
    db.prepare("SELECT * FROM partner_locations WHERE id=?").get(id);

  function requireRow(id) {
    const row = getRow(String(id || ""));
    if (!row) throw new LocationError(404, "This location was not found.");
    return row;
  }

  // A location with the same details counts as a duplicate while it is in one of the given statuses.
  // ownerId "" checks every partner (used by the admin); otherwise only that partner's own locations are checked.
  function findDuplicate(
    ownerId,
    key,
    exceptId = "",
    statuses = [LOCATION_STATUS.PENDING, LOCATION_STATUS.ACTIVE],
  ) {
    const marks = statuses.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id FROM partner_locations
         WHERE duplicate_key=? AND status IN (${marks}) AND id<>?
           AND (owner_account_id=? OR ?=1)
         LIMIT 1`,
      )
      .get(
        key,
        ...statuses,
        exceptId,
        ownerId || "",
        ownerId ? 0 : 1,
      );
  }

  function isSubmissionDuplicate(ownerId, submissionKey) {
    return !!db
      .prepare(
        "SELECT id FROM partner_locations WHERE owner_account_id=? AND submission_key=?",
      )
      .get(ownerId, submissionKey);
  }

  function insertWithFreeId(row) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const id = randomId();
        db.prepare(
          `INSERT INTO partner_locations(id,owner_account_id,owner_login_id,owner_role,applied_by_name,
            location_name,state,city,district,area,pin_code,location_url,duplicate_key,status,submission_key,
            created_at,updated_at,updated_by)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          row.ownerId,
          row.ownerLoginId,
          row.ownerRole,
          row.appliedBy,
          row.v.name,
          row.v.state,
          row.v.city,
          row.v.district,
          row.v.area,
          row.v.pin,
          row.url,
          duplicateKey(row.v),
          LOCATION_STATUS.PENDING,
          row.submissionKey,
          row.at,
          row.at,
          row.actor,
        );
        return id;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // A repeated submission key from the same partner returns the record it already created (see submit).
        if (row.submissionKey && isSubmissionDuplicate(row.ownerId, row.submissionKey))
          return null;
      }
    }
    throw new LocationError(500, "Could not create a location ID. Please try again.");
  }

  // ---------- partner side ----------
  // account: the signed-in vendor or franchise account. submissionKey: a value the browser creates once per form,
  // so a double click or a retry after a slow network does not create a second location.
  function submit(account, input = {}, submissionKey = "") {
    const key = clean(submissionKey).slice(0, 80);
    if (key) {
      const prior = db
        .prepare(
          "SELECT * FROM partner_locations WHERE owner_account_id=? AND submission_key=?",
        )
        .get(account.id, key);
      if (prior) return { duplicate: true, location: toDto(prior) };
    }
    const v = validateLocationInput(withDefaultState(account.id, input));
    const url = cleanMapUrl(input.url);
    const dup = findDuplicate(account.id, duplicateKey(v));
    if (dup)
      throw new LocationError(
        409,
        "This location has already been submitted.",
        "name",
      );
    const at = now();
    const appliedBy = clean(account.name) || account.login_id;
    const id = insertWithFreeId({
      ownerId: account.id,
      ownerLoginId: account.login_id,
      ownerRole: account.role,
      appliedBy,
      v,
      url,
      submissionKey: key || null,
      at,
      actor: account.login_id,
    });
    if (!id) {
      const prior = db
        .prepare(
          "SELECT * FROM partner_locations WHERE owner_account_id=? AND submission_key=?",
        )
        .get(account.id, key);
      return { duplicate: true, location: toDto(prior) };
    }
    audit(account.login_id, "location.submit", { id, ...v, url });
    return { duplicate: false, location: toDto(getRow(id)) };
  }

  function withDefaultState(ownerId, input) {
    if (clean(input.state)) return input;
    return { ...input, state: verifiedState(ownerId) };
  }

  // Partner edit / delete. Only the owner can change a location, and only while it is not approved:
  // Pending Approval and Rejected locations can be edited (a Rejected one goes back to Pending Approval),
  // Active (approved) locations are read-only for the partner.
  function requireOwnRow(account, id) {
    const row = getRow(String(id || ""));
    if (!row || row.owner_account_id !== account.id)
      throw new LocationError(404, "This location was not found.");
    return row;
  }

  function updateOwn(account, id, input = {}) {
    const row = requireOwnRow(account, id);
    if (row.status === LOCATION_STATUS.ACTIVE)
      throw new LocationError(
        409,
        "This location is approved and can no longer be changed. Contact On The Way Logistics for a change.",
      );
    const merged = {
      name: input.name ?? row.location_name,
      state: clean(input.state) || row.state || verifiedState(account.id),
      city: input.city ?? row.city,
      district: input.district ?? row.district,
      area: input.area ?? row.area,
      pin: input.pin ?? row.pin_code,
    };
    const v = validateLocationInput(merged);
    const url = input.url === undefined ? row.location_url || "" : cleanMapUrl(input.url);
    const key = duplicateKey(v);
    if (findDuplicate(account.id, key, row.id))
      throw new LocationError(409, "This location has already been submitted.", "name");
    const at = now();
    const resubmit = row.status === LOCATION_STATUS.REJECTED;
    db.prepare(
      `UPDATE partner_locations SET location_name=?,state=?,city=?,district=?,area=?,pin_code=?,location_url=?,
         duplicate_key=?,status=?,reject_reason='',updated_at=?,updated_by=? WHERE id=?`,
    ).run(
      v.name,
      v.state,
      v.city,
      v.district,
      v.area,
      v.pin,
      url,
      key,
      LOCATION_STATUS.PENDING,
      at,
      account.login_id,
      row.id,
    );
    audit(account.login_id, resubmit ? "location.resubmit" : "location.partner_edit", { id: row.id, ...v, url });
    return toDto(getRow(row.id));
  }

  function removeOwn(account, id) {
    const row = requireOwnRow(account, id);
    if (row.status === LOCATION_STATUS.ACTIVE)
      throw new LocationError(
        409,
        "This location is approved and can no longer be deleted. Contact On The Way Logistics to remove it.",
      );
    db.prepare("DELETE FROM partner_locations WHERE id=?").run(row.id);
    audit(account.login_id, "location.partner_delete", { id: row.id, name: row.location_name });
    return { ok: true, id: row.id };
  }

  // A partner sees only the locations they submitted, with their current status.
  function listOwn(account) {
    return db
      .prepare(
        "SELECT * FROM partner_locations WHERE owner_account_id=? ORDER BY created_at DESC",
      )
      .all(account.id)
      .map((r) => toDto(r));
  }

  // ---------- admin side ----------
  function listAll({ status = "" } = {}) {
    const rows = status
      ? db
          .prepare(
            "SELECT * FROM partner_locations WHERE status=? ORDER BY created_at DESC",
          )
          .all(status)
      : db
          .prepare("SELECT * FROM partner_locations ORDER BY created_at DESC")
          .all();
    return rows.map((r) => toDto(r, { admin: true }));
  }

  // Approve: the location becomes Active and its hub is created in Hub List, in one transaction.
  // Approving again returns the existing hub; it never adds a second one.
  function approve(id, adminEmail) {
    const row = requireRow(id);
    if (row.status === LOCATION_STATUS.ACTIVE) {
      const hub = hubService.findBySourceLocation(row.id);
      if (hub) {
        return { location: toDto(row, { admin: true }), hub, hubCreated: false };
      }
    }
    const result = inTransaction(() => {
      const current = requireRow(id);
      // Re-check duplicates: another identical location may have been approved since this one was submitted.
      if (findDuplicate("", current.duplicate_key, current.id, [LOCATION_STATUS.ACTIVE]))
        throw new LocationError(
          409,
          "An active location with the same details already exists.",
        );
      if (!current.state)
        throw new LocationError(
          400,
          "This location has no State yet. Use Edit to choose its State, then approve it again.",
          "state",
        );
      const at = now();
      db.prepare(
        "UPDATE partner_locations SET status=?,reject_reason='',decided_at=?,decided_by=?,updated_at=?,updated_by=? WHERE id=?",
      ).run(LOCATION_STATUS.ACTIVE, at, adminEmail, at, adminEmail, id);
      return hubService.createFromLocation(
        locationFor(current),
        verifiedContact(current.owner_account_id),
        adminEmail,
      );
    });
    audit(adminEmail, "location.approve", {
      id,
      hubId: result.hub.id,
      hubCreated: result.created,
    });
    return {
      location: toDto(getRow(id), { admin: true }),
      hub: result.hub,
      hubCreated: result.created,
    };
  }

  function reject(id, adminEmail, reason = "") {
    const row = requireRow(id);
    if (row.status === LOCATION_STATUS.REJECTED)
      return toDto(row, { admin: true });
    if (row.status === LOCATION_STATUS.ACTIVE)
      throw new LocationError(
        409,
        "An approved location cannot be rejected. Delete it instead; its hub is then set to Inactive.",
      );
    const at = now();
    db.prepare(
      "UPDATE partner_locations SET status=?,reject_reason=?,decided_at=?,decided_by=?,updated_at=?,updated_by=? WHERE id=?",
    ).run(
      LOCATION_STATUS.REJECTED,
      clean(reason).slice(0, 300),
      at,
      adminEmail,
      at,
      adminEmail,
      id,
    );
    audit(adminEmail, "location.reject", { id, reason: clean(reason) });
    return toDto(getRow(id), { admin: true });
  }

  // Edit: send any of the six fields. Blank values are not allowed; the status never changes here.
  // An approved location's hub is updated in the same transaction, so both always agree.
  function update(id, input = {}, adminEmail) {
    const row = requireRow(id);
    const merged = {
      name: input.name ?? row.location_name,
      state: input.state ?? row.state,
      city: input.city ?? row.city,
      district: input.district ?? row.district,
      area: input.area ?? row.area,
      pin: input.pin ?? row.pin_code,
    };
    const v = validateLocationInput(merged);
    const url = input.url === undefined ? row.location_url || "" : cleanMapUrl(input.url);
    const key = duplicateKey(v);
    if (key !== row.duplicate_key && findDuplicate("", key, row.id))
      throw new LocationError(
        409,
        "Another location with these details already exists.",
        "name",
      );
    const at = now();
    inTransaction(() => {
      db.prepare(
        `UPDATE partner_locations SET location_name=?,state=?,city=?,district=?,area=?,pin_code=?,location_url=?,
           duplicate_key=?,updated_at=?,updated_by=? WHERE id=?`,
      ).run(v.name, v.state, v.city, v.district, v.area, v.pin, url, key, at, adminEmail, id);
      if (row.status === LOCATION_STATUS.ACTIVE)
        hubService.syncFromLocation(locationFor(getRow(id)), adminEmail);
    });
    audit(adminEmail, "location.edit", { id, ...v, url });
    return toDto(getRow(id), { admin: true });
  }

  // Delete: a pending or rejected location is simply removed. An approved location is removed too, but its hub
  // is only set to Inactive (its details are kept), never deleted.
  function remove(id, adminEmail) {
    const row = requireRow(id);
    let hub = null;
    inTransaction(() => {
      if (row.status === LOCATION_STATUS.ACTIVE)
        hub = hubService.deactivateFromLocation(locationFor(row), adminEmail);
      db.prepare("DELETE FROM partner_locations WHERE id=?").run(id);
    });
    audit(adminEmail, "location.delete", {
      id,
      name: row.location_name,
      ownerLoginId: row.owner_login_id,
      hubId: hub?.id || "",
      hubStatus: hub?.status || "",
    });
    return {
      ok: true,
      id,
      hub: hub ? { id: hub.id, name: hub.name, status: hub.status } : null,
    };
  }

  // Counts for the dashboard header and the partner summary cards.
  function counts() {
    const out = { pending: 0, active: 0, rejected: 0, total: 0 };
    for (const r of db
      .prepare("SELECT status, COUNT(*) AS n FROM partner_locations GROUP BY status")
      .all()) {
      out.total += r.n;
      if (r.status === LOCATION_STATUS.PENDING) out.pending = r.n;
      else if (r.status === LOCATION_STATUS.ACTIVE) out.active = r.n;
      else if (r.status === LOCATION_STATUS.REJECTED) out.rejected = r.n;
    }
    return out;
  }

  return {
    submit,
    listOwn,
    defaultState: (account) => verifiedState(account.id),
    updateOwn,
    removeOwn,
    listAll,
    approve,
    reject,
    update,
    remove,
    counts,
    toDto,
  };
}

// HTTP routes. partnerGuard: requireRole("vendor","franchise"). adminGuard: requireRole("admin").
export function registerLocationRoutes(app, { partnerGuard, adminGuard, service }) {
  const fail = (res, err, context) => {
    // HubError: a rule from Hub List (for example "that hub name already exists"), shown to the admin as is.
    if (err instanceof LocationError || err instanceof HubError) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.field ? { field: err.field } : {}),
        ...(err.errors?.length ? { errors: err.errors } : {}),
      });
    }
    console.error(context, err && err.message);
    return res
      .status(500)
      .json({ error: "Something went wrong on the server. Please try again." });
  };
  const noStore = (res) => res.set("Cache-Control", "private, no-store");

  // Partner (vendor / franchise) routes: each partner only ever sees and submits their own locations.
  app.get("/api/portal/locations", partnerGuard, (req, res) => {
    try {
      noStore(res);
      res.json({
        ok: true,
        locations: service.listOwn(req.account),
        defaultState: service.defaultState(req.account),
      });
    } catch (err) {
      fail(res, err, "Could not load locations:");
    }
  });

  app.post("/api/portal/locations", partnerGuard, (req, res) => {
    try {
      const body = req.body || {};
      const out = service.submit(req.account, body, body.submissionKey);
      res.status(out.duplicate ? 200 : 201).json({
        ok: true,
        duplicate: out.duplicate,
        message: out.duplicate
          ? "This location was already submitted."
          : "Location submitted successfully. Waiting for Admin Approval.",
        location: out.location,
      });
    } catch (err) {
      fail(res, err, "Could not submit the location:");
    }
  });

  app.patch("/api/portal/locations/:id", partnerGuard, (req, res) => {
    try {
      res.json({
        ok: true,
        location: service.updateOwn(req.account, req.params.id, req.body || {}),
        message: "Location updated. It is waiting for Admin Approval.",
      });
    } catch (err) {
      fail(res, err, "Could not update the location:");
    }
  });

  app.delete("/api/portal/locations/:id", partnerGuard, (req, res) => {
    try {
      res.json({ ...service.removeOwn(req.account, req.params.id), message: "Location deleted." });
    } catch (err) {
      fail(res, err, "Could not delete the location:");
    }
  });

  // Admin routes: full list, approve / reject, edit, delete.
  app.get("/api/admin/locations", adminGuard, (req, res) => {
    try {
      noStore(res);
      const status = typeof req.query.status === "string" ? req.query.status : "";
      res.json({
        ok: true,
        locations: service.listAll({ status }),
        counts: service.counts(),
      });
    } catch (err) {
      fail(res, err, "Could not load locations:");
    }
  });

  app.post("/api/admin/locations/:id/approve", adminGuard, (req, res) => {
    try {
      const out = service.approve(req.params.id, req.adminEmail);
      res.json({
        ok: true,
        location: out.location,
        hub: out.hub,
        hubCreated: out.hubCreated,
        message: out.hubCreated
          ? "Location approved and successfully added to Hub List."
          : "This location is already in Hub List.",
      });
    } catch (err) {
      fail(res, err, "Could not approve the location:");
    }
  });

  app.post("/api/admin/locations/:id/reject", adminGuard, (req, res) => {
    try {
      res.json({
        ok: true,
        location: service.reject(req.params.id, req.adminEmail, req.body?.reason),
        message: "Location rejected.",
      });
    } catch (err) {
      fail(res, err, "Could not reject the location:");
    }
  });

  app.patch("/api/admin/locations/:id", adminGuard, (req, res) => {
    try {
      res.json({
        ok: true,
        location: service.update(req.params.id, req.body || {}, req.adminEmail),
        message: "Location updated.",
      });
    } catch (err) {
      fail(res, err, "Could not update the location:");
    }
  });

  app.delete("/api/admin/locations/:id", adminGuard, (req, res) => {
    try {
      const out = service.remove(req.params.id, req.adminEmail);
      res.json({
        ...out,
        message: out.hub
          ? `Location deleted. Its hub "${out.hub.name}" is now Inactive in Hub List; its details are kept.`
          : "Location deleted.",
      });
    } catch (err) {
      fail(res, err, "Could not delete the location:");
    }
  });
}
