// Payment Management: the Weekly Payments table (Admin Portal only).
//
// Every imported Excel row is stored in the `weekly_payments` table of the same SQLite database as the rest of the
// backend, one row per rider per week. The weekly amount is stored exactly as read from the Excel sheet (the original
// text of the cell is kept too), separately for each rider and week.
//
// Duplicate rule: permanent Rider ID + exact payment period for verified riders; a stable provisional key
// is used for unverified Excel riders until Admin maps them. The browser parses the workbook, while this
// service verifies registrations, stores provisional rows, and safely transfers them after Admin mapping.
import crypto from "node:crypto";
import { normalizeRiderKey } from "./rider-registrations.js";
import { PAYMENT_STATUSES } from "./report-stats.js";

export const MAX_IMPORT_RECORDS = 20000;

export class WeeklyPaymentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clean = (v) =>
  (v === null || v === undefined ? "" : String(v)).replace(/\s+/g, " ").trim();
// Preserve meaningful text inside brackets (e.g. a rider's hub), while ignoring bracket style,
// punctuation, casing and repeated spaces.
const normalizeRiderName = (v) =>
  clean(v)
    .toLowerCase()
    .replace(/[()[\]{}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const num = (v) =>
  v === null || v === undefined || v === ""
    ? null
    : Number.isFinite(Number(v))
      ? Number(v)
      : null;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);

const COLUMNS = [
  "rider_key",
  "week_key",
  "name_key",
  "week_label",
  "week_start",
  "week_end",
  "rider_name",
  "rider_id",
  "days",
  "total_orders",
  "lm",
  "primary_orders",
  "club",
  "sdd",
  "lm_amount",
  "prime_amount",
  "club_amount",
  "sdd_amount",
  "amount",
  "amount_raw",
  "source_file",
  "sheet",
  "row_number",
  "original",
  "rate_lm",
  "rate_prime",
  "rate_club",
  "rate_sdd",
];
const VALUE_COLUMNS = COLUMNS.slice(3);
const nameKeyOf = (v) =>
  clean(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const moneyOrZero = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? 0
    : Number(v);
// Category amounts keep a missing value as NULL (shown as —), so a blank is never confused with a real ₹0.

// Rider matching against Rider Registration (live applications only). Exact ID + name is preferred;
// a unique normalized name may correct a stale/missing Excel ID. Ambiguous or unmatched rows are
// stored with a stable provisional key and sent to Admin verification; they are never treated as approved.
export function resolveRiders(
  records,
  registrations,
  savedMappings = new Map(),
) {
  // Rider ID is the only key that can connect an Excel row to a rider. Rider Name is never used to find a rider,
  // so a name that matches several riders (or one rider with a different ID) cannot move records between riders.
  const byKey = new Map();
  for (const g of registrations) {
    if (g.rider_key && !byKey.has(g.rider_key)) byKey.set(g.rider_key, g);
  }
  const out = [],
    review = [],
    corrections = [];
  records.forEach((r, i) => {
    const sheetId = normalizeRiderKey(r.riderId);
    const nameKey = normalizeRiderName(r.riderName);
    const label = `${r.riderName || "Unnamed"} (${r.weekLabel || "no week"})`;
    if (r.mappedRiderId) {
      // an Admin chose this approved rider for this pending row
      const mapped = byKey.get(normalizeRiderKey(r.mappedRiderId));
      if (mapped) {
        out.push({
          ...r,
          riderId: mapped.rider_id,
          riderKey: "id:" + String(mapped.rider_id).toLowerCase(),
          riderName: mapped.rider_name,
        });
        return;
      }
      review.push({
        row: i + 1,
        record: r,
        rider: r.riderName,
        reason: `${label}: the mapped Rider ID ${r.mappedRiderId} is no longer an approved rider. Kept pending.`,
      });
      return;
    }
    // A saved Admin mapping is an explicit decision for this Excel rider and is still honoured.
    const savedId = savedMappings.get(nameKey + "|" + sheetId);
    if (savedId) {
      const mapped = byKey.get(normalizeRiderKey(savedId));
      if (mapped) {
        out.push({
          ...r,
          riderId: mapped.rider_id,
          riderKey: "id:" + String(mapped.rider_id).toLowerCase(),
          riderName: mapped.rider_name,
        });
        return;
      }
    }
    const reg = sheetId ? byKey.get(sheetId) : null;
    if (!reg) {
      // Not an approved rider with this Rider ID (missing, unregistered, pending or rejected). Kept pending for Admin; never assigned.
      review.push({
        row: i + 1,
        record: r,
        rider: r.riderName,
        reason: `${label}: Rider ID ${sheetId || "(blank)"} is not in Rider Registration as an APPROVED rider. Saved provisionally; Admin verification is required. No franchise is assigned.`,
      });
      return;
    }
    if (normalizeRiderName(reg.rider_name) !== nameKey) {
      // The ID decides the match. The name in the sheet differs from the registration, so the registered name is shown and the difference is reported.
      corrections.push({
        row: i + 1,
        rider: r.riderName,
        from: r.riderName || "(blank)",
        to: reg.rider_name,
        riderId: reg.rider_id,
      });
    }
    out.push({
      ...r,
      riderId: reg.rider_id,
      riderKey: "id:" + String(reg.rider_id).toLowerCase(),
      riderName: reg.rider_name,
    });
  });
  return { records: out, review, corrections };
}

export function createWeeklyPaymentService({
  db,
  audit = () => {},
  riderRegistry = false,
  // Called after rows were added or changed (import, Admin mapping, re-check after a rider approval):
  // ({importId, fileName, inserted, updated}). Used by the server to notify the partners concerned.
  onSaved = null,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS weekly_payments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rider_key TEXT NOT NULL,
    week_key TEXT NOT NULL,
    name_key TEXT NOT NULL DEFAULT '',
    week_label TEXT NOT NULL,
    week_start TEXT NOT NULL DEFAULT '',
    week_end TEXT NOT NULL DEFAULT '',
    rider_name TEXT NOT NULL,
    rider_id TEXT NOT NULL DEFAULT '',
    days REAL, total_orders REAL, lm REAL, primary_orders REAL, club REAL, sdd REAL,
    lm_amount REAL, prime_amount REAL, club_amount REAL, sdd_amount REAL, amount REAL,
    amount_raw TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL DEFAULT '',
    sheet TEXT NOT NULL DEFAULT '',
    row_number INTEGER,
    original TEXT NOT NULL DEFAULT '{}',
    import_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(rider_key, week_key)
  );
  CREATE INDEX IF NOT EXISTS weekly_payments_week ON weekly_payments(week_start);
  CREATE TABLE IF NOT EXISTS weekly_payment_imports(
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_hash TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL,
    imported_by TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL, inserted INTEGER NOT NULL, updated INTEGER NOT NULL, unchanged INTEGER NOT NULL,
    amount_total REAL NOT NULL DEFAULT 0,
    weeks TEXT NOT NULL DEFAULT '[]'
  );`);

  // Rows that could not be verified against Rider Registration. They are kept here for Admin review, not discarded.
  db.exec(`CREATE TABLE IF NOT EXISTS weekly_payment_pending(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pending_key TEXT NOT NULL UNIQUE,
    excel_rider_id TEXT NOT NULL DEFAULT '',
    rider_name TEXT NOT NULL,
    week_key TEXT NOT NULL,
    week_label TEXT NOT NULL DEFAULT '',
    week_start TEXT NOT NULL DEFAULT '',
    week_end TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    reason TEXT NOT NULL,
    file_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'PENDING',
    mapped_rider_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // Explicit Admin mappings persist across later imports, so a rider mapped once is not mapped again.
  db.exec(`CREATE TABLE IF NOT EXISTS weekly_payment_rider_mappings(
    mapping_key TEXT PRIMARY KEY,
    excel_rider_id TEXT NOT NULL DEFAULT '',
    excel_rider_name TEXT NOT NULL,
    registered_rider_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS weekly_payment_provisional_riders(
    mapping_key TEXT PRIMARY KEY,
    excel_rider_id TEXT NOT NULL DEFAULT '',
    rider_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    reason TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    verified_rider_id TEXT NOT NULL DEFAULT ''
  )`);
  const existingColumns = new Set(
    db
      .prepare("PRAGMA table_info(weekly_payments)")
      .all()
      .map((c) => c.name),
  );
  // Payment status (PENDING / PROCESSING / PAID / FAILED) is set only by the Admin. Excel imports never write this
  // column, so a re-import keeps the status already saved for each rider-week.
  if (!existingColumns.has("payment_status"))
    db.exec(
      "ALTER TABLE weekly_payments ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'PENDING'",
    );
  for (const [name, type] of [
    ["sdd", "REAL"],
    ["total_orders", "REAL"],
    ["lm_amount", "REAL"],
    ["prime_amount", "REAL"],
    ["club_amount", "REAL"],
    ["sdd_amount", "REAL"],
    ["rate_lm", "REAL"],
    ["rate_prime", "REAL"],
    ["rate_club", "REAL"],
    ["rate_sdd", "REAL"],
  ]) {
    if (!existingColumns.has(name))
      db.exec(`ALTER TABLE weekly_payments ADD COLUMN ${name} ${type}`);
  }

  const selectOne = db.prepare(
    "SELECT * FROM weekly_payments WHERE rider_key = ? AND week_key = ?",
  );
  const selectByName = db.prepare(
    "SELECT * FROM weekly_payments WHERE week_key = ? AND name_key = ?",
  );
  const selectByNameAll = selectByName;
  const insertRow = db.prepare(
    `INSERT INTO weekly_payments(${COLUMNS.join(",")},import_id,created_at,updated_at) VALUES(${COLUMNS.map(() => "?").join(",")},?,?,?)`,
  );
  const updateRow = db.prepare(
    `UPDATE weekly_payments SET name_key = ?, ${VALUE_COLUMNS.map((c) => c + " = ?").join(", ")}, import_id = ?, updated_at = ? WHERE id = ?`,
  );
  const insertImport = db.prepare(
    "INSERT INTO weekly_payment_imports(id,file_name,file_hash,imported_at,imported_by,total,inserted,updated,unchanged,amount_total,weeks) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );

  // One record from the browser -> the values to store, or a message saying what is wrong with it.
  function normalise(r, i, fileName) {
    const riderName = clean(r?.riderName),
      riderKey = clean(r?.riderKey),
      weekKey = clean(r?.weekKey),
      weekLabel = clean(r?.weekLabel);
    const isProvisional = riderKey.startsWith("provisional:");
    if (!riderName || !riderKey || (!clean(r?.riderId) && !isProvisional))
      return {
        error: `Record ${i + 1}: a verified Rider ID or provisional rider key and rider name are required.`,
      };
    if (!weekKey || !weekLabel)
      return { error: `Record ${i + 1} (${riderName}): the week is missing.` };
    const weekStart = clean(r.weekStart),
      weekEnd = clean(r.weekEnd);
    if ((weekStart && !ISO.test(weekStart)) || (weekEnd && !ISO.test(weekEnd)))
      return {
        error: `Record ${i + 1} (${riderName}): the week dates are not valid.`,
      };
    for (const f of [
      "days",
      "totalOrders",
      "lm",
      "primary",
      "club",
      "sdd",
      "lmAmount",
      "primeAmount",
      "clubAmount",
      "sddAmount",
      "amount",
      "lmRate",
      "primeRate",
      "clubRate",
      "sddRate",
    ]) {
      if (
        r[f] !== null &&
        r[f] !== undefined &&
        r[f] !== "" &&
        num(r[f]) === null
      )
        return {
          error: `Record ${i + 1} (${riderName}): ${f} is not a number.`,
        };
    }
    let original = "{}";
    try {
      original = JSON.stringify(r.original ?? {}).slice(0, 20000);
    } catch {
      /* keep {} */
    }
    return {
      riderKey: riderKey.slice(0, 200),
      weekKey: weekKey.slice(0, 200),
      nameKey: nameKeyOf(riderName),
      values: [
        weekLabel.slice(0, 200),
        weekStart,
        weekEnd,
        riderName.slice(0, 200),
        clean(r.riderId).slice(0, 100),
        num(r.days),
        num(r.totalOrders),
        num(r.lm),
        num(r.primary),
        num(r.club),
        num(r.sdd),
        num(r.lmAmount),
        num(r.primeAmount),
        num(r.clubAmount),
        num(r.sddAmount),
        moneyOrZero(r.amount),
        clean(r.amountRaw).slice(0, 100),
        clean(fileName).slice(0, 200),
        clean(r.sheet).slice(0, 100),
        Number.isInteger(r.rowNumber) ? r.rowNumber : null,
        original,
        num(r.lmRate),
        num(r.primeRate),
        num(r.clubRate),
        num(r.sddRate),
      ],
    };
  }
  const same = (row, values) => {
    // values order = VALUE_COLUMNS: label, dates, rider, IDs, daily totals, category counts/amounts, total amount, source metadata, rates.
    // Source metadata (file, sheet, row, original cells) is not compared, so re-importing the same figures is "unchanged".
    const cur = [
      row.week_label,
      row.week_start,
      row.week_end,
      row.rider_name,
      row.rider_id,
      row.days,
      row.total_orders,
      row.lm,
      row.primary_orders,
      row.club,
      row.sdd,
      row.lm_amount,
      row.prime_amount,
      row.club_amount,
      row.sdd_amount,
      row.amount,
      row.amount_raw,
      row.rate_lm,
      row.rate_prime,
      row.rate_club,
      row.rate_sdd,
    ];
    const want = [...values.slice(0, 17), ...values.slice(21, 25)];
    return cur.every((c, i) => (c ?? null) === (want[i] ?? null));
  };

  function liveRegistrations() {
    try {
      return db
        .prepare(
          "SELECT rider_id, rider_key, rider_name FROM rider_registrations WHERE application_status = 'APPROVED'",
        )
        .all();
    } catch {
      return [];
    } // the registration table does not exist yet: no rider can be verified
  }
  const mappingKeyOf = (r) =>
    normalizeRiderName(r.riderName) + "|" + normalizeRiderKey(r.riderId);
  const provisionalKeyFor = (name, riderId) =>
    "provisional:" +
    crypto
      .createHash("sha256")
      .update(normalizeRiderName(name) + "|" + normalizeRiderKey(riderId))
      .digest("hex")
      .slice(0, 32);
  const provisionalKeyOf = (r) => provisionalKeyFor(r.riderName, r.riderId);
  const pendingKeyOf = (r) =>
    normalizeRiderName(r.riderName) +
    "|" +
    r.weekKey +
    "|" +
    normalizeRiderKey(r.riderId);
  const upsertPending =
    db.prepare(`INSERT INTO weekly_payment_pending(pending_key, excel_rider_id, rider_name, week_key, week_label, week_start, week_end, payload, reason, file_name, status, mapped_rider_id, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING','',?,?)
    ON CONFLICT(pending_key) DO UPDATE SET payload = excluded.payload, reason = excluded.reason, file_name = excluded.file_name, status = 'PENDING', updated_at = excluded.updated_at`);
  const setPendingReason = db.prepare(
    "UPDATE weekly_payment_pending SET reason = ?, updated_at = ? WHERE id = ?",
  );
  const setPendingImported = db.prepare(
    "UPDATE weekly_payment_pending SET status = 'IMPORTED', mapped_rider_id = ?, reason = 'Imported', updated_at = ? WHERE id = ?",
  );
  const pendingRows = () =>
    db
      .prepare(
        "SELECT * FROM weekly_payment_pending WHERE status = 'PENDING' ORDER BY week_start, rider_name COLLATE NOCASE",
      )
      .all();

  // The one import path. Verified rows are saved; unverified rows are kept as pending; pending rows are re-checked
  // against the current registrations and imported when they now verify. Nothing is rejected as a whole.
  function applyRecords(
    records,
    { fileName, fileHash, actor, recordImport = true },
  ) {
    let review = [],
      corrections = [],
      newVerified = 0,
      pendingVerified = 0,
      pendingStill = 0,
      registeredCount = 0,
      provisionalSaved = 0;
    let toSave = records,
      pendingReview = [],
      pendingResolved = [];
    if (riderRegistry) {
      const regs = liveRegistrations();
      registeredCount = regs.length;
      const pend = pendingRows().map((p) => ({
        ...JSON.parse(p.payload),
        pendingId: p.id,
        mappedRiderId: p.mapped_rider_id || "",
      }));
      const savedMappings = new Map(
        db
          .prepare(
            "SELECT mapping_key, registered_rider_id FROM weekly_payment_rider_mappings",
          )
          .all()
          .map((x) => [x.mapping_key, x.registered_rider_id]),
      );
      const resolved = resolveRiders(
        [...pend, ...records],
        regs,
        savedMappings,
      );
      const isPending = (r) => r.pendingId !== undefined;
      pendingResolved = resolved.records.filter(isPending);
      review = resolved.review.filter((x) => !isPending(x.record));
      pendingReview = resolved.review.filter((x) => isPending(x.record));
      const provisionalRows = resolved.review.map((x) => ({
        ...x.record,
        riderKey: provisionalKeyOf(x.record),
        riderId: "",
      }));
      toSave = [
        ...pendingResolved,
        ...resolved.records.filter((r) => !isPending(r)),
        ...provisionalRows,
      ];
      corrections = resolved.corrections;
      // count each rider-week once: a pending row that the same file also provides is not counted twice
      const keyOf = (r) => normalizeRiderKey(r.riderId) + "|" + r.weekKey;
      const fileKeys = new Set(
        resolved.records.filter((r) => !isPending(r)).map(keyOf),
      );
      newVerified = fileKeys.size;
      pendingVerified = new Set(
        pendingResolved.map(keyOf).filter((k) => !fileKeys.has(k)),
      ).size;
      pendingStill = pendingReview.length;
    }
    const prepared = [],
      errors = [];
    toSave.forEach((r, i) => {
      const n = normalise(r, i, fileName);
      if (n.error) errors.push(n.error);
      else prepared.push(n);
    });
    if (errors.length)
      throw new WeeklyPaymentError(
        400,
        errors.slice(0, 5).join(" ") +
          (errors.length > 5 ? ` (and ${errors.length - 5} more)` : ""),
      );

    // the same rider and week sent twice in one request is counted once
    const unique = new Map();
    prepared.forEach((p) => unique.set(p.riderKey + "\u0000" + p.weekKey, p));

    provisionalSaved = [...unique.values()].filter((p) =>
      p.riderKey.startsWith("provisional:"),
    ).length;

    const conflicts = [];
    for (const p of unique.values()) {
      for (const old of selectByNameAll.all(p.weekKey, p.nameKey)) {
        if (old.rider_key !== p.riderKey)
          conflicts.push({
            rider: old.rider_name,
            riderId: old.rider_id,
            week: old.week_label,
            keptAs: p.values[4],
          });
      }
    }

    const importId = crypto.randomUUID(),
      now = new Date().toISOString();
    const previous = fileHash
      ? db
          .prepare(
            "SELECT file_name, imported_at FROM weekly_payment_imports WHERE file_hash = ? ORDER BY imported_at DESC LIMIT 1",
          )
          .get(fileHash)
      : null;
    let inserted = 0,
      updated = 0,
      unchanged = 0,
      amountTotalPaise = 0;
    const weeks = new Map(),
      touched = new Set();
    db.exec("BEGIN");
    try {
      // When an Admin maps a pending rider, remove that rider's provisional weekly keys before
      // saving under the permanent registered Rider ID. This prevents two rows for the same week.
      for (const r of pendingResolved) {
        const sourcePending = db
          .prepare(
            "SELECT rider_name, excel_rider_id FROM weekly_payment_pending WHERE id = ?",
          )
          .get(r.pendingId);
        if (sourcePending) {
          const oldKey = provisionalKeyFor(
            sourcePending.rider_name,
            sourcePending.excel_rider_id,
          );
          db.prepare(
            "DELETE FROM weekly_payments WHERE rider_key = ? AND week_key = ?",
          ).run(oldKey, r.weekKey);
        }
      }
      for (const p of unique.values()) {
        let row = selectOne.get(p.riderKey, p.weekKey);
        if (row && touched.has(row.id)) row = null;
        if (row && !p.values[4]) p.values[4] = row.rider_id; // never blank out a Rider ID that is already saved
        if (!row) {
          insertRow.run(
            p.riderKey,
            p.weekKey,
            p.nameKey,
            ...p.values,
            importId,
            now,
            now,
          );
          inserted++;
        } else if (same(row, p.values)) {
          unchanged++;
          touched.add(row.id);
        } else {
          updateRow.run(p.nameKey, ...p.values, importId, now, row.id);
          updated++;
          touched.add(row.id);
        }
        amountTotalPaise +=
          p.values[15] === null ? 0 : Math.round(p.values[15] * 100);
        weeks.set(p.weekKey, p.values[0]);
      }
      const upsertProvisional =
        db.prepare(`INSERT INTO weekly_payment_provisional_riders(mapping_key,excel_rider_id,rider_name,status,reason,first_seen_at,updated_at,verified_rider_id)
        VALUES(?,?,?,'PENDING_VERIFICATION',?,?,?,'')
        ON CONFLICT(mapping_key) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at`);
      for (const x of [...review, ...pendingReview]) {
        upsertProvisional.run(
          mappingKeyOf(x.record),
          normalizeRiderKey(x.record.riderId),
          clean(x.record.riderName).slice(0, 200),
          x.reason,
          now,
          now,
        );
      }
      for (const x of review) {
        upsertPending.run(
          pendingKeyOf(x.record),
          normalizeRiderKey(x.record.riderId),
          clean(x.record.riderName).slice(0, 200),
          x.record.weekKey,
          clean(x.record.weekLabel).slice(0, 200),
          x.record.weekStart || "",
          x.record.weekEnd || "",
          JSON.stringify(x.record).slice(0, 20000),
          x.reason,
          clean(fileName).slice(0, 200),
          now,
          now,
        );
      }
      for (const x of pendingReview)
        setPendingReason.run(x.reason, now, x.record.pendingId);
      for (const r of pendingResolved)
        setPendingImported.run(r.riderId, now, r.pendingId);
      if (pendingResolved.length) {
        const updateProvisional = db.prepare(
          `UPDATE weekly_payment_provisional_riders SET status='VERIFIED',verified_rider_id=?,updated_at=? WHERE mapping_key=?`,
        );
        for (const r of pendingResolved) {
          const sourcePending = db
            .prepare(
              "SELECT rider_name, excel_rider_id FROM weekly_payment_pending WHERE id = ?",
            )
            .get(r.pendingId);
          if (sourcePending)
            updateProvisional.run(
              r.riderId,
              now,
              normalizeRiderName(sourcePending.rider_name) +
                "|" +
                normalizeRiderKey(sourcePending.excel_rider_id),
            );
        }
      }
      if (recordImport)
        insertImport.run(
          importId,
          fileName.slice(0, 200),
          fileHash,
          now,
          clean(actor),
          unique.size,
          inserted,
          updated,
          unchanged,
          amountTotalPaise / 100,
          JSON.stringify([...weeks.values()]),
        );
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
    if (onSaved && (inserted || updated)) {
      try {
        onSaved({ importId, fileName, inserted, updated });
      } catch (err) {
        console.error("Weekly payments were saved, but the follow-up step failed:", err && err.message);
      }
    }
    const pendingTotal = pendingRows().length;
    if (recordImport)
      audit(actor, "weekly_payments_import", {
        fileName,
        records: unique.size,
        inserted,
        updated,
        unchanged,
        pendingAdded: review.length,
        pendingVerified,
        pendingTotal,
        corrections: corrections.length,
      });
    else if (pendingVerified || inserted || updated)
      audit(actor, "weekly_payments_rechecked", {
        pendingVerified,
        inserted,
        updated,
      });
    return {
      importId,
      fileName,
      total: unique.size,
      inserted,
      updated,
      unchanged,
      amountTotal: amountTotalPaise / 100,
      weeks: [...weeks.values()],
      importedFromFile: newVerified,
      importedFromPending: pendingVerified,
      provisionalSaved,
      pendingAdded: review.length,
      pendingTotal,
      registeredCount,
      review,
      corrections,
      conflicts,
      alreadyImported:
        !!previous && inserted === 0 && updated === 0 && review.length === 0,
      sameFileBefore: previous
        ? { fileName: previous.file_name, importedAt: previous.imported_at }
        : null,
    };
  }

  function importRecords(body, actor = "") {
    const records = body?.records;
    if (!Array.isArray(records) || !records.length)
      throw new WeeklyPaymentError(400, "There are no payment rows to save.");
    if (records.length > MAX_IMPORT_RECORDS)
      throw new WeeklyPaymentError(
        400,
        `Too many rows in one import (maximum ${MAX_IMPORT_RECORDS.toLocaleString("en-IN")}).`,
      );
    const fileName = clean(body.fileName) || "payment file",
      fileHash = clean(body.fileHash).slice(0, 128);
    return applyRecords(records, { fileName, fileHash, actor });
  }

  // Lists the rows waiting for Admin review, with the registrations to choose from.
  function listPending() {
    const regs = liveRegistrations()
      .slice()
      .sort((a, b) => String(a.rider_name).localeCompare(String(b.rider_name)));
    const sheetOrder = (a, b) =>
      (a.weekStart ? 0 : 1) - (b.weekStart ? 0 : 1) ||
      String(a.weekStart || "").localeCompare(String(b.weekStart || "")) ||
      String(a.sheet || "").localeCompare(String(b.sheet || "")) ||
      (a.rowNumber ?? 0) - (b.rowNumber ?? 0) ||
      a.id - b.id;
    const pending = pendingRows()
      .map((p) => {
        const d = JSON.parse(p.payload);
        return {
          id: p.id,
          excelRiderId: p.excel_rider_id,
          rider: p.rider_name,
          week: p.week_label,
          weekStart: p.week_start,
          weekEnd: p.week_end,
          days: d.days ?? null,
          totalOrders: d.totalOrders ?? null,
          lm: d.lm ?? null,
          primary: d.primary ?? null,
          club: d.club ?? null,
          sdd: d.sdd ?? null,
          amount: d.amount ?? null,
          reason: p.reason,
          fileName: p.file_name,
          updatedAt: p.updated_at,
          weekStartSort: p.week_start,
          sheet: d.sheet || "",
          rowNumber: d.rowNumber ?? null,
          id_: p.id,
        };
      })
      .sort((a, b) =>
        sheetOrder(
          {
            weekStart: a.weekStartSort,
            sheet: a.sheet,
            rowNumber: a.rowNumber,
            id: a.id_,
          },
          {
            weekStart: b.weekStartSort,
            sheet: b.sheet,
            rowNumber: b.rowNumber,
            id: b.id_,
          },
        ),
      )
      .map(({ weekStartSort, id_, ...row }) => ({ ...row, id: id_ }));
    const provisionalRiders = db
      .prepare(
        `SELECT mapping_key,excel_rider_id,rider_name,status,reason,first_seen_at,updated_at
      FROM weekly_payment_provisional_riders WHERE status='PENDING_VERIFICATION' ORDER BY rider_name COLLATE NOCASE`,
      )
      .all()
      .map((r) => ({
        mappingKey: r.mapping_key,
        excelRiderId: r.excel_rider_id,
        rider: r.rider_name,
        status: r.status,
        reason: r.reason,
        createdAt: r.first_seen_at,
        updatedAt: r.updated_at,
      }));
    return {
      pending,
      provisionalRiders,
      provisionalRiderCount: provisionalRiders.length,
      registrations: regs.map((g) => ({
        riderId: g.rider_id,
        rider: g.rider_name,
      })),
      registeredCount: regs.length,
    };
  }

  // Admin chooses the registered rider for one pending row. The choice is recorded, then the pending rows are imported.
  function mapPending(id, riderId, actor = "") {
    const row = db
      .prepare("SELECT * FROM weekly_payment_pending WHERE id = ?")
      .get(Number(id));
    if (!row || row.status !== "PENDING")
      throw new WeeklyPaymentError(
        404,
        "This pending record was not found or has already been imported.",
      );
    const reg = liveRegistrations().find(
      (g) => normalizeRiderKey(g.rider_id) === normalizeRiderKey(riderId),
    );
    if (!reg)
      throw new WeeklyPaymentError(
        400,
        "Choose a rider that is in Rider Registration and has APPROVED status. Pending applications cannot receive payment records.",
      );
    // One mapping resolves every weekly row for this same Excel rider, not just the selected week.
    const rows = pendingRows().filter(
      (p) =>
        normalizeRiderName(p.rider_name) ===
          normalizeRiderName(row.rider_name) &&
        normalizeRiderKey(p.excel_rider_id) ===
          normalizeRiderKey(row.excel_rider_id),
    );
    const stamp = new Date().toISOString();
    const mappingKey =
      normalizeRiderName(row.rider_name) +
      "|" +
      normalizeRiderKey(row.excel_rider_id);
    db.prepare(
      `INSERT INTO weekly_payment_rider_mappings(mapping_key,excel_rider_id,excel_rider_name,registered_rider_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(mapping_key) DO UPDATE SET registered_rider_id=excluded.registered_rider_id,updated_at=excluded.updated_at`,
    ).run(
      mappingKey,
      row.excel_rider_id,
      row.rider_name,
      reg.rider_id,
      stamp,
      stamp,
    );
    db.prepare(
      "UPDATE weekly_payment_pending SET mapped_rider_id = ?, updated_at = ? WHERE id = ?",
    ).run(reg.rider_id, stamp, row.id);
    audit(actor, "weekly_payment_pending_mapped", {
      pendingId: row.id,
      rider: row.rider_name,
      riderId: reg.rider_id,
      weeklyRows: rows.length,
    });
    const result = applyRecords([], {
      fileName: row.file_name || "Pending mapping",
      fileHash: "",
      actor,
    });
    return {
      ...result,
      mapped: {
        pendingId: row.id,
        rider: row.rider_name,
        riderId: reg.rider_id,
        riderName: reg.rider_name,
        weeklyRows: rows.length,
      },
    };
  }

  // Weekly (7 days) or 15-day cycle, from the saved period dates. Must match cycleOf in dashboard/payment-excel.js.
  const cycleOf = (start, end) =>
    start &&
    end &&
    ISO.test(start) &&
    ISO.test(end) &&
    Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1 > 7
      ? "15-day"
      : "weekly";

  const shape = (r) => ({
    id: r.id,
    importId: r.import_id,
    weekKey: r.week_key,
    week: r.week_label,
    weekStart: r.week_start,
    weekEnd: r.week_end,
    cycle: cycleOf(r.week_start, r.week_end),
    verificationStatus: String(r.rider_key || "").startsWith("provisional:")
      ? "PENDING_VERIFICATION"
      : "VERIFIED",
    rider: r.rider_name,
    riderId: r.rider_id,
    days: r.days,
    totalOrders: r.total_orders,
    lm: r.lm,
    primary: r.primary_orders,
    club: r.club,
    sdd: r.sdd,
    lmRate: r.rate_lm,
    primeRate: r.rate_prime,
    clubRate: r.rate_club,
    sddRate: r.rate_sdd,
    lmAmount: r.lm_amount,
    primeAmount: r.prime_amount,
    clubAmount: r.club_amount,
    sddAmount: r.sdd_amount,
    amount: r.amount,
    amountRaw: r.amount_raw,
    sourceFile: r.source_file,
    sheet: r.sheet,
    rowNumber: r.row_number,
    importedAt: r.updated_at,
    importId: r.import_id,
    paymentStatus: PAYMENT_STATUSES.includes(r.payment_status)
      ? r.payment_status
      : "PENDING",
  });

  // q matches the rider name, the Rider ID or the week (as written in the sheet, or as 2026-10-26).
  function list({ q = "" } = {}) {
    const term = clean(q).toLowerCase();
    let rows;
    if (term) {
      const like = "%" + likeEscape(term) + "%";
      rows = db
        .prepare(
          `SELECT * FROM weekly_payments WHERE lower(rider_name) LIKE ? ESCAPE '\\' OR lower(rider_id) LIKE ? ESCAPE '\\'
        OR lower(week_label) LIKE ? ESCAPE '\\' OR week_start LIKE ? ESCAPE '\\' OR week_end LIKE ? ESCAPE '\\'
        ORDER BY (week_start = '') ASC, week_start ASC, sheet COLLATE NOCASE ASC, COALESCE(row_number, 0) ASC, id ASC LIMIT 50000`,
        )
        .all(like, like, like, like, like);
    } else {
      rows = db
        .prepare(
          "SELECT * FROM weekly_payments ORDER BY (week_start = '') ASC, week_start ASC, sheet COLLATE NOCASE ASC, COALESCE(row_number, 0) ASC, id ASC LIMIT 50000",
        )
        .all();
    }
    const last = db
      .prepare(
        "SELECT * FROM weekly_payment_imports ORDER BY imported_at DESC LIMIT 1",
      )
      .get();
    return {
      records: rows.map(shape),
      lastImport: last
        ? {
            importId: last.id,
            fileName: last.file_name,
            importedAt: last.imported_at,
            total: last.total,
            inserted: last.inserted,
            updated: last.updated,
            unchanged: last.unchanged,
            amountTotal: last.amount_total,
            weeks: JSON.parse(last.weeks || "[]"),
          }
        : null,
    };
  }

  // Admin sets the payment status of one saved rider-week. Only payment_status changes: amounts, Rider ID, week and
  // the import history are left exactly as saved, and no row is deleted.
  function setPaymentStatus(id, status, actor = "") {
    const next = String(status ?? "")
      .trim()
      .toUpperCase();
    if (!PAYMENT_STATUSES.includes(next))
      throw new WeeklyPaymentError(
        400,
        "Choose Pending, Processing, Paid or Failed.",
      );
    const row = db
      .prepare(
        "SELECT id, rider_name, rider_id, week_label, payment_status FROM weekly_payments WHERE id = ?",
      )
      .get(Number(id));
    if (!row)
      throw new WeeklyPaymentError(
        404,
        "This payment record was not found. Refresh the page and try again.",
      );
    const previous = PAYMENT_STATUSES.includes(row.payment_status)
      ? row.payment_status
      : "PENDING";
    if (previous === next)
      return {
        id: row.id,
        paymentStatus: next,
        previousStatus: previous,
        changed: false,
      };
    db.prepare(
      "UPDATE weekly_payments SET payment_status = ? WHERE id = ?",
    ).run(next, row.id);
    audit(actor, "weekly_payment_status_changed", {
      id: row.id,
      rider: row.rider_name,
      riderId: row.rider_id,
      week: row.week_label,
      from: previous,
      to: next,
    });
    return {
      id: row.id,
      paymentStatus: next,
      previousStatus: previous,
      changed: true,
    };
  }

  // Run after an Admin approves a rider: pending Excel rows with that Rider ID are imported now, not at the next upload.
  function recheckPending(actor = "") {
    if (!pendingRows().length)
      return { pendingVerified: 0, inserted: 0, updated: 0 };
    const result = applyRecords([], {
      fileName: "Re-check after rider approval",
      fileHash: "",
      actor,
      recordImport: false,
    });
    return {
      pendingVerified: result.importedFromPending,
      inserted: result.inserted,
      updated: result.updated,
    };
  }

  return {
    importRecords,
    list,
    listPending,
    mapPending,
    recheckPending,
    setPaymentStatus,
  };
}

// The rows one franchise may see: weekly records whose Rider ID is an APPROVED Franchise registration owned by this
// account. Matching uses the Rider ID only; the displayed name is the registered name. Provisional (unverified) rows
// are never included. Enforced here on the server, not in the browser.
export function listForFranchise(db, accountId) {
  if (!accountId) return [];
  return db
    .prepare(
      `SELECT wp.rider_id AS riderId,rr.rider_name AS riderName,
      wp.week_label AS week,wp.week_key AS weekKey,wp.week_start AS weekStart,wp.week_end AS weekEnd,
      CASE WHEN wp.week_start<>'' AND wp.week_end<>'' AND julianday(wp.week_end)-julianday(wp.week_start)>=8 THEN '15-day' ELSE 'weekly' END AS cycle,
      wp.days AS days,wp.total_orders AS totalOrders,wp.lm AS lm,wp.primary_orders AS primaryOrders,
      wp.club AS club,wp.sdd AS sdd,wp.lm_amount AS lmAmount,wp.prime_amount AS primeAmount,
      wp.club_amount AS clubAmount,wp.sdd_amount AS sddAmount,COALESCE(wp.amount,0) AS amount
    FROM weekly_payments wp
    JOIN rider_registrations rr ON lower(trim(rr.rider_id))=lower(trim(wp.rider_id))
    WHERE rr.owner_account_id=? AND rr.registration_source='Franchise' AND rr.application_status='APPROVED'
      AND wp.rider_id<>'' AND wp.rider_key NOT LIKE 'provisional:%'
    ORDER BY wp.week_start DESC,wp.week_end DESC,wp.sheet COLLATE NOCASE,COALESCE(wp.row_number,0),rr.rider_name COLLATE NOCASE
    LIMIT 50000`,
    )
    .all(accountId);
}

// The rows one vendor may see: weekly records whose Rider ID is an APPROVED rider that this vendor registered
// (registration_source = Vendor and owner_account_id = this vendor's account). Matching uses the Rider ID only.
// Pending, rejected, provisional and other vendors' riders are never included.
export function listForVendor(db, accountId) {
  if (!accountId) return [];
  return db
    .prepare(
      `SELECT wp.rider_id AS riderId,rr.rider_name AS riderName,
      wp.week_label AS week,wp.week_key AS weekKey,wp.week_start AS weekStart,wp.week_end AS weekEnd,
      CASE WHEN wp.week_start<>'' AND wp.week_end<>'' AND julianday(wp.week_end)-julianday(wp.week_start)>=8 THEN '15-day' ELSE 'weekly' END AS cycle,
      wp.days AS days,wp.total_orders AS totalOrders,wp.lm AS lm,wp.primary_orders AS primaryOrders,
      wp.club AS club,wp.sdd AS sdd,wp.lm_amount AS lmAmount,wp.prime_amount AS primeAmount,
      wp.club_amount AS clubAmount,wp.sdd_amount AS sddAmount,COALESCE(wp.amount,0) AS amount
    FROM weekly_payments wp
    JOIN rider_registrations rr ON lower(trim(rr.rider_id))=lower(trim(wp.rider_id))
    WHERE rr.owner_account_id=? AND rr.registration_source='Vendor' AND rr.application_status='APPROVED'
      AND wp.rider_id<>'' AND wp.rider_key NOT LIKE 'provisional:%'
    ORDER BY wp.week_start DESC,wp.week_end DESC,wp.sheet COLLATE NOCASE,COALESCE(wp.row_number,0),rr.rider_name COLLATE NOCASE
    LIMIT 50000`,
    )
    .all(accountId);
}

// The partners whose riders received rows in one import (or Admin mapping / re-check): one entry per vendor or
// franchise account, with the number of rows and riders. Same visibility rules as listForVendor / listForFranchise:
// only APPROVED registrations owned by an active account of the matching role, never provisional rows.
export function partnerGroupsForImport(db, importId) {
  if (!importId) return [];
  return db
    .prepare(
      `SELECT a.id AS accountId, a.role AS role, COUNT(*) AS records,
        COUNT(DISTINCT lower(trim(wp.rider_id))) AS riders,
        MIN(NULLIF(wp.week_start,'')) AS fromDay,
        MAX(COALESCE(NULLIF(wp.week_end,''),NULLIF(wp.week_start,''))) AS toDay,
        SUM(COALESCE(wp.total_orders, COALESCE(wp.lm,0)+COALESCE(wp.primary_orders,0)+COALESCE(wp.club,0))) AS orders
      FROM weekly_payments wp
      JOIN rider_registrations rr ON lower(trim(rr.rider_id))=lower(trim(wp.rider_id))
      JOIN accounts a ON a.id=rr.owner_account_id
      WHERE wp.import_id=? AND wp.rider_id<>'' AND wp.rider_key NOT LIKE 'provisional:%'
        AND rr.application_status='APPROVED' AND rr.registration_source IN ('Vendor','Franchise')
        AND a.role=lower(rr.registration_source) AND a.status='active'
      GROUP BY a.id
      ORDER BY a.id`,
    )
    .all(importId);
}
