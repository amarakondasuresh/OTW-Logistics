// Hub Management: the hub master list (Admin Portal only).
//
// Hubs live in the `hubs` table of the same SQLite database as the rest of the backend. hub-routes.js exposes
// these rules over HTTP; this file holds the rules themselves so they can be tested without the web framework.
//
// Duplicate rule: a hub is identified by its Hub Name (letter case and extra spaces are ignored). The database
// enforces it with a UNIQUE column, and every write checks it first so the admin gets a clear message.
//
// Import rule: an imported row never overwrites a value that is already saved. It only fills fields that are blank.
// A different non-blank value is reported as a conflict, and an admin changes it deliberately with Edit.
import crypto from "node:crypto";

export const HUB_STATUSES = ["Active", "Inactive"];
// The 15 fields of the Hub Details form, in form order.
export const HUB_FORM_FIELDS = [
  "hiName",
  "phone",
  "name",
  "location",
  "address",
  "pincode",
  "city",
  "district",
  "state",
  "contactNumber",
  "email",
  "manager",
  "openingDate",
  "status",
  "url",
];
// Excel master columns that older data uses. They are kept (never dropped) but are not shown in the form.
export const HUB_LEGACY_FIELDS = ["code", "pod", "region"];
export const HUB_DATA_FIELDS = [...HUB_FORM_FIELDS, ...HUB_LEGACY_FIELDS];
export const MAX_IMPORT_ROWS = 2000;

const COLUMN = {
  hiName: "hi_name",
  phone: "phone",
  name: "name",
  location: "location",
  address: "address",
  pincode: "pincode",
  city: "city",
  district: "district",
  state: "state",
  contactNumber: "contact_number",
  email: "email",
  manager: "manager",
  openingDate: "opening_date",
  status: "status",
  url: "url",
  code: "code",
  pod: "pod",
  region: "region",
};
export const HUB_LABEL = {
  hiName: "Hub In-Charge Full Name",
  phone: "Phone Number",
  name: "Hub Name",
  location: "Hub Location",
  address: "Hub Address",
  pincode: "Hub Pincode",
  city: "City",
  district: "District",
  state: "State",
  contactNumber: "Hub Contact Number",
  email: "Hub Email ID",
  manager: "Hub Manager Name",
  openingDate: "Hub Opening Date",
  status: "Hub Status",
  url: "Hub URL",
  code: "Hub Code",
  pod: "POD",
  region: "Region",
};
const MAX_LENGTH = {
  hiName: 100,
  location: 160,
  address: 400,
  city: 100,
  district: 100,
  state: 100,
  manager: 100,
  name: 120,
  code: 60,
  pod: 60,
  region: 60,
};
const DEFAULT_MAX_LENGTH = 200;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const COLS = [
  "id",
  "name_key",
  ...HUB_DATA_FIELDS.map((k) => COLUMN[k]),
  "contacts",
  "notes",
  "created_at",
  "updated_at",
  "updated_by",
];

export class HubError extends Error {
  constructor(status, message, field = "", errors = []) {
    super(message);
    this.status = status;
    this.field = field;
    this.errors = errors;
  }
}

const clean = (v) =>
  (v === null || v === undefined ? "" : String(v)).replace(/\s+/g, " ").trim();
const pad2 = (n) => String(n).padStart(2, "0");
export const nameKey = (v) => clean(v).toLowerCase();
const isUniqueViolation = (err) =>
  /UNIQUE constraint failed/.test(String(err?.message || ""));
function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// ---------- field rules ----------
// Each rule returns {value} or {error}. Error text is written for the admin, naming the field.
function normalizeText(raw, max, label) {
  const s = clean(raw);
  if (s.length > max)
    return { error: `${label} is too long (maximum ${max} characters).` };
  return { value: s };
}

