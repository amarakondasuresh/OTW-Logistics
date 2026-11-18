// Versioned Excel payment imports and rider-to-partner matching (Admin Portal payments).
//
// Every successful upload is stored as a new numbered version with all its rows, so earlier files stay
// available. The latest successful version is the active data source. A failed upload changes nothing.
// The same file (same hash) is never imported twice. Inside one file, a rider and date appear once (the last
// row wins, and the number of duplicates is reported).
//
// Matching uses the Rider Registration records (rider_registrations) and the partner accounts that own them:
//   matched     Rider ID matches one registration, the name matches, and the owner is an active vendor or franchise.
//               Shared with that owner only.
//   review      Rider ID matches a registration but the name is different. Not shared; the admin must check it.
//   unmatched   No registration has this Rider ID. A name-only match is NOT assigned (it is listed as unmatched).
//   no_partner  The rider exists but was registered by the Admin, or the owner is not an active partner, or the
//               registration was rejected. Not shared with any partner.
//
// The browser parses the Excel file (dashboard/payment-excel.js); this module checks and stores what it is sent,
// so it can be tested with Node's built-in SQLite.
import crypto from "node:crypto";
import { normalizeRiderKey } from "./rider-registrations.js";

export const MAX_PAYMENT_ROWS = 20000;
export const MATCH = Object.freeze({
  MATCHED: "matched",
  REVIEW: "review",
  UNMATCHED: "unmatched",
  NO_PARTNER: "no_partner",
});
const PARTNER_ROLES = ["vendor", "franchise"];

export class PaymentImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clean = (v) =>
  (v === null || v === undefined ? "" : String(v)).replace(/\s+/g, " ").trim();
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : null;
};
// Names are compared ignoring case, punctuation, brackets and spacing.
export const normalizeName = (v) =>
  clean(v)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim();

