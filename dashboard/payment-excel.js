// Payment Management: reads an Excel payment sheet and turns it into Weekly Payment records.
//
// Plain functions, no browser needed, so backend/test/weekly-payments.test.mjs can test them directly.
// The headers are NOT assumed: the header row is found by scanning the first rows of every sheet and every column
// is matched by its name (capitals, spaces, dashes, brackets and "₹" are ignored).
//
// Three sheet layouts are understood:
//   weekly  one row per rider per week:   WEEK | RIDER | DAYS | LM | PRIMARY | CLUB | WEEKLY AMOUNT
//   daily   one row per rider per day:    Rider Name | Order Date | LM | Primary | Club | Payout Amount ...
//   wide    one row per rider, one column per date ("5/3" = LM/Primary), plus an amount column
// The weekly amount is always read from the amount column of the sheet. It is never calculated and never defaulted:
// a blank amount stays blank (shown as "—") and is reported to the admin.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaymentExcel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- header names ----------
  // Order matters: an earlier name wins over a later one when a sheet has several candidates.
  const NAMES = {
    rider: [
      "rider name",
      "rider",
      "rider full name",
      "full name",
      "name",
      "delivery partner",
      "delivery partner name",
      "dp name",
      "partner name",
      "employee name",
      "driver name",
      "agent name",
      "delivery executive",
      "de name",
    ],
    riderId: [
      "rider id",
      "rider code",
      "rider no",
      "rider number",
      "partner id",
      "dp id",
      "employee id",
      "emp id",
      "driver id",
      "agent id",
      "id",
    ],
    days: [
      "days",
      "working days",
      "no of days",
      "number of days",
      "total days",
      "days worked",
      "work days",
      "active days",
      "present days",
      "days present",
      "day count",
      "days count",
      "working day",
    ],
    lm: [
      "lm",
      "total lm",
      "total lm orders",
      "lm orders",
      "total lm order",
      "lm order",
      "lm count",
      "lm total",
      "last mile",
    ],
    primary: [
      "primary",
      "total primary",
      "total primary orders",
      "primary orders",
      "total primary order",
      "primary order",
      "primary count",
      "prime",
      "prime orders",
      "prime order",
      "total prime",
      "total prime orders",
      "total prime order",
      "prime count",
    ],
    sdd: [
      "sdd",
      "sdd orders",
      "sdd order",
      "total sdd",
      "total sdd orders",
      "total sdd order",
      "sdd count",
    ],
    club: [
      "club",
      "total club",
      "total club orders",
      "club orders",
      "total club order",
      "club order",
      "club count",
    ],
    totalOrders: [
      "total orders",
      "total order",
      "total work orders",
      "total week work orders",
      "week work orders",
      "total week orders",
    ],
    // Rider-wise payment rates (per applicable order). A plain rate applies to Prime orders.
    rate: [
      "rate",
      "rate applicable",
      "rate per order",
      "applicable rate",
      "per order rate",
      "payment rate",
      "rider rate",
      "rate per applicable order",
    ],
    primeRate: [
      "prime rate",
      "primary rate",
      "prime rate per order",
      "primary rate per order",
      "rate prime",
      "rate primary",
    ],
    clubRate: ["club rate", "club rate per order", "rate club"],
    sddRate: ["sdd rate", "sdd rate per order", "rate sdd"],
    // Explicit category amounts written in the sheet (they win over a rate x orders calculation).
    lmAmount: ["lm amount", "lm payment", "lm pay"],
    primeAmount: [
      "prime amount",
      "primary amount",
      "prime payment",
      "primary payment",
      "prime pay",
      "primary pay",
    ],
    clubAmount: ["club amount", "club payment", "club pay"],
    sddAmount: ["sdd amount", "sdd payment", "sdd pay"],
    date: [
      "date",
      "order date",
      "delivery date",
      "work date",
      "settlement date",
      "day",
    ],
    // An amount that is already a total for the whole week.
    weeklyAmount: [
      "weekly amount",
      "weekly payment",
      "weekly payout",
      "weekly pay",
      "week amount",
      "week payment",
      "week payout",
      "weekly total",
      "total amount",
      "payment completed",
      "weekly settlement",
      "weekly earnings",
    ],
    // A generic amount column: a weekly total in weekly sheets, a per-day figure in daily sheets (then summed per week).
    amount: [
      "payout amount",
      "payout",
      "amount",
      "payment amount",
      "payment",
      "net payout",
      "net payable",
      "net amount",
      "payable amount",
      "amount payable",
      "total payout",
      "total payment",
      "total amount",
      "final amount",
      "final payout",
      "amount paid",
      "earnings",
      "total earnings",
      "settlement amount",
      "gross payout",
      "net pay",
      "total pay",
      "pay",
    ],
    week: [
      "week",
      "week range",
      "week period",
      "week no",
      "week number",
      "week dates",
      "week date",
      "date range",
      "period",
      "payment week",
      "settlement week",
      "week starting",
      "week start",
      "week ending",
      "week of",
    ],
  };
  const LABEL = {
    week: "WEEK",
    rider: "RIDER",
    riderId: "RIDER ID",
    days: "DAYS",
    lm: "LM",
    primary: "PRIMARY",
    club: "CLUB",
    sdd: "SDD",
    totalOrders: "TOTAL ORDERS",
    rate: "RATE",
    primeRate: "PRIME RATE",
    clubRate: "CLUB RATE",
    sddRate: "SDD RATE",
    lmAmount: "LM AMOUNT",
    primeAmount: "PRIME AMOUNT",
    clubAmount: "CLUB AMOUNT",
    sddAmount: "SDD AMOUNT",
    date: "DATE",
    weeklyAmount: "WEEKLY AMOUNT",
    amount: "WEEKLY AMOUNT",
  };

  // Large-order (LM) rate: ₹10 per LM order, the same for every rider. LM Amount = LM Orders x LM_RATE.
  const LM_RATE = 10;
  const AMOUNT_WORD = /amount|payout|payable|earning|payment|settlement/;
  const NOT_AMOUNT =
    /rate|per order|deduct|incentive|bonus|penalt|advance|tds|fine|count|orders?\b|date|status|mode|ref|utr|id\b/;

  // ---------- small helpers ----------
  const pad = (n) => String(n).padStart(2, "0");
  const isBlank = (v) =>
    v === null || v === undefined || String(v).trim() === "";
  const text = (v) =>
    (v === null || v === undefined ? "" : String(v))
      .replace(/\s+/g, " ")
      .trim();
  const norm = (v) =>
    text(v)
      .toLowerCase()
      .replace(/[₹]/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(inr|rs|rupees)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // Number from a cell: 1234, "1,23,456.50", "₹ 1,200", "Rs. 900", "(500)" -> -500. Blank or text -> null.
  function toNumber(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (isBlank(v)) return null;
    let s = String(v).trim();
    const neg = /^\(.*\)$/.test(s);
    s = s
      .replace(/[₹,\s]/g, "")
      .replace(/^(rs\.?|inr)/i, "")
      .replace(/[()]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(s) && !/^-?\.\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? (neg ? -Math.abs(n) : n) : null;
  }
  // Money keeps its exact value; sums are done in paise so 0.1 + 0.2 does not become 0.30000000000000004.
  const paise = (n) => Math.round(n * 100);

  // ---------- dates (plain ISO strings; no time zones involved) ----------
  const MONTHS = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const MON_RE =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const monthNo = (s) => MONTHS[String(s).slice(0, 3).toLowerCase()] || 0;
  function ymd(y, m, d) {
    if (y < 100) y += 2000;
    const t = new Date(Date.UTC(y, m - 1, d));
    if (
      t.getUTCFullYear() !== y ||
      t.getUTCMonth() !== m - 1 ||
      t.getUTCDate() !== d
    )
      return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  const isoParts = (iso) => iso.split("-").map(Number);
  function addDays(iso, n) {
    const [y, m, d] = isoParts(iso),
      t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  function mondayOf(iso) {
    const [y, m, d] = isoParts(iso),
      dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return addDays(iso, -((dow + 6) % 7));
  }
  const fmtDMY = (iso) => {
    if (!iso) return "";
    const [y, m, d] = isoParts(iso);
    return `${pad(d)}/${pad(m)}/${y}`;
  };
  const SERIAL_MIN = 36526,
    SERIAL_MAX = 73050; // 2000-01-01 .. 2099-12-31
  const isSerial = (n) =>
    typeof n === "number" && n >= SERIAL_MIN && n <= SERIAL_MAX;
  function serialToISO(n) {
    const t = new Date(Math.round((Math.floor(n) - 25569) * 86400000));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }

  // Every date written inside a text such as "26/10/2026 - 01/11/2026" or "26 Oct - 01 Nov 2026" (day first, as in India).
  function findDates(str) {
    const s = String(str).replace(/(\d{1,2})\/-(\d{1,2})/g, "$1-$2");
    const re = new RegExp(
      [
        "(\\d{4})-(\\d{1,2})-(\\d{1,2})", // 2026-10-26
        "(\\d{1,2})([\\/.\\-])(\\d{1,2})(?:\\5(\\d{4}|\\d{2})(?!\\d))?", // 26/10/2026, 26-10-26, 26/10
        `(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-\\/.]*(${MON_RE})\\.?(?:[\\s\\-\\/.,']*(\\d{4})(?!\\d)|-(\\d{2})(?!\\d))?`, // 26 Oct 2026, 26-Oct-26, 26 Oct
        `(${MON_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, // Oct 26, 2026
      ].join("|"),
      "gi",
    );
    const found = [];
    let m;
    while ((m = re.exec(s))) {
      if (m[1]) found.push({ y: +m[1], m: +m[2], d: +m[3] });
      else if (m[4]) found.push({ y: m[7] ? +m[7] : null, m: +m[6], d: +m[4] });
      else if (m[8])
        found.push({
          y: m[10] ? +m[10] : m[11] ? +m[11] : null,
          m: monthNo(m[9]),
          d: +m[8],
        });
      else if (m[12])
        found.push({ y: m[14] ? +m[14] : null, m: monthNo(m[12]), d: +m[13] });
    }
    // a date without a year takes the year of the nearest date that has one
    const withYear = found.filter((f) => f.y !== null);
    if (withYear.length) {
      found.forEach((f, i) => {
        if (f.y !== null) return;
        const after = found.slice(i + 1).find((x) => x.y !== null),
          before = found
            .slice(0, i)
            .reverse()
            .find((x) => x.y !== null);
        f.y = (after || before).y;
        f.fromNeighbour = !!after;
      });
      // "26 Oct - 01 Nov 2026" is fine, but "29 Dec - 04 Jan 2026" starts in the year before
      for (let i = 0; i < found.length - 1; i++) {
        if (
          found[i].fromNeighbour &&
          found[i + 1] &&
          found[i].m > found[i + 1].m
        )
          found[i].y -= 1;
      }
    }
    return found
      .map((f) => (f.y === null || !f.m ? null : ymd(f.y, f.m, f.d)))
      .filter(Boolean);
  }
  // A cell that is a date: an Excel serial number, a JS Date, or a text that is exactly one date.
  function cellDate(v) {
    if (v instanceof Date && !isNaN(v))
      return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    if (typeof v === "number") return isSerial(v) ? serialToISO(v) : null;
    const s = text(v);
    if (!s || s.length > 24) return null;
    const dates = findDates(s);
    if (dates.length !== 1) return null;
    // the whole text must be the date (not "Week 43" or a rate)
    return s.replace(/[\d\s\-\/.,']|st\b|nd\b|rd\b|th\b|[a-z]{3,9}/gi, "") ===
      "" && /\d/.test(s)
      ? dates[0]
      : null;
  }

  // ---------- what a header cell means ----------
  function fieldOf(header) {
    const h = norm(header);
    if (!h) return null;
    let best = null;
    for (const f of Object.keys(NAMES)) {
      const i = NAMES[f].indexOf(h);
      if (i >= 0 && (!best || i < best.rank)) best = { field: f, rank: i };
    }
    if (best) return { field: best.field, rank: best.rank, exact: true };
    // "Week (26 Oct - 01 Nov)", "Week No." ... any header that is about the week and not about money
    if (
      /\bweek\b/.test(h) &&
      !AMOUNT_WORD.test(h) &&
      !/total|order|rate|day/.test(h)
    )
      return { field: "week", rank: 50, exact: false };
    // an amount column under an unusual name ("Net Payable to Rider")
    if (AMOUNT_WORD.test(h) && !NOT_AMOUNT.test(h))
      return {
        field: /week/.test(h) ? "weeklyAmount" : "amount",
        rank: 90,
        exact: false,
      };
    return null;
  }
  // Which column holds which field. Each column is used once; the best-ranked column wins each field.
  function mapColumns(cells) {
    const cols = {};
    cells.forEach((c, i) => {
      const f = fieldOf(c);
      if (!f) return;
      if (!cols[f.field] || f.rank < cols[f.field].rank)
        cols[f.field] = {
          index: i,
          header: text(c),
          rank: f.rank,
          exact: f.exact,
        };
    });
    return cols;
  }
  function dateColumns(cells) {
    const out = [];
    cells.forEach((c, i) => {
      const d = cellDate(c);
      if (d) out.push({ index: i, date: d, header: text(c) || fmtDMY(d) });
    });
    return out;
  }

  // Finds the header row: the row of the first 40 that names the most known fields (it must name a rider).
  function findHeader(grid) {
    let best = null;
    for (let r = 0; r < Math.min(grid.length, 40); r++) {
      const cells = grid[r] || [];
      const cols = mapColumns(cells);
      if (!cols.rider) continue;
      const dates = dateColumns(cells);
      const fields = Object.keys(cols).filter((k) => k !== "riderId").length;
      const score = fields + (dates.length >= 2 ? 3 : 0);
      if (fields >= 3 || dates.length >= 2) {
        if (!best || score > best.score) best = { row: r, cols, dates, score };
      }
    }
    return best;
  }

  // The week named above the table ("Payment Week: 26/10/2026 - 01/11/2026") or in the sheet name ("Week 43 ...").
  function weekFromTitle(grid, headerRow, sheetName) {
    const pick = (s) => {
      const dates = findDates(s);
      return dates.length
        ? {
            label: text(s),
            start: dates[0],
            end: dates.length > 1 ? dates[dates.length - 1] : null,
          }
        : null;
    };
    for (let r = headerRow - 1; r >= 0; r--) {
      for (const c of grid[r] || []) {
        const s = typeof c === "string" ? c : "";
        if (/week|period|settlement|payment/i.test(s) && findDates(s).length) {
          const w = pick(s.replace(/^[^:]*:\s*/, "") || s);
          if (w) return w;
        }
      }
    }
    if (/week|\d/.test(sheetName) && findDates(sheetName).length)
      return pick(sheetName);
    for (let r = headerRow - 1; r >= 0; r--) {
      for (const c of grid[r] || []) {
        const s = typeof c === "string" ? c : "";
        const dates = findDates(s);
        if (dates.length >= 2)
          return {
            label: text(s.replace(/^[^:]*:\s*/, "")),
            start: dates[0],
            end: dates[dates.length - 1],
          };
      }
    }
    if (/week/i.test(sheetName))
      return { label: text(sheetName), start: null, end: null };
    return null;
  }

  // The WEEK cell of a weekly row -> {label (as in Excel), start, end, key}
  // Payment periods. A period longer than 7 days is a 15-day cycle (for example 1-15 Sep). Weekly periods keep the
  // 'd:' key they always had; 15-day periods get an 'f:' key, so a rider's weekly and 15-day records never replace each other.
  function spanDays(start, end) {
    return start && end
      ? Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1
      : 0;
  }
  function cycleOf(start, end) {
    return spanDays(start, end) > 7 ? "15-day" : "weekly";
  }
  function keyOf(start, end) {
    return cycleOf(start, end) === "15-day" ? "f:" + start : "d:" + start;
  }

  function weekInfo(v) {
    let label,
      start = null,
      end = null;
    if (typeof v === "number") {
      if (isSerial(v)) {
        start = serialToISO(v);
        label = fmtDMY(start);
      } else
        label =
          Number.isInteger(v) && v >= 1 && v <= 60 ? `Week ${v}` : String(v);
    } else if (v instanceof Date && !isNaN(v)) {
      start = cellDate(v);
      label = fmtDMY(start);
    } else {
      label = text(v);
      const dates = findDates(label);
      if (dates.length) {
        start = dates[0];
        end = dates.length > 1 ? dates[dates.length - 1] : null;
      }
    }
    return {
      label,
      start,
      end,
      key: start ? keyOf(start, end) : "w:" + norm(label),
    };
  }
  const weekFromRange = (start) => ({
    label: `${fmtDMY(start)} - ${fmtDMY(addDays(start, 6))}`,
    start,
    end: addDays(start, 6),
    key: "d:" + start,
  });

  const riderKeyOf = (id, name) =>
    text(id) ? "id:" + text(id).toLowerCase() : "n:" + norm(name);
  const isTotalRow = (name) =>
    /^(grand\s*)?total\b|^sub\s*total\b|^s\.?\s*no\.?$|^sl\.?\s*no\.?$/i.test(
      name,
    );

  // One imported record in the shape the server stores.
  const money = (n) =>
    n === null || n === undefined || !Number.isFinite(n)
      ? null
      : Math.round(n * 100) / 100;
  // Category amounts: an explicit amount from the sheet wins; otherwise LM x ₹10 and orders x the rider's rate.
  // A category with no order count or no rate stays null (shown as —), never an invented 0.
  function makeRecord(sheet, rowNumber, week, name, id, vals, raw) {
    const lmRate = vals.lm === null || vals.lm === undefined ? null : LM_RATE;
    const primeRate = vals.primeRate ?? null,
      clubRate = vals.clubRate ?? null,
      sddRate = vals.sddRate ?? null;
    const pick = (explicit, count, rate) =>
      explicit ??
      (count === null || count === undefined || rate === null
        ? null
        : money(count * rate));
    return {
      weekKey: week.key,
      weekLabel: week.label,
      weekStart: week.start || "",
      weekEnd: week.end || "",
      riderName: name,
      riderId: id,
      riderKey: riderKeyOf(id, name),
      days: vals.days,
      totalOrders: "totalOrders" in vals ? vals.totalOrders : (vals.lm ?? null),
      lm: vals.lm,
      primary: vals.primary,
      club: vals.club,
      sdd: vals.sdd ?? null,
      lmRate,
      primeRate,
      clubRate,
      sddRate,
      lmAmount: pick(vals.lmAmount ?? null, vals.lm, lmRate),
      primeAmount: pick(vals.primeAmount ?? null, vals.primary, primeRate),
      clubAmount: pick(vals.clubAmount ?? null, vals.club, clubRate),
      sddAmount: pick(vals.sddAmount ?? null, vals.sdd ?? null, sddRate),
      amount: vals.amount ?? 0,
      amountRaw: vals.amountRaw,
      sheet,
      rowNumber,
      original: raw,
    };
  }

  // ---------- rider-wise rates ----------
  // A rate cell: 18, "18", "₹18", "19/-", "18.5". Text with both Prime and Club rates ("₹18.5 Pri / ₹12.25 Club") is split.
  function rateCell(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = text(v).replace(/\/-\s*$/, "");
    return toNumber(s);
  }
  // The rates a row carries: its own columns first, then the generic Rate column (which applies to Prime orders).
  function ratesOf(row, cols) {
    const out = { primeRate: null, clubRate: null, sddRate: null };
    const one = (f) => (cols[f] ? rateCell(row[cols[f].index]) : null);
    out.primeRate = one("primeRate");
    out.clubRate = one("clubRate");
    out.sddRate = one("sddRate");
    if (cols.rate) {
      const txt = text(row[cols.rate.index]);
      const nums = (txt.match(/\d+(?:\.\d+)?/g) || []).map(Number);
      const hasPri = /pri|prime/i.test(txt),
        hasClub = /club/i.test(txt),
        hasSdd = /sdd/i.test(txt);
      if (nums.length) {
        if (hasClub && hasPri) {
          if (out.primeRate === null) out.primeRate = nums[0];
          if (out.clubRate === null && nums.length > 1) out.clubRate = nums[1];
        } else if (hasClub) {
          if (out.clubRate === null) out.clubRate = nums[0];
        } else if (hasSdd) {
          if (out.sddRate === null) out.sddRate = nums[0];
        } else if (out.primeRate === null) out.primeRate = nums[0];
      }
    }
    return out;
  }
  const originalRow = (cells, headers) => {
    const o = {};
    headers.forEach((h, i) => {
      if (text(h) && !isBlank(cells[i]))
        o[text(h)] =
          typeof cells[i] === "number" || typeof cells[i] === "string"
            ? cells[i]
            : String(cells[i]);
    });
    return o;
  };
  const colOf = (cols, f) => (cols[f] ? cols[f].index : -1);
  const cellOf = (row, i) => (i >= 0 ? row[i] : undefined);
  function amountColumn(cols) {
    return cols.weeklyAmount || cols.amount || null;
  }

  // ---------- layout 1: weekly rows ----------
  function parseWeekly(grid, hdr, sheetName, rowOffset) {
    const { cols } = hdr,
      headers = grid[hdr.row],
      out = { records: [], skipped: [], warnings: [] };
    const title = cols.week ? null : weekFromTitle(grid, hdr.row, sheetName);
    if (!cols.week && !title) {
      out.error = "no WEEK column and no week written above the table";
      return out;
    }
    // A weekly sheet must carry every column of the payment table. A missing one is reported, never filled in.
    const required = [
      ["rider", "Rider Name"],
      ["days", "Days"],
      ["lm", "LM Orders"],
      ["primary", "Prime Orders"],
      ["club", "Club Orders"],
      ["sdd", "SDD Orders"],
    ];
    const missing = required
      .filter(([f]) => !cols[f])
      .map(([, label]) => label);
    if (!amountColumn(cols)) missing.push("Total Amount");
    if (missing.length) {
      out.error = `the ${missing.length > 1 ? "columns" : "column"} ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing or not recognised. A weekly sheet needs these headers: Rider ID, Rider Name, Days, LM Orders, Prime Orders, Club Orders, SDD Orders and Total Amount`;
      return out;
    }
    const amt = amountColumn(cols);
    if (!amt)
      out.warnings.push(
        "No amount column was found in this sheet, so WEEKLY AMOUNT stays blank (—). Column names seen: " +
          headers.map(text).filter(Boolean).join(", ") +
          ".",
      );
    else if (!amt.exact)
      out.warnings.push(
        `The amount column "${amt.header}" was chosen by its name. Check that it is the weekly payment.`,
      );
    let week = title
      ? {
          label: title.label,
          start: title.start,
          end: title.end,
          key: title.start
            ? keyOf(title.start, title.end)
            : "w:" + norm(title.label),
        }
      : null;
    const wi = colOf(cols, "week"),
      ri = colOf(cols, "rider"),
      ii = colOf(cols, "riderId");
    let hasRates = false;
    for (let r = hdr.row + 1; r < grid.length; r++) {
      const row = grid[r] || [],
        rowNumber = r + 1 + rowOffset;
      if (row.every(isBlank)) continue;
      if (wi >= 0 && !isBlank(row[wi])) week = weekInfo(row[wi]); // blank week cells (merged cells) repeat the week above
      const name = text(row[ri]);
      if (norm(name) === norm(headers[ri])) continue; // a repeated header row
      if (!name) {
        out.skipped.push({
          sheet: sheetName,
          row: rowNumber,
          reason: "no rider name",
        });
        continue;
      }
      if (isTotalRow(name)) continue;
      const nums = ["days", "lm", "primary", "club", "sdd"].map((f) =>
        toNumber(cellOf(row, colOf(cols, f))),
      );
      const amount = amt ? toNumber(row[amt.index]) : null;
      if (nums.every((n) => n === null) && amount === null) {
        out.skipped.push({
          sheet: sheetName,
          row: rowNumber,
          reason: "no values for " + name,
        });
        continue;
      }
      if (!week) {
        out.skipped.push({
          sheet: sheetName,
          row: rowNumber,
          reason: "no week for " + name,
        });
        continue;
      }
      const cellNum = (f) => (cols[f] ? toNumber(row[cols[f].index]) : null);
      const rates = ratesOf(row, cols);
      if (
        rates.primeRate !== null ||
        rates.clubRate !== null ||
        rates.sddRate !== null
      )
        hasRates = true;
      out.records.push(
        makeRecord(
          sheetName,
          rowNumber,
          week,
          name,
          text(row[ii]),
          {
            days: nums[0],
            lm: nums[1],
            primary: nums[2],
            club: nums[3],
            sdd: nums[4],
            amount,
            amountRaw:
              amt && !isBlank(row[amt.index])
                ? String(row[amt.index]).trim()
                : "",
            // No Total Orders column: Total Orders is the LM count, the same rule the daily and
            // date-column layouts use (LM = Prime + Club in these sheets).
            totalOrders: cols.totalOrders
              ? toNumber(row[cols.totalOrders.index])
              : nums[1],
            lmAmount: cellNum("lmAmount"),
            primeAmount: cellNum("primeAmount"),
            clubAmount: cellNum("clubAmount"),
            sddAmount: cellNum("sddAmount"),
            primeRate: rates.primeRate,
            clubRate: rates.clubRate,
            sddRate: rates.sddRate,
          },
          originalRow(row, headers),
        ),
      );
    }
    if (
      !hasRates &&
      !["primeAmount", "clubAmount", "sddAmount"].every((f) => cols[f])
    ) {
      out.warnings.push(
        'No rider payment rate was found in this sheet (for example a "Rate" column). Prime, Club and SDD amounts show — until a rate or an amount column is added. LM Amount uses ₹10 per LM order.',
      );
    }
    return out;
  }

  // ---------- layout 2: one row per rider per day ----------
  function parseDaily(grid, hdr, sheetName, rowOffset) {
    const { cols } = hdr,
      headers = grid[hdr.row],
      out = { records: [], skipped: [], warnings: [] };
    const ri = colOf(cols, "rider"),
      ii = colOf(cols, "riderId"),
      di = colOf(cols, "date");
    const weekly = cols.weeklyAmount || null,
      perDay = !weekly ? cols.amount || null : null;
    const amt = weekly || perDay;
    if (!amt)
      out.warnings.push(
        "No amount column was found in this sheet, so WEEKLY AMOUNT stays blank (—). Column names seen: " +
          headers.map(text).filter(Boolean).join(", ") +
          ".",
      );
    else if (!amt.exact)
      out.warnings.push(
        `The amount column "${amt.header}" was chosen by its name. Check that it is the payment amount.`,
      );
    else if (perDay)
      out.warnings.push(
        `This sheet has one row per day, so WEEKLY AMOUNT is the total of the "${amt.header}" column for each rider's week.`,
      );
    const groups = new Map();
    for (let r = hdr.row + 1; r < grid.length; r++) {
      const row = grid[r] || [],
        rowNumber = r + 1 + rowOffset;
      if (row.every(isBlank)) continue;
      const name = text(row[ri]);
      if (norm(name) === norm(headers[ri])) continue;
      if (!name) {
        out.skipped.push({
          sheet: sheetName,
          row: rowNumber,
          reason: "no rider name",
        });
        continue;
      }
      if (isTotalRow(name)) continue;
      const date = cellDate(row[di]);
      if (!date) {
        out.skipped.push({
          sheet: sheetName,
          row: rowNumber,
          reason: `date "${text(row[di])}" for ${name} is not a date`,
        });
        continue;
      }
      const lm = toNumber(cellOf(row, colOf(cols, "lm"))),
        primary = toNumber(cellOf(row, colOf(cols, "primary"))),
        club = toNumber(cellOf(row, colOf(cols, "club")));
      const amount = amt ? toNumber(row[amt.index]) : null;
      const id = text(row[ii]),
        start = mondayOf(date),
        key = riderKeyOf(id, name) + "|" + start;
      let g = groups.get(key);
      if (!g) {
        g = {
          name,
          id,
          start,
          first: rowNumber,
          dates: new Set(),
          lm: null,
          primary: null,
          club: null,
          paise: null,
          weeklyValues: new Set(),
          raw: [],
          rawAmounts: [],
        };
        groups.set(key, g);
      }
      const add = (cur, n) => (n === null ? cur : (cur || 0) + n);
      g.lm = add(g.lm, lm);
      g.primary = add(g.primary, primary);
      g.club = add(g.club, club);
      if ((lm || 0) + (primary || 0) + (club || 0) > 0 || (amount || 0) !== 0)
        g.dates.add(date);
      if (amount !== null) {
        if (weekly) g.weeklyValues.add(paise(amount));
        else g.paise = (g.paise || 0) + paise(amount);
        g.rawAmounts.push(String(row[amt.index]).trim());
      }
      g.raw.push(originalRow(row, headers));
    }
    groups.forEach((g) => {
      let amount = null,
        raw = "";
      if (weekly && g.weeklyValues.size) {
        const vals = [...g.weeklyValues];
        amount = vals[0] / 100;
        raw = g.rawAmounts[0];
        if (vals.length > 1)
          out.warnings.push(
            `${g.name}: the weekly amount differs between days of the week starting ${fmtDMY(g.start)}; the first one (${amount}) was used.`,
          );
      } else if (g.paise !== null) {
        amount = g.paise / 100;
        raw = g.rawAmounts.length === 1 ? g.rawAmounts[0] : String(amount);
      }
      out.records.push(
        makeRecord(
          sheetName,
          g.first,
          weekFromRange(g.start),
          g.name,
          g.id,
          {
            days: g.dates.size,
            lm: g.lm,
            primary: g.primary,
            club: g.club,
            amount,
            amountRaw: raw,
          },
          g.raw.length === 1 ? g.raw[0] : { days: g.raw },
        ),
      );
    });
    return out;
  }

  // ---------- layout 3: one column per date ----------
  // A cell "5/3" is LM 5 / Primary 3 (Club = the difference); "5/3/2" is LM / Primary / Club; a single number is LM.
  function orderCell(v) {
    if (isBlank(v)) return null;
    if (typeof v === "number") return { lm: v, primary: 0, club: 0 };
    const parts = String(v)
      .replace(/,/g, "")
      .split("/")
      .map((s) => toNumber(s));
    if (parts.some((p) => p === null)) return null;
    if (parts.length === 1) return { lm: parts[0], primary: 0, club: 0 };
    if (parts.length === 2)
      return {
        lm: parts[0],
        primary: parts[1],
        club: Math.max(0, parts[0] - parts[1]),
      };
    return { lm: parts[0], primary: parts[1], club: parts[2] };
  }
  function amountsFromFormula(formula, cols, values) {
    const result = {
      lmAmount: null,
      primeAmount: null,
      clubAmount: null,
      sddAmount: null,
    };
    const rates = {};
    const colNumber = (letters) =>
      letters
        .toUpperCase()
        .split("")
        .reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const re = /\$?([A-Z]{1,3})\$?\d+\s*\*\s*(\d+(?:\.\d+)?)/gi;
    let m;
    while ((m = re.exec(String(formula || "")))) {
      const index = colNumber(m[1]),
        rate = Number(m[2]);
      const field = Object.keys(cols).find((k) => cols[k].index === index);
      if (field && ["lm", "primary", "club", "sdd"].includes(field))
        rates[field] = rate;
    }
    if (rates.lm !== undefined && values.lm !== null)
      result.lmAmount = values.lm * rates.lm;
    if (rates.primary !== undefined && values.primary !== null)
      result.primeAmount = values.primary * rates.primary;
    if (rates.club !== undefined && values.club !== null)
      result.clubAmount = values.club * rates.club;
    if (rates.sdd !== undefined && values.sdd !== null)
      result.sddAmount = values.sdd * rates.sdd;
    return result;
  }

  function parseWide(grid, hdr, sheetName, rowOffset, formulaGrid = []) {
    const out = { records: [], skipped: [], warnings: [] };
    // A workbook may put many weekly tables one after another on the same worksheet.
    // Detect every repeated header row so each block gets its own week title and date mapping.
    const blocks = [{ row: hdr.row, cols: hdr.cols, dates: hdr.dates }];
    for (let r = hdr.row + 1; r < grid.length; r++) {
      const candidate = findHeader([grid[r] || []]);
      if (candidate && candidate.dates.length >= 2 && candidate.cols.rider) {
        blocks.push({ row: r, cols: candidate.cols, dates: candidate.dates });
      }
    }

    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b],
        endRow = b + 1 < blocks.length ? blocks[b + 1].row : grid.length;
      const headers = grid[block.row] || [],
        cols = block.cols;
      let dates = block.dates.slice();
      const titleWeek = weekFromTitle(grid, block.row, sheetName);
      // Some Excel files contain date-typed headers that Excel has already misinterpreted
      // (e.g. 01/09/2026 saved as 09-Jan-2026). If the merged week title provides an exact
      // date range and the header has one date column per day, rebuild the daily sequence.
      let titlePeriod = null;
      if (titleWeek?.start && titleWeek?.end) {
        const expected = spanDays(titleWeek.start, titleWeek.end);
        if (expected > 0 && expected <= 31 && dates.length === expected) {
          const needsRepair = dates.some(
            (d, i) => d.date !== addDays(titleWeek.start, i),
          );
          dates = dates.map((d, i) => ({
            ...d,
            date: addDays(titleWeek.start, i),
            header: fmtDMY(addDays(titleWeek.start, i)),
          }));
          titlePeriod = {
            label: `${fmtDMY(titleWeek.start)} - ${fmtDMY(titleWeek.end)}`,
            start: titleWeek.start,
            end: titleWeek.end,
            key: keyOf(titleWeek.start, titleWeek.end),
          };
          if (needsRepair)
            out.warnings.push(
              `Date headers in ${sheetName} (header row ${block.row + 1 + rowOffset}) did not match the week title; ${fmtDMY(titleWeek.start)} – ${fmtDMY(titleWeek.end)} was used.`,
            );
        }
      }
      if (!dates.length) {
        out.skipped.push({
          sheet: sheetName,
          row: block.row + 1 + rowOffset,
          reason: "no date columns in this weekly block",
        });
        continue;
      }
      const weeks = [...new Set(dates.map((d) => mondayOf(d.date)))];
      const amt = amountColumn(cols);
      const ri = colOf(cols, "rider"),
        ii = colOf(cols, "riderId"),
        si = colOf(cols, "sdd");
      for (let r = block.row + 1; r < endRow; r++) {
        const row = grid[r] || [],
          rowNumber = r + 1 + rowOffset;
        if (row.every(isBlank)) continue;
        const name = text(row[ri]);
        if (norm(name) === norm(headers[ri])) continue;
        if (!name || isTotalRow(name)) continue;
        const amount = amt ? toNumber(row[amt.index]) : null;
        for (const ws of weeks) {
          const t = { lm: null, primary: null, club: null, days: 0 };
          dates
            .filter((d) => mondayOf(d.date) === ws)
            .forEach((d) => {
              const c = orderCell(row[d.index]);
              if (!c) return;
              t.lm = (t.lm || 0) + c.lm;
              t.primary = (t.primary || 0) + c.primary;
              t.club = (t.club || 0) + c.club;
              // A valid daily cell is an entered day even when its value is 0/0.
              t.days++;
            });
          if (t.lm === null && amount === null) {
            out.skipped.push({
              sheet: sheetName,
              row: rowNumber,
              reason: "no values for " + name,
            });
            continue;
          }
          if (weeks.length > 1 && amount !== null)
            out.warnings.push(
              `${name}: a single weekly amount cell is present beside multiple weeks; the amount is assigned only to the first week.`,
            );
          if (weeks.length > 1 && ws !== weeks[0]) continue;
          const sdd = si >= 0 ? toNumber(row[si]) : 0;
          const values = {
            lm: t.lm ?? 0,
            primary: t.primary ?? 0,
            club: t.club ?? 0,
            sdd: sdd ?? 0,
          };
          const splitAmounts = {}; // Never derive payment amounts from order counts or rates; only explicit Excel amount cells are authoritative.
          out.records.push(
            makeRecord(
              sheetName,
              rowNumber,
              titlePeriod && weeks.length === 1
                ? titlePeriod
                : weekFromRange(ws),
              name,
              text(row[ii]),
              {
                days: t.days,
                totalOrders: values.lm,
                ...values,
                ...splitAmounts,
                amount,
                amountRaw:
                  amt && !isBlank(row[amt.index])
                    ? String(row[amt.index]).trim()
                    : "",
              },
              originalRow(row, headers),
            ),
          );
        }
      }
    }
    return out;
  }

  // ---------- whole workbook ----------
  // sheets: [{name, grid, rowOffset}], grid = array of rows (arrays of cell values), numbers for dates are Excel serials.
  function parseSheets(sheets) {
    const tried = [],
      good = [];
    for (const sh of sheets) {
      const grid = sh.grid || [],
        rowOffset = sh.rowOffset || 0;
      const hdr = findHeader(grid);
      if (!hdr) {
        tried.push({
          sheet: sh.name,
          problem:
            "no header row naming a rider and payment columns was found in the first 40 rows",
        });
        continue;
      }
      const hasDateCols = hdr.dates.length >= 2,
        layout =
          hdr.cols.date && !hasDateCols
            ? "daily"
            : hasDateCols && !hdr.cols.date
              ? "wide"
              : hdr.cols.date
                ? "daily"
                : "weekly";
      const res = (
        layout === "daily"
          ? parseDaily
          : layout === "wide"
            ? parseWide
            : parseWeekly
      )(grid, hdr, sh.name, rowOffset, sh.formulas || []);
      const columns = {};
      Object.keys(hdr.cols).forEach((f) => {
        columns[LABEL[f] || f] = hdr.cols[f].header;
      });
      if (layout === "wide")
        columns["DATES"] =
          hdr.dates.length +
          " date columns (" +
          fmtDMY(hdr.dates[0].date) +
          " – " +
          fmtDMY(hdr.dates[hdr.dates.length - 1].date) +
          ")";
      if (res.error) {
        tried.push({ sheet: sh.name, problem: res.error });
        continue;
      }
      if (!res.records.length) {
        tried.push({
          sheet: sh.name,
          problem:
            "the header row was found (row " +
            (hdr.row + 1 + rowOffset) +
            ") but no rider rows below it",
        });
        continue;
      }
      const amt = amountColumn(hdr.cols);
      good.push({
        sheet: sh.name,
        layout,
        headerRow: hdr.row + 1 + rowOffset,
        columns,
        amountColumn: amt ? amt.header : "",
        ...res,
      });
    }
    if (!good.length) {
      return {
        ok: false,
        error:
          "No payment table could be read from this Excel file. " +
          (tried.length
            ? tried.map((t) => `Sheet "${t.sheet}": ${t.problem}.`).join(" ")
            : "The file has no sheets.") +
          " The sheet needs a header row with at least RIDER (or Rider Name) and columns such as WEEK, DAYS, LM, PRIMARY, CLUB and an amount column.",
        tried,
      };
    }
    // If a workbook has both a weekly summary sheet and daily sheets, the weekly one is used (the same week is not imported twice).
    const rank = { weekly: 0, daily: 1, wide: 2 },
      bestLayout = good.reduce((a, g) => Math.min(a, rank[g.layout]), 9);
    const used = good.filter((g) => rank[g.layout] === bestLayout),
      ignored = good
        .filter((g) => rank[g.layout] !== bestLayout)
        .map((g) => g.sheet);
    const seen = new Map(),
      records = [],
      skipped = [],
      warnings = [];
    used.forEach((u) => {
      skipped.push(...u.skipped);
      warnings.push(
        ...u.warnings.map((w) => (used.length > 1 ? `[${u.sheet}] ` : "") + w),
      );
      u.records.forEach((rec) => {
        const k = rec.riderKey + "|" + rec.weekKey,
          prev = seen.get(k);
        if (!prev) {
          seen.set(k, rec);
          records.push(rec);
          return;
        }
        const same = [
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
        ].every((f) => prev[f] === rec[f]);
        if (same)
          skipped.push({
            sheet: rec.sheet,
            row: rec.rowNumber,
            reason: `${rec.riderName} appears twice for ${rec.weekLabel} (same values as row ${prev.rowNumber}); counted once`,
            duplicate: true,
          });
        else
          skipped.push({
            sheet: rec.sheet,
            row: rec.rowNumber,
            reason: `${rec.riderName} appears twice for ${rec.weekLabel} with different values (first at row ${prev.rowNumber}); the first was kept`,
            conflict: true,
          });
      });
    });
    if (ignored.length)
      warnings.push(
        `Other sheets were not imported to avoid counting the same week twice: ${ignored.join(", ")}.`,
      );
    const missingAmount = records.filter((r) => r.amount === null).length;
    if (missingAmount)
      warnings.push(
        `${missingAmount} rider row${missingAmount === 1 ? " has" : "s have"} no amount in the Excel sheet; WEEKLY AMOUNT is shown as — for them.`,
      );
    const weeks = [
      ...new Map(records.map((r) => [r.weekKey, r.weekLabel])).values(),
    ];
    const totalPaise = records.reduce(
      (s, r) => s + (r.amount === null ? 0 : paise(r.amount)),
      0,
    );
    return {
      ok: true,
      records,
      skipped,
      warnings,
      weeks,
      totalAmount: totalPaise / 100,
      layout: used[0].layout,
      sheets: used.map((u) => ({
        sheet: u.sheet,
        layout: u.layout,
        headerRow: u.headerRow,
        columns: u.columns,
        amountColumn: u.amountColumn,
        rows: u.records.length,
      })),
    };
  }

  // Browser: workbook read by SheetJS (XLSX.read(..., {type:'array'}) without cellDates, so dates arrive as exact serial numbers).
  function sheetsFromWorkbook(XLSX, wb) {
    return wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name],
        ref = ws && ws["!ref"];
      const range = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 } };
      const rowOffset = range.s.r,
        colOffset = range.s.c;
      const grid = ws
        ? XLSX.utils.sheet_to_json(ws, {
            header: 1,
            raw: true,
            defval: "",
            blankrows: true,
          })
        : [];
      const formulas = grid.map((row, r) =>
        row.map((_, c) => {
          const cell =
            ws &&
            ws[XLSX.utils.encode_cell({ r: r + rowOffset, c: c + colOffset })];
          return cell && typeof cell.f === "string" ? cell.f : "";
        }),
      );
      return { name, rowOffset, grid, formulas };
    });
  }

  // ₹12,34,567.50 (Indian digit grouping). A blank amount is shown as —.
  function formatINR(n) {
    if (
      n === null ||
      n === undefined ||
      n === "" ||
      !Number.isFinite(Number(n))
    )
      n = 0;
    const v = Number(n),
      decimals = Math.abs(v * 100 - Math.round(v * 100)) > 1e-6 ? 4 : 2;
    return (
      "₹" +
      v.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: decimals,
      })
    );
  }

  return {
    parseSheets,
    sheetsFromWorkbook,
    formatINR,
    findDates,
    cellDate,
    toNumber,
    mondayOf,
    fmtDMY,
    norm,
    fieldOf,
    cycleOf,
    keyOf,
  };
});