export function normalizeMobiles(raw, label) {
  const s = clean(raw);
  if (!s) return { value: "" };
  const numbers = [];
  for (const part of s
    .split(/[,;\/]+/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    let digits = part.replace(/[\s().-]/g, "");
    if (digits.startsWith("+91")) digits = digits.slice(3);
    else if (/^91\d{10}$/.test(digits)) digits = digits.slice(2);
    else if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
    if (!/^[6-9]\d{9}$/.test(digits)) {
      return {
        error: `${label} "${part}" is not a valid 10-digit mobile number (it must start with 6, 7, 8 or 9). Separate several numbers with commas.`,
      };
    }
    numbers.push(digits);
  }
  return { value: numbers.join(", ") };
}

function normalizePincode(raw, label) {
  const s = clean(raw).replace(/\s/g, "").replace(/\.0$/, "");
  if (!s) return { value: "" };
  if (!/^[1-9]\d{5}$/.test(s))
    return {
      error: `${label} must be a 6-digit PIN code (for example 522002).`,
    };
  return { value: s };
}

function normalizeEmail(raw, label) {
  const s = clean(raw);
  if (!s) return { value: "" };
  if (s.length > 254 || !EMAIL_RE.test(s))
    return {
      error: `${label} must be a valid email address (for example hub@example.com).`,
    };
  return { value: s };
}

function normalizeUrl(raw, label) {
  let s = clean(raw);
  if (!s) return { value: "" };
  if (/^www\./i.test(s)) s = `https://${s}`;
  const invalid = {
    error: `${label} must be a full web address that starts with http:// or https:// (for example https://www.example.com).`,
  };
  let url;
  try {
    url = new URL(s);
  } catch {
    return invalid;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname.includes(".")
  )
    return invalid;
  if (s.length > 300)
    return { error: `${label} is too long (maximum 300 characters).` };
  return { value: s };
}

// Accepts 2024-03-15, 15/03/2024 (day/month/year, as used in India), 15-03-24 and 15.03.2024.
export function normalizeDate(raw, label) {
  const s = clean(raw);
  if (!s) return { value: "" };
  let y, m, d, match;
  if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else if (
    (match = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})$/))
  ) {
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3]);
    if (match[3].length === 2) y += 2000;
  } else {
    return {
      error: `${label} must be a date such as 15/03/2024 (day/month/year) or 2024-03-15.`,
    };
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d ||
    y < 1950 ||
    y > 2100
  ) {
    return { error: `${label} is not a valid date.` };
  }
  return { value: `${y}-${pad2(m)}-${pad2(d)}` };
}

function normalizeStatus(raw, label) {
  const s = clean(raw).toLowerCase();
  if (!s) return { value: "" };
  if (s === "active") return { value: "Active" };
  if (s === "inactive") return { value: "Inactive" };
  return { error: `${label} must be Active or Inactive.` };
}

// Checks and tidies the hub fields that were sent. Returns {values, errors}; values holds only the fields sent.
//   mode 'form'    Add / Edit forms: full rules. partial: true for an Edit that changes some fields only.
//   mode 'excel'   Excel / CSV imports: full rules.
//   mode 'lenient' Records restored from older data: only Hub Name is required, so older data is never rejected.
export function normalizeHubInput(
  input = {},
  { mode = "form", partial = false } = {},
) {
  const values = {};
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const strict = mode !== "lenient";
  for (const key of HUB_DATA_FIELDS) {
    if (input[key] === undefined) continue;
    const raw = input[key];
    const label = HUB_LABEL[key];
    let r;
    switch (key) {
      case "phone":
      case "contactNumber":
        r = strict
          ? normalizeMobiles(raw, label)
          : { value: clean(raw).slice(0, 200) };
        break;
      case "pincode":
        r = strict
          ? normalizePincode(raw, label)
          : { value: clean(raw).slice(0, 20) };
        break;
      case "email":
        r = strict
          ? normalizeEmail(raw, label)
          : { value: clean(raw).slice(0, 254) };
        break;
      case "url":
        r = strict
          ? normalizeUrl(raw, label)
          : { value: clean(raw).slice(0, 300) };
        break;
      case "openingDate":
        r = normalizeDate(raw, label);
        if (!strict && r.error) r = { value: "" };
        break;
      case "status":
        r = normalizeStatus(raw, label);
        if (!strict && r.error) r = { value: "" };
        break;
      default:
        r = normalizeText(raw, MAX_LENGTH[key] || DEFAULT_MAX_LENGTH, label);
        if (!strict && r.error)
          r = {
            value: clean(raw).slice(0, MAX_LENGTH[key] || DEFAULT_MAX_LENGTH),
          };
    }
    if (r.error) fail(key, r.error);
    else values[key] = r.value;
  }
  // Required fields: Hub Name always; State for forms and Excel imports. With partial edits, only when sent.
  const requiredKeys = strict ? ["name", "state"] : ["name"];
  for (const key of requiredKeys) {
    if ((!partial || input[key] !== undefined) && !values[key])
      fail(key, `${HUB_LABEL[key]} is required.`);
  }
  if (partial && input.status !== undefined && !values.status)
    fail("status", `${HUB_LABEL.status} must be Active or Inactive.`);
  return { values, errors };
}