export function createPaymentImportService({
  db,
  audit = () => {},
  now = () => new Date().toISOString(),
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_import_versions(
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_hash TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL,
      imported_by TEXT NOT NULL DEFAULT '',
      row_count INTEGER NOT NULL,
      matched INTEGER NOT NULL, review INTEGER NOT NULL, unmatched INTEGER NOT NULL, no_partner INTEGER NOT NULL,
      skipped INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS payment_import_versions_hash ON payment_import_versions(file_hash);
    CREATE TABLE IF NOT EXISTS payment_import_rows(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id TEXT NOT NULL,
      row_no INTEGER NOT NULL,
      rider_id TEXT NOT NULL DEFAULT '',
      rider_key TEXT NOT NULL DEFAULT '',
      rider_name TEXT NOT NULL,
      date TEXT NOT NULL,
      lm REAL NOT NULL DEFAULT 0, primary_orders REAL NOT NULL DEFAULT 0, club REAL NOT NULL DEFAULT 0,
      sdd REAL NOT NULL DEFAULT 0, sdd_amount REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      match_status TEXT NOT NULL, match_note TEXT NOT NULL DEFAULT '',
      registration_id TEXT NOT NULL DEFAULT '',
      owner_account_id TEXT NOT NULL DEFAULT '', owner_login_id TEXT NOT NULL DEFAULT '', owner_role TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS payment_import_rows_version ON payment_import_rows(version_id, match_status);
    CREATE INDEX IF NOT EXISTS payment_import_rows_owner ON payment_import_rows(owner_account_id, version_id);`);

  // Registrations and owners are read once per import, so a whole file is matched against one consistent snapshot.
  function loadMatchIndex() {
    const regs = db
      .prepare(
        `SELECT r.id, r.rider_id, r.rider_key, r.rider_name, r.registration_source, r.application_status,
        r.owner_account_id, r.owner_login_id, a.role AS owner_role, a.status AS owner_status, a.login_id AS owner_login
      FROM rider_registrations r LEFT JOIN accounts a ON a.id = r.owner_account_id`,
      )
      .all();
    const byKey = new Map(),
      byName = new Map();
    const add = (map, key, reg) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(reg);
    };
    for (const r of regs) {
      add(byKey, r.rider_key, r);
      add(byName, normalizeName(r.rider_name), r);
    }
    return { byKey, byName };
  }

  // One row from the sheet -> its match. Pure given the index.
  function matchRow(row, index) {
    const key = normalizeRiderKey(row.riderId);
    const cands = key ? index.byKey.get(key) || [] : [];
    if (cands.length > 1)
      return {
        status: MATCH.REVIEW,
        note: "This Rider ID is registered more than once. Check the registrations.",
      };
    if (cands.length === 0) {
      const sameName = index.byName.get(normalizeName(row.riderName)) || [];
      return {
        status: MATCH.UNMATCHED,
        note: sameName.length
          ? "The name matches a registered rider, but the Rider ID does not. Not assigned automatically."
          : "No registered rider has this Rider ID.",
      };
    }
    const reg = cands[0];
    if (normalizeName(reg.rider_name) !== normalizeName(row.riderName)) {
      return {
        status: MATCH.REVIEW,
        registrationId: reg.id,
        note: `Rider ID matches "${reg.rider_name}" but the sheet says "${row.riderName}". Check before sharing.`,
      };
    }
    if (reg.application_status === "REJECTED")
      return {
        status: MATCH.NO_PARTNER,
        registrationId: reg.id,
        note: "The rider registration was rejected.",
      };
    if (reg.registration_source === "Admin" || !reg.owner_account_id) {
      return {
        status: MATCH.NO_PARTNER,
        registrationId: reg.id,
        note: "Registered by On The Way Logistics, not by a partner.",
      };
    }
    if (
      !PARTNER_ROLES.includes(reg.owner_role) ||
      reg.owner_status !== "active"
    ) {
      return {
        status: MATCH.NO_PARTNER,
        registrationId: reg.id,
        note: "The partner who registered this rider is not an active approved partner.",
      };
    }
    return {
      status: MATCH.MATCHED,
      registrationId: reg.id,
      ownerAccountId: reg.owner_account_id,
      ownerLoginId: reg.owner_login_id || reg.owner_login || "",
      ownerRole: reg.owner_role,
    };
  }

  // Checks the uploaded records. Bad rows are skipped and counted; the rest are kept.
  function prepare(records) {
    const kept = new Map();
    let skipped = 0,
      duplicates = 0;
    records.forEach((r, i) => {
      const riderName = clean(r?.name ?? r?.riderName);
      const date = clean(r?.date);
      const lm = num(r?.lm),
        primary = num(r?.primary),
        club = num(r?.club),
        amount = num(r?.amount),
        sdd = num(r?.sdd),
        sddAmount = num(r?.sddAmount);
      if (
        !riderName ||
        !ISO.test(date) ||
        [lm, primary, club, amount, sdd, sddAmount].includes(null)
      ) {
        skipped++;
        return;
      }
      const riderId = clean(r?.riderId || r?.adminRiderId).slice(0, 100);
      const riderKey = normalizeRiderKey(riderId);
      const k = (riderKey || "name:" + normalizeName(riderName)) + "|" + date;
      if (kept.has(k)) duplicates++;
      kept.set(k, {
        rowNo: i + 1,
        riderId,
        riderKey,
        riderName: riderName.slice(0, 200),
        date,
        lm,
        primary,
        club,
        sdd,
        sddAmount,
        amount,
      });
    });
    return { rows: [...kept.values()], skipped, duplicates };
  }

  function activeVersion() {
    return (
      db
        .prepare(
          "SELECT * FROM payment_import_versions ORDER BY seq DESC LIMIT 1",
        )
        .get() || null
    );
  }

  // Imports one file. project(versionId, matchedRows) runs inside the same transaction, so the partner data is
  // changed only together with the new version (and rolled back with it if anything fails).
  function importRows(body, actor = "", project = () => {}) {
    const records = body?.records;
    if (!Array.isArray(records) || !records.length)
      throw new PaymentImportError(
        400,
        "There are no payment rows in this file.",
      );
    if (records.length > MAX_PAYMENT_ROWS)
      throw new PaymentImportError(
        400,
        `Too many rows in one file (maximum ${MAX_PAYMENT_ROWS.toLocaleString("en-IN")}).`,
      );
    const fileName = clean(body.fileName).slice(0, 200) || "payment file";
    const fileHash = clean(body.fileHash).slice(0, 128);

    if (fileHash) {
      const same = db
        .prepare(
          "SELECT * FROM payment_import_versions WHERE file_hash = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(fileHash);
      if (same)
        return {
          alreadyImported: true,
          version: versionSummary(same),
          activeVersionId: activeVersion()?.id || null,
        };
    }
    const { rows, skipped, duplicates } = prepare(records);
    if (!rows.length)
      throw new PaymentImportError(
        400,
        "None of the rows could be read. Each row needs a rider name, a date (for example 2026-10-26) and numeric order counts.",
      );

    const index = loadMatchIndex();
    const matched = rows.map((r) => ({ ...r, ...matchRow(r, index) }));
    const counts = { matched: 0, review: 0, unmatched: 0, no_partner: 0 };
    matched.forEach((m) => {
      counts[m.status]++;
    });

    const id = crypto.randomUUID(),
      at = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const seq =
        db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS m FROM payment_import_versions",
          )
          .get().m + 1;
      db.prepare(
        `INSERT INTO payment_import_versions(id,seq,file_name,file_hash,imported_at,imported_by,row_count,matched,review,unmatched,no_partner,skipped,duplicates)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        seq,
        fileName,
        fileHash,
        at,
        clean(actor).slice(0, 200),
        matched.length,
        counts.matched,
        counts.review,
        counts.unmatched,
        counts.no_partner,
        skipped,
        duplicates,
      );
      const insert =
        db.prepare(`INSERT INTO payment_import_rows(version_id,row_no,rider_id,rider_key,rider_name,date,lm,primary_orders,club,sdd,sdd_amount,amount,
        match_status,match_note,registration_id,owner_account_id,owner_login_id,owner_role) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const m of matched) {
        insert.run(
          id,
          m.rowNo,
          m.riderId,
          m.riderKey,
          m.riderName,
          m.date,
          m.lm,
          m.primary,
          m.club,
          m.sdd,
          m.sddAmount,
          m.amount,
          m.status,
          m.note || "",
          m.registrationId || "",
          m.ownerAccountId || "",
          m.ownerLoginId || "",
          m.ownerRole || "",
        );
      }
      project(
        id,
        matched.filter((m) => m.status === MATCH.MATCHED),
      );
      db.exec("COMMIT");
      audit(actor, "payment_import_version", {
        fileName,
        versionId: id,
        seq,
        rows: matched.length,
        ...counts,
      });
      const version = db
        .prepare("SELECT * FROM payment_import_versions WHERE id = ?")
        .get(id);
      return {
        alreadyImported: false,
        version: versionSummary(version),
        activeVersionId: id,
        skipped,
        duplicates,
      };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      throw err;
    }
  }

  function versionSummary(v) {
    return {
      id: v.id,
      seq: v.seq,
      fileName: v.file_name,
      importedAt: v.imported_at,
      importedBy: v.imported_by,
      rows: v.row_count,
      matched: v.matched,
      review: v.review,
      unmatched: v.unmatched,
      noPartner: v.no_partner,
      skipped: v.skipped,
      duplicates: v.duplicates,
    };
  }

  function listVersions() {
    const active = activeVersion();
    return {
      activeVersionId: active?.id || null,
      versions: db
        .prepare("SELECT * FROM payment_import_versions ORDER BY seq DESC")
        .all()
        .map((v) => ({ ...versionSummary(v), active: v.id === active?.id })),
    };
  }

  // Rows of one version (default: the active version). Admin sees all rows; a partner only sees its own matched rows.
  function rowsOf({ versionId, status, ownerAccountId } = {}) {
    const version = versionId
      ? db
          .prepare("SELECT * FROM payment_import_versions WHERE id = ?")
          .get(versionId)
      : activeVersion();
    if (!version) return { version: null, rows: [] };
    const params = [version.id];
    let where = "version_id = ?";
    if (status) {
      where += " AND match_status = ?";
      params.push(status);
    }
    if (ownerAccountId !== undefined) {
      where += " AND match_status = ? AND owner_account_id = ?";
      params.push(MATCH.MATCHED, ownerAccountId);
    }
    const rows = db
      .prepare(
        `SELECT * FROM payment_import_rows WHERE ${where} ORDER BY date DESC, rider_name COLLATE NOCASE, row_no`,
      )
      .all(...params);
    return { version: versionSummary(version), rows: rows.map(shapeRow) };
  }

  function shapeRow(r) {
    return {
      id: r.id,
      rowNo: r.row_no,
      riderId: r.rider_id,
      riderName: r.rider_name,
      date: r.date,
      lm: r.lm,
      primary: r.primary_orders,
      club: r.club,
      sdd: r.sdd,
      sddAmount: r.sdd_amount,
      amount: r.amount,
      status: r.match_status,
      note: r.match_note,
      registrationId: r.registration_id,
      ownerAccountId: r.owner_account_id,
      ownerLoginId: r.owner_login_id,
      ownerRole: r.owner_role,
    };
  }

  return {
    importRows,
    activeVersion,
    listVersions,
    rowsOf,
    matchRow,
    prepare,
    versionSummary,
    loadMatchIndex,
  };
}
