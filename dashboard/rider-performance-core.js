// Rider Performance Dashboard: the calculations behind the Excel-based dashboard.
//
// Reads the rows of an uploaded Excel sheet, finds the header row, groups every rider by Rider ID (or by name when a
// row has no ID), removes duplicate rider-and-date rows, and calculates the totals for every rider, the combined
// totals of all riders, and the weekly and overall reports.
//
// No browser APIs are used here, so backend/test/rider-performance.test.mjs can test it with Node.
// The browser page (rider-performance.html + rider-performance.js) reads the file with the SheetJS library and passes
// the rows in.
//
// Amounts are taken from the Total Amount column of the sheet and are never recalculated.
// A sheet is only accepted when its header row has a rider column and at least one order column.
// Order counts are taken from the sheet too. Total Weekly Orders is the sheet's own total column when it has one,
// otherwise it is the sum of Large + Prime + Club + SDD + FM + RTS for that row.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RiderPerf = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const ORDER_FIELDS = ["large", "prime", "club", "sdd", "fm", "rts"];

  // Header names accepted for each column (compared after lower-casing and removing brackets and punctuation).
  // Earlier names win when a sheet has more than one matching column.
  const FIELDS = {
    riderId: {
      label: "Rider ID",
      aliases: ["rider id", "riderid", "rider code", "rider no", "id"],
    },
    riderName: {
      label: "Rider Name",
      aliases: ["rider name", "rider", "name", "full name"],
    },
    date: {
      label: "Date",
      aliases: ["order date", "date", "week", "week start", "week date", "day"],
    },
    large: {
      label: "Large Orders",
      aliases: [
        "large orders",
        "total large orders",
        "lm orders",
        "total lm orders",
        "large",
        "lm",
      ],
    },
    prime: {
      label: "Prime Orders (PM)",
      aliases: [
        "prime orders",
        "total prime orders",
        "pm orders",
        "total pm orders",
        "primary orders",
        "total primary orders",
        "prime",
        "pm",
        "primary",
      ],
    },
    club: {
      label: "Club Orders",
      aliases: ["club orders", "total club orders", "club"],
    },
    sdd: {
      label: "SDD Orders",
      aliases: ["sdd orders", "total sdd orders", "sdd"],
    },
    fm: { label: "FM Orders", aliases: ["fm orders", "total fm orders", "fm"] },
    rts: {
      label: "RTS Orders",
      aliases: ["rts orders", "total rts orders", "rts"],
    },
    totalOrders: {
      label: "Total Weekly Orders",
      aliases: [
        "total weekly orders",
        "weekly orders",
        "total orders",
        "total order",
      ],
    },
    amount: {
      label: "Total Amount",
      aliases: [
        "total amount",
        "weekly amount",
        "payment completed",
        "weekly payment",
        "payout amount",
        "amount",
      ],
    },
  };

  const norm = (v) =>
    String(v ?? "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const clean = (v) =>
    String(v ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const parseIso = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };
  const addDays = (iso, n) => {
    const t = parseIso(iso);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  // weeks run Monday to Sunday
  const weekStartOf = (iso) =>
    addDays(iso, -((parseIso(iso).getUTCDay() + 6) % 7));
  const fmtDay = (iso) => {
    const t = parseIso(iso);
    return `${pad(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
  };
  const weekLabel = (monday) =>
    `${fmtDay(monday)} – ${fmtDay(addDays(monday, 6))}`;

  // Excel stores dates as day numbers counted from 1899-12-30. Also accepts Date objects, dd/mm/yyyy and yyyy-mm-dd text,
  // and a range such as "19/10/2026 - 25/10/2026" (a weekly sheet).
  function parseDateCell(v) {
    if (v === null || v === undefined || v === "") return null;
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) return null;
      return {
        iso: isoOf(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()),
        range: false,
      };
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v) || v < 20000 || v > 80000) return null;
      return {
        iso: new Date(Math.round((v - 25569) * 86400000))
          .toISOString()
          .slice(0, 10),
        range: false,
      };
    }
    const s = clean(v);
    const hits = [
      ...s.matchAll(
        /(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/g,
      ),
    ];
    if (!hits.length) return null;
    const toIso = (h) =>
      h[1] ? isoOf(+h[1], +h[2], +h[3]) : isoOf(+h[6], +h[5], +h[4]);
    const iso = toIso(hits[0]);
    if (
      Number.isNaN(parseIso(iso).getTime()) ||
      parseIso(iso).toISOString().slice(0, 10) !== iso
    )
      return null;
    return { iso, range: hits.length > 1 };
  }

  // blank -> null, text that is not a number -> NaN, otherwise the number. "₹5,210.25" -> 5210.25
  function toNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    const s = clean(v).replace(/[₹,\s]/g, "");
    if (s === "") return null;
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }

  function detectHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 25); i++) {
      const cells = (rows[i] || []).map(norm);
      const cols = {};
      const used = new Set();
      for (const [field, def] of Object.entries(FIELDS)) {
        for (const alias of def.aliases) {
          const idx = cells.findIndex((c, j) => c === alias && !used.has(j));
          if (idx >= 0) {
            cols[field] = idx;
            used.add(idx);
            break;
          }
        }
      }
      const hasRider =
        cols.riderId !== undefined || cols.riderName !== undefined;
      const hasNumbers = [...ORDER_FIELDS, "totalOrders"].some(
        (f) => cols[f] !== undefined,
      );
      if (hasRider && hasNumbers) return { row: i, cols };
    }
    return null;
  }

  // One sheet -> its rider records, or {ok:false, reason} when it has no rider table.
  function parseSheet(name, rows) {
    const found = detectHeader(rows || []);
    if (!found) {
      return {
        name,
        ok: false,
        reason:
          "No rider table found. The header row needs a Rider ID or Rider Name column and at least one order column (Large/LM, Prime/PM, Club, SDD, FM, RTS or Total Orders).",
      };
    }
    const { row: hdr, cols } = found;
    const headerRow = rows[hdr];
    const weeklyHeader =
      cols.date !== undefined &&
      ["week", "week start", "week date"].includes(norm(headerRow[cols.date]));
    const warnings = [],
      skipped = [],
      invalid = {},
      candidates = [];
    let lastDate = null,
      anyRange = false,
      forwardFilled = 0;

    for (let i = hdr + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (!r.some((c) => clean(c) !== "")) continue;
      const get = (f) => (cols[f] === undefined ? undefined : r[cols[f]]);
      const riderId = clean(get("riderId")),
        riderName = clean(get("riderName"));

      if (!riderId && !riderName) {
        skipped.push({ row: i + 1, reason: "no Rider ID or name" });
        continue;
      }
      if (!riderId && /^(grand\s+)?total\b/i.test(riderName)) {
        skipped.push({ row: i + 1, reason: "total line, not a rider" });
        continue;
      }

      let date = null;
      if (cols.date !== undefined) {
        if (clean(get("date")) === "") {
          // merged week cells: the date is written once and left blank below it
          if (lastDate) {
            date = lastDate;
            forwardFilled++;
          }
        } else {
          date = parseDateCell(get("date"));
          if (!date) {
            skipped.push({
              row: i + 1,
              reason: `date "${clean(get("date"))}" not recognised`,
            });
            continue;
          }
          lastDate = date;
          if (date.range) anyRange = true;
        }
      }

      const nums = {};
      for (const f of [...ORDER_FIELDS, "amount"]) {
        const n = toNumber(get(f));
        if (Number.isNaN(n)) {
          invalid[f] = (invalid[f] || 0) + 1;
          nums[f] = 0;
        } else nums[f] = n ?? 0;
      }
      const explicitTotal = toNumber(get("totalOrders"));
      nums.totalOrders =
        typeof explicitTotal === "number" && !Number.isNaN(explicitTotal)
          ? explicitTotal
          : ORDER_FIELDS.reduce((s, f) => s + nums[f], 0);

      candidates.push({ row: i + 1, riderId, riderName, date, nums });
    }

    // A row without a Rider ID is matched to the Rider ID of the one rider that has the same name in this sheet.
    const idsByName = new Map();
    for (const c of candidates) {
      if (!c.riderId) continue;
      const k = norm(c.riderName);
      if (!idsByName.has(k)) idsByName.set(k, new Set());
      idsByName.get(k).add(c.riderId.toUpperCase());
    }
    let matchedByName = 0;
    for (const c of candidates) {
      if (c.riderId) continue;
      const ids = idsByName.get(norm(c.riderName));
      if (ids && ids.size === 1) {
        c.riderId = [...ids][0];
        matchedByName++;
      }
    }

    // A weekly sheet (a WEEK column or week ranges) gives one row per rider per week. A daily sheet gives one row per day.
    const granularity = weeklyHeader || anyRange ? "week" : "day";
    const records = [],
      seen = new Map();
    for (const c of candidates) {
      const riderKey = c.riderId
        ? "ID:" + c.riderId.toUpperCase()
        : "NAME:" + norm(c.riderName);
      const iso = c.date
        ? granularity === "week"
          ? weekStartOf(c.date.iso)
          : c.date.iso
        : null;
      const dupKey = riderKey + "|" + (iso || "") + "|" + granularity;
      if (seen.has(dupKey)) {
        skipped.push({
          row: c.row,
          reason: `duplicate of row ${seen.get(dupKey)} (same rider and date), counted once`,
          duplicate: true,
        });
        continue;
      }
      seen.set(dupKey, c.row);
      records.push({
        row: c.row,
        riderKey,
        riderId: c.riderId,
        riderName: c.riderName,
        iso,
        granularity,
        weekKey: iso ? weekStartOf(iso) : null,
        large: c.nums.large,
        prime: c.nums.prime,
        club: c.nums.club,
        sdd: c.nums.sdd,
        fm: c.nums.fm ?? 0,
        rts: c.nums.rts ?? 0,
        totalOrders: c.nums.totalOrders,
        amount: c.nums.amount,
      });
    }

    const colLabel = (f) =>
      cols[f] === undefined ? null : clean(headerRow[cols[f]]);
    for (const f of ["large", "prime", "club", "sdd", "fm", "rts"]) {
      if (cols[f] === undefined)
        warnings.push(
          `No ${FIELDS[f].label} column in this sheet. It is counted as 0.`,
        );
    }
    if (cols.amount === undefined)
      warnings.push(
        "No Total Amount column in this sheet. Amounts are counted as 0.",
      );
    if (cols.date === undefined)
      warnings.push(
        "No date column in this sheet. Rows can only be included in All Dates totals.",
      );
    for (const [f, n] of Object.entries(invalid)) {
      warnings.push(
        `${n} ${FIELDS[f].label} cell(s) are not numbers and were counted as 0.`,
      );
    }
    if (forwardFilled)
      warnings.push(
        `${forwardFilled} row(s) had an empty date and used the date above them.`,
      );
    if (matchedByName)
      warnings.push(
        `${matchedByName} row(s) without a Rider ID were matched to a rider with the same name.`,
      );
    const undated = records.filter((r) => !r.iso).length;
    if (undated && cols.date !== undefined)
      warnings.push(
        `${undated} row(s) have no usable date. They are included only in All Dates totals.`,
      );

    return {
      name,
      ok: true,
      headerRow: hdr + 1,
      granularity,
      columns: Object.fromEntries(
        Object.keys(FIELDS).map((f) => [f, colLabel(f)]),
      ),
      warnings,
      skipped,
      records,
    };
  }

  // Sheets of an uploaded workbook: [{name, rows}]. The first sheet with a rider table is used, so the same orders
  // are not counted twice when a workbook also has a summary sheet. Other sheets are listed as ignored.
  function parseWorkbook(sheets) {
    const parsed = (sheets || []).map((s) => parseSheet(s.name, s.rows));
    const used = parsed.find((p) => p.ok);
    if (!used) {
      return {
        ok: false,
        error:
          "No sheet has a rider table. The header row must have Rider ID or Rider Name and at least one order column.",
        sheets: parsed,
      };
    }
    const ignoredSheets = parsed
      .filter((p) => p !== used)
      .map((p) => ({
        name: p.name,
        reason: p.ok
          ? "not used, to avoid counting the same orders twice"
          : p.reason,
      }));
    return {
      ok: true,
      sheetName: used.name,
      granularity: used.granularity,
      columns: used.columns,
      warnings: used.warnings,
      skipped: used.skipped,
      records: used.records,
      ignoredSheets,
    };
  }

  function filterRecords(records, { mode = "all", value = "" } = {}) {
    if (mode === "week") return records.filter((r) => r.weekKey === value);
    if (mode === "date")
      return records.filter((r) => r.granularity === "day" && r.iso === value);
    return records.slice();
  }

  function listPeriods(records) {
    const weeks = [
      ...new Set(records.filter((r) => r.weekKey).map((r) => r.weekKey)),
    ]
      .sort()
      .reverse();
    const dates = [
      ...new Set(
        records
          .filter((r) => r.granularity === "day" && r.iso)
          .map((r) => r.iso),
      ),
    ]
      .sort()
      .reverse();
    return {
      weeks: weeks.map((k) => ({ key: k, label: weekLabel(k) })),
      dates: dates.map((k) => ({ key: k, label: fmtDay(k) })),
    };
  }

  function spanOf(records) {
    let start = null,
      end = null;
    for (const r of records) {
      if (!r.iso) continue;
      const e = r.granularity === "week" ? addDays(r.iso, 6) : r.iso;
      if (!start || r.iso < start) start = r.iso;
      if (!end || e > end) end = e;
    }
    return { start, end };
  }

  function periodLabel(mode, value, records) {
    if (mode === "week") return weekLabel(value);
    if (mode === "date") return fmtDay(value);
    const { start, end } = spanOf(records);
    if (!start) return "No dated rows";
    return start === end ? fmtDay(start) : `${fmtDay(start)} – ${fmtDay(end)}`;
  }

  // One row per rider. Rows are grouped by rider key, so a rider is counted once however many rows the rider has.
  function riderRows(records) {
    const map = new Map();
    for (const r of records) {
      let a = map.get(r.riderKey);
      if (!a) {
        a = {
          riderKey: r.riderKey,
          riderId: "",
          riderName: "",
          large: 0,
          prime: 0,
          club: 0,
          sdd: 0,
          fm: 0,
          rts: 0,
          totalOrders: 0,
          amountPaise: 0,
          amount: 0,
          rows: 0,
          dates: [],
        };
        map.set(r.riderKey, a);
      }
      if (r.riderId && !a.riderId) a.riderId = r.riderId;
      if (r.riderName && !a.riderName) a.riderName = r.riderName;
      for (const f of [...ORDER_FIELDS, "totalOrders"]) a[f] += r[f];
      a.amountPaise += Math.round(r.amount * 100);
      a.rows++;
      if (r.iso) a.dates.push(r.iso);
    }
    const rows = [...map.values()].map((a) => {
      const { amountPaise, ...rest } = a;
      return { ...rest, amount: amountPaise / 100 };
    });
    return rows.sort((x, y) =>
      (x.riderId || x.riderName).localeCompare(
        y.riderId || y.riderName,
        undefined,
        { numeric: true, sensitivity: "base" },
      ),
    );
  }

  // Combined totals of all riders in the records given.
  function summarize(records) {
    const rows = riderRows(records);
    const t = {
      riders: rows.length,
      totalOrders: 0,
      large: 0,
      prime: 0,
      club: 0,
      sdd: 0,
      fm: 0,
      rts: 0,
      amountPaise: 0,
    };
    for (const r of rows) {
      for (const f of [...ORDER_FIELDS, "totalOrders"]) t[f] += r[f];
      t.amountPaise += Math.round(r.amount * 100);
    }
    return {
      riders: t.riders,
      totalOrders: t.totalOrders,
      large: t.large,
      prime: t.prime,
      club: t.club,
      sdd: t.sdd,
      fm: t.fm,
      rts: t.rts,
      amount: t.amountPaise / 100,
    };
  }

  // One line per week (newest first). Riders are counted per week; the overall line counts each rider once.
  function weeklyReport(records) {
    const byWeek = new Map();
    for (const r of records) {
      if (!r.weekKey) continue;
      if (!byWeek.has(r.weekKey)) byWeek.set(r.weekKey, []);
      byWeek.get(r.weekKey).push(r);
    }
    return [...byWeek.keys()]
      .sort()
      .reverse()
      .map((k) => ({
        weekKey: k,
        label: weekLabel(k),
        ...summarize(byWeek.get(k)),
      }));
  }

  function searchRows(rows, query) {
    const q = clean(query).toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.riderId.toLowerCase().includes(q) ||
        r.riderName.toLowerCase().includes(q),
    );
  }

  return {
    FIELDS,
    parseDateCell,
    toNumber,
    weekStartOf,
    weekLabel,
    fmtDay,
    parseSheet,
    parseWorkbook,
    filterRecords,
    listPeriods,
    periodLabel,
    riderRows,
    summarize,
    weeklyReport,
    searchRows,
  };
});