export function sanitizeContacts(list) {
  return (Array.isArray(list) ? list : [])
    .map((c) => ({
      name: clean(c?.name).slice(0, 100),
      phone: clean(c?.phone).slice(0, 200),
    }))
    .filter((c) => c.name || c.phone);
}

export function sanitizeNotes(list) {
  return (Array.isArray(list) ? list : [])
    .map((n) => ({
      id: clean(n?.id).slice(0, 64) || crypto.randomUUID(),
      text: clean(n?.text).slice(0, 500),
      vacancies: Math.max(
        0,
        Math.min(9999, Math.trunc(Number(n?.vacancies)) || 0),
      ),
      date: clean(n?.date).slice(0, 40),
    }))
    .filter((n) => n.text);
}

function mergeUnique(stored, incoming, keyOf) {
  const seen = new Set(stored.map(keyOf));
  const merged = [...stored];
  for (const item of incoming) {
    const k = keyOf(item);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(item);
    }
  }
  return merged;
}

// ---------- storage ----------
export function createHubService({
  db,
  audit = () => {},
  now = () => new Date().toISOString(),
  seedRows = [],
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hubs(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      hi_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      pincode TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      district TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      contact_number TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      manager TEXT NOT NULL DEFAULT '',
      opening_date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Active',
      url TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      pod TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      contacts TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS hub_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Hubs created from an approved Franchise / Vendor location keep that location's ID here.
  // The unique index means one location can never create two hubs. Hubs added by hand keep this empty (NULL).
  const hubColumns = db.prepare("PRAGMA table_info(hubs)").all().map((c) => c.name);
  if (!hubColumns.includes("source_location_id"))
    db.exec("ALTER TABLE hubs ADD COLUMN source_location_id TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS hubs_source_location ON hubs(source_location_id)",
  );

  const insertSql = `INSERT INTO hubs(${COLS.join(",")}) VALUES(${COLS.map(() => "?").join(",")})`;
  const insertStmt = db.prepare(insertSql);
  const selectAll = db.prepare("SELECT * FROM hubs ORDER BY id");
  const selectById = db.prepare("SELECT * FROM hubs WHERE id=?");
  const selectByKey = db.prepare("SELECT * FROM hubs WHERE name_key=?");

  const toApi = (row) => ({
    id: row.id,
    name: row.name,
    hiName: row.hi_name,
    phone: row.phone,
    location: row.location,
    address: row.address,
    pincode: row.pincode,
    city: row.city,
    district: row.district,
    state: row.state,
    contactNumber: row.contact_number,
    email: row.email,
    manager: row.manager,
    openingDate: row.opening_date,
    status: row.status,
    url: row.url,
    code: row.code,
    pod: row.pod,
    region: row.region,
    contacts: parseJson(row.contacts, []),
    notes: parseJson(row.notes, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    sourceLocationId: row.source_location_id || "",
  });

  // Hub ids look like XH-001, XH-002 ... Counting continues from the highest id already in use.
  function idAllocator() {
    let max = 0;
    for (const r of db
      .prepare("SELECT id FROM hubs WHERE id LIKE 'XH-%'")
      .all()) {
      const n = Number(String(r.id).slice(3));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return () => `XH-${String(++max).padStart(3, "0")}`;
  }

  // One row in the column order of COLS.
  function rowFor(
    values,
    {
      id,
      nameKey: key,
      contacts = [],
      notes = [],
      createdAt,
      updatedAt,
      updatedBy,
    },
  ) {
    const byColumn = {
      id,
      name_key: key,
      contacts: JSON.stringify(contacts),
      notes: JSON.stringify(notes),
      created_at: createdAt,
      updated_at: updatedAt,
      updated_by: updatedBy,
    };
    for (const k of HUB_DATA_FIELDS) byColumn[COLUMN[k]] = values[k] ?? "";
    byColumn.status = values.status || "Active";
    return COLS.map((c) => byColumn[c]);
  }

  function list() {
    return selectAll.all().map(toApi);
  }

  function get(id) {
    const row = selectById.get(String(id));
    return row ? toApi(row) : null;
  }

  function requireRow(id) {
    const row = selectById.get(String(id));
    if (!row)
      throw new HubError(
        404,
        "This hub no longer exists. Reload the list and try again.",
      );
    return row;
  }

  function create(input, actor = "") {
    const { values, errors } = normalizeHubInput(input, { mode: "form" });
    if (errors.length)
      throw new HubError(400, errors[0].message, errors[0].field, errors);
    const key = nameKey(values.name);
    if (selectByKey.get(key)) {
      throw new HubError(
        409,
        "A hub with this Hub Name already exists. Use Edit on that hub instead of adding it again.",
        "name",
      );
    }
    const id = idAllocator()();
    const stamp = now();
    try {
      insertStmt.run(
        ...rowFor(values, {
          id,
          nameKey: key,
          createdAt: stamp,
          updatedAt: stamp,
          updatedBy: actor,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new HubError(
          409,
          "A hub with this Hub Name already exists.",
          "name",
        );
      throw err;
    }
    audit(actor, "hub_created", { id, name: values.name });
    return get(id);
  }

  // Changes only the fields that were sent and that actually differ from what is saved.
  function update(id, input, actor = "") {
    const current = requireRow(id);
    if (!input || typeof input !== "object")
      throw new HubError(400, "Nothing to save.");
    const { values, errors } = normalizeHubInput(input, {
      mode: "form",
      partial: true,
    });
    if (errors.length)
      throw new HubError(400, errors[0].message, errors[0].field, errors);
    const changes = {};
    for (const key of Object.keys(values)) {
      if (String(current[COLUMN[key]] ?? "") !== values[key])
        changes[key] = values[key];
    }
    const changed = Object.keys(changes);
    if (!changed.length) return { hub: toApi(current), changed };
    const sets = [],
      args = [];
    for (const key of changed) {
      sets.push(`${COLUMN[key]}=?`);
      args.push(changes[key]);
    }
    if ("name" in changes) {
      const key = nameKey(changes.name);
      const other = selectByKey.get(key);
      if (other && other.id !== current.id) {
        throw new HubError(
          409,
          "Another hub already uses this Hub Name.",
          "name",
        );
      }
      sets.push("name_key=?");
      args.push(key);
    }
    sets.push("updated_at=?", "updated_by=?");
    args.push(now(), actor);
    try {
      db.prepare(`UPDATE hubs SET ${sets.join(",")} WHERE id=?`).run(
        ...args,
        current.id,
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new HubError(
          409,
          "Another hub already uses this Hub Name.",
          "name",
        );
      throw err;
    }
    audit(actor, "hub_updated", { id: current.id, changed });
    return { hub: get(current.id), changed };
  }

  function remove(id, actor = "") {
    const current = requireRow(id);
    if (current.source_location_id)
      throw new HubError(
        409,
        "This hub came from an approved Franchise / Vendor location. Delete the location in Submitted Locations instead, which sets this hub to Inactive. Its details are kept.",
      );
    db.prepare("DELETE FROM hubs WHERE id=?").run(current.id);
    audit(actor, "hub_deleted", { id: current.id, name: current.name });
    return { ok: true };
  }

  // Hub down notes (shown under Hub Down Notes on the Hub Management page).
  function addNote(id, input = {}, actor = "") {
    const current = requireRow(id);
    const text = clean(input.text).slice(0, 500);
    if (!text) throw new HubError(400, "Enter the hub down note.", "text");
    const vacancies =
      input.vacancies === undefined || input.vacancies === ""
        ? 0
        : Number(input.vacancies);
    if (!Number.isInteger(vacancies) || vacancies < 0 || vacancies > 9999) {
      throw new HubError(
        400,
        "Vacancies must be a whole number from 0 to 9999.",
        "vacancies",
      );
    }
    const notes = parseJson(current.notes, []);
    const stamp = now();
    notes.push({ id: crypto.randomUUID(), text, vacancies, date: stamp });
    db.prepare(
      "UPDATE hubs SET notes=?, updated_at=?, updated_by=? WHERE id=?",
    ).run(JSON.stringify(notes), stamp, actor, current.id);
    audit(actor, "hub_note_added", { id: current.id, vacancies });
    return { hub: get(current.id) };
  }

  // Imports Excel / CSV rows (or records restored from older browser data).
  // Returns a report. dryRun: true only previews; nothing is written.
  function importRows(
    rows,
    { source = "excel", dryRun = true, actor = "", fileName = "" } = {},
  ) {
    if (!Array.isArray(rows) || !rows.length)
      throw new HubError(400, "The file has no hub rows to import.");
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new HubError(
        400,
        `This file has ${rows.length} rows. Import at most ${MAX_IMPORT_ROWS} rows at a time.`,
      );
    }
    const mode = source === "browser" ? "lenient" : "excel";
    const existing = new Map(
      db
        .prepare("SELECT * FROM hubs")
        .all()
        .map((r) => [r.name_key, r]),
    );
    const allocateId = idAllocator();
    const seenInFile = new Map();
    const stamp = now();
    const report = {
      fileName: clean(fileName).slice(0, 160),
      source,
      dryRun,
      total: rows.length,
      counts: { new: 0, update: 0, existing: 0, duplicate: 0, error: 0 },
      rows: [],
    };
    const plan = [];
    const addRow = (row) => {
      report.counts[row.status] += 1;
      report.rows.push(row);
    };

    rows.forEach((raw, index) => {
      const src = raw && typeof raw === "object" ? raw : {};
      const label = src.sheet
        ? `${clean(src.sheet)}, row ${src.rowNumber || index + 1}`
        : `Row ${src.rowNumber || index + 1}`;
      const input = { ...src };
      if (!clean(input.name) && clean(input.code)) input.name = input.code; // a file with only Hub Code
      const { values, errors } = normalizeHubInput(input, { mode });
      const name = clean(input.name);
      if (errors.length) {
        addRow({
          label,
          name,
          status: "error",
          messages: errors.map((e) => e.message),
          conflicts: [],
        });
        return;
      }
      const key = nameKey(values.name);
      if (seenInFile.has(key)) {
        addRow({
          label,
          name,
          status: "duplicate",
          messages: [
            `Same Hub Name as ${seenInFile.get(key)} in this file. Only the first row is imported.`,
          ],
          conflicts: [],
        });
        return;
      }
      seenInFile.set(key, label);
      const current = existing.get(key);
      if (!current) {
        plan.push({
          kind: "insert",
          id: allocateId(),
          key,
          values,
          contacts: sanitizeContacts(src.contacts),
          notes: sanitizeNotes(src.notes),
        });
        addRow({
          label,
          name: values.name,
          status: "new",
          messages: [],
          conflicts: [],
        });
        return;
      }
      const merge = planMerge(current, values, src);
      const fillLabels = Object.keys(merge.fills).map((k) => HUB_LABEL[k]);
      if (!fillLabels.length && !merge.contactsChanged && !merge.notesChanged) {
        addRow({
          label,
          name: current.name,
          status: "existing",
          messages: ["Already in the system. Nothing new to add."],
          conflicts: merge.conflicts,
        });
        return;
      }
      plan.push({
        kind: "update",
        id: current.id,
        fills: merge.fills,
        contacts: merge.contacts,
        notes: merge.notes,
        contactsChanged: merge.contactsChanged,
        notesChanged: merge.notesChanged,
      });
      const messages = [];
      if (fillLabels.length)
        messages.push(`Will fill blank fields: ${fillLabels.join(", ")}.`);
      if (merge.contactsChanged)
        messages.push("Will add contact(s) not yet saved.");
      if (merge.notesChanged) messages.push("Will add note(s) not yet saved.");
      addRow({
        label,
        name: current.name,
        status: "update",
        messages,
        conflicts: merge.conflicts,
      });
    });

    if (!dryRun && plan.length) {
      db.exec("BEGIN");
      try {
        for (const item of plan) {
          if (item.kind === "insert") {
            insertStmt.run(
              ...rowFor(item.values, {
                id: item.id,
                nameKey: item.key,
                contacts: item.contacts,
                notes: item.notes,
                createdAt: stamp,
                updatedAt: stamp,
                updatedBy: actor,
              }),
            );
          } else {
            const sets = [],
              args = [];
            for (const [key, value] of Object.entries(item.fills)) {
              sets.push(`${COLUMN[key]}=?`);
              args.push(value);
            }
            if (item.contactsChanged) {
              sets.push("contacts=?");
              args.push(JSON.stringify(item.contacts));
            }
            if (item.notesChanged) {
              sets.push("notes=?");
              args.push(JSON.stringify(item.notes));
            }
            sets.push("updated_at=?", "updated_by=?");
            args.push(stamp, actor, item.id);
            db.prepare(`UPDATE hubs SET ${sets.join(",")} WHERE id=?`).run(
              ...args,
            );
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      audit(actor, "hub_import", {
        fileName: report.fileName,
        source,
        total: report.total,
        ...report.counts,
      });
    }
    return report;
  }

  // Compares an import row with the saved hub: fills blanks, lists different values as conflicts.
  function planMerge(current, values, src) {
    const fills = {},
      conflicts = [];
    for (const key of HUB_DATA_FIELDS) {
      if (key === "name") continue; // the row already matched this hub by name, ignoring case and spacing
      const incoming = values[key];
      if (incoming === undefined || incoming === "") continue;
      const stored = String(current[COLUMN[key]] ?? "");
      if (stored === "") fills[key] = incoming;
      else if (stored !== incoming)
        conflicts.push({
          field: key,
          label: HUB_LABEL[key],
          current: stored,
          incoming,
        });
    }
    const storedContacts = parseJson(current.contacts, []);
    const contacts = mergeUnique(
      storedContacts,
      sanitizeContacts(src.contacts),
      (c) => `${c.name}|${c.phone}`,
    );
    const storedNotes = parseJson(current.notes, []);
    const notes = mergeUnique(
      storedNotes,
      sanitizeNotes(src.notes),
      (n) => `${n.text}|${n.date}`,
    );
    return {
      fills,
      conflicts,
      contacts,
      notes,
      contactsChanged: contacts.length !== storedContacts.length,
      notesChanged: notes.length !== storedNotes.length,
    };
  }

  // ---------- hubs created from approved locations ----------
  // Used by locations.js inside the same database transaction as the approval, so a failure rolls back both.
  const selectBySource = db.prepare("SELECT * FROM hubs WHERE source_location_id=?");
  const insertFromLocationStmt = db.prepare(
    `INSERT INTO hubs(${[...COLS, "source_location_id"].join(",")}) VALUES(${[...COLS, "source_location_id"].map(() => "?").join(",")})`,
  );

  function findBySourceLocation(locationId) {
    const row = selectBySource.get(String(locationId || ""));
    return row ? toApi(row) : null;
  }

  // Maps an approved location to Hub Management fields:
  //   Location Name -> Hub Name, Area -> Hub Location, City / Town -> City, District -> District,
  //   State -> State (the partner chose it), PIN -> Hub Pincode, Location URL -> Hub URL.
  //   In-Charge and Phone come from the verified applicant when available. Everything else stays blank.
  function fieldsFromLocation(loc, contact = {}) {
    const { values, errors } = normalizeHubInput(
      {
        name: loc.name,
        state: loc.state,
        city: loc.city,
        district: loc.district,
        location: loc.area,
        pincode: loc.pin,
        url: loc.url || "",
      },
      { mode: "form" },
    );
    if (errors.length)
      throw new HubError(400, errors[0].message, errors[0].field, errors);
    // Optional fields are kept only when they pass the hub rules; an invalid one is left blank, never guessed.
    const optional = { hiName: contact.name, phone: contact.mobile };
    for (const [key, raw] of Object.entries(optional)) {
      if (!clean(raw)) continue;
      const r = normalizeHubInput({ [key]: raw }, { mode: "form", partial: true });
      if (!r.errors.length && r.values[key]) values[key] = r.values[key];
    }
    return values;
  }

  // Creates the hub for an approved location, once. A location that already has its hub gets that hub back.
  function createFromLocation(loc, contact = {}, actor = "") {
    const existing = selectBySource.get(loc.id);
    if (existing) return { hub: toApi(existing), created: false };
    const values = fieldsFromLocation(loc, contact);
    const key = nameKey(values.name);
    const nameTaken = () =>
      new HubError(
        409,
        `A hub named "${values.name}" is already in Hub List, so this location cannot be added automatically. Change the Location Name, or the existing hub, and approve again.`,
        "name",
      );
    if (selectByKey.get(key)) throw nameTaken();
    const id = idAllocator()();
    const stamp = now();
    try {
      insertFromLocationStmt.run(
        ...rowFor(values, {
          id,
          nameKey: key,
          createdAt: stamp,
          updatedAt: stamp,
          updatedBy: actor,
        }),
        loc.id,
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Another request already created this hub for this location: return it instead of adding a second one.
      const again = selectBySource.get(loc.id);
      if (again) return { hub: toApi(again), created: false };
      throw nameTaken();
    }
    audit(actor, "hub_created_from_location", {
      id,
      name: values.name,
      sourceLocationId: loc.id,
    });
    return { hub: get(id), created: true };
  }

  // An approved location was edited: copy the location fields to its hub. Other hub fields are left as they are.
  function syncFromLocation(loc, actor = "") {
    const row = selectBySource.get(loc.id);
    if (!row) return null;
    return update(
      row.id,
      {
        name: loc.name,
        state: loc.state,
        city: loc.city,
        district: loc.district,
        location: loc.area,
        pincode: loc.pin,
        url: loc.url || "",
      },
      actor,
    ).hub;
  }

  // An approved location was deleted: its hub is set to Inactive, never deleted.
  function deactivateFromLocation(loc, actor = "") {
    const row = selectBySource.get(loc.id);
    if (!row) return null;
    if (row.status === "Inactive") return toApi(row);
    return update(row.id, { status: "Inactive" }, actor).hub;
  }

  // The first start loads the hubs from data/hubs-seed.json, once. Later deletions are never undone by a restart.
  function seedIfNeeded() {
    if (db.prepare("SELECT value FROM hub_meta WHERE key='seed_v1'").get())
      return 0;
    const allocateId = idAllocator();
    let added = 0;
    db.exec("BEGIN");
    try {
      for (const raw of seedRows) {
        const { values } = normalizeHubInput(raw, { mode: "lenient" });
        const key = nameKey(values.name);
        if (!key || selectByKey.get(key)) continue;
        const id =
          raw.id && !selectById.get(String(raw.id))
            ? String(raw.id)
            : allocateId();
        const stamp = now();
        insertStmt.run(
          ...rowFor(values, {
            id,
            nameKey: key,
            contacts: sanitizeContacts(raw.contacts),
            notes: sanitizeNotes(raw.notes),
            createdAt: stamp,
            updatedAt: stamp,
            updatedBy: "seed",
          }),
        );
        added += 1;
      }
      db.prepare("INSERT INTO hub_meta(key,value) VALUES('seed_v1',?)").run(
        String(added),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return added;
  }

  seedIfNeeded();

  return {
    list,
    get,
    create,
    update,
    remove,
    addNote,
    importRows,
    seedIfNeeded,
    findBySourceLocation,
    createFromLocation,
    syncFromLocation,
    deactivateFromLocation,
  };
}
