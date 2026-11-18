// Reports aggregation for the admin Reports dashboard.
//
// Single source of truth: the `weekly_payments` table, the same saved rows the Admin Portal → Payments page shows.
// An Excel import in Payments writes those rows, so Reports reflects the latest saved import with no second upload.
//
// This file holds only pure functions (no database, no HTTP), so it can be tested directly.
//
// Definitions:
//   Report record   = one rider's saved payment week (one row of weekly_payments). Excel weekly sheets carry no daily
//                     detail, so no daily records are invented.
//   Unique key      = Rider ID + week start date. If two saved rows ever share that key, the fuller one is kept once.
//   Order ID        = a GENERATED reference (ORD-<Rider ID>-<week start yyyymmdd>). The Excel sheet has no order
//                     numbers, so this is not a transaction ID. It is stable for the same rider and week.
//   Period bucket   = a record belongs to the 15-day period or month that contains its week START date, so every
//                     record is counted in exactly one bucket.
//   Total Orders    = the Excel Total Orders value, exactly as saved; never raised or recalculated. When the sheet has
//                     no Total Orders column, it is LM + Prime + Club.
//   Total Amount    = the Excel Amount, exactly as saved. It is never recalculated.
//   Percentage      = category / total orders x 100, one decimal; 0 when there are no orders.

export const MAX_RANGE_DAYS = 1830; // about five years; keeps one report bounded
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;
const MONTH_SHORT = [
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

export class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (dt) => dt.toISOString().slice(0, 10);

// Returns the normalized YYYY-MM-DD string, or '' when the value is not a real calendar date.
export function validDay(value) {
  const s = typeof value === "string" ? value.trim() : "";
  const m = DAY_RE.exec(s);
  if (!m) return "";
  const y = +m[1],
    mo = +m[2],
    d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  )
    return "";
  return s;
}

export function addDays(day, n) {
  return isoOf(new Date(new Date(day + "T00:00:00Z").getTime() + n * DAY_MS));
}

// month is 1-based
export function lastDayOfMonth(year, month) {
  return isoOf(new Date(Date.UTC(year, month, 0)));
}

// Generated, stable reference for a rider's week. Not an original transaction ID.
export function orderIdOf(riderId, weekStart) {
  return `ORD-${String(riderId).trim().toUpperCase()}-${weekStart.replace(/-/g, "")}`;
}

// Payment status of a saved weekly row. Set by the Admin on the Reports page; never changed by an Excel import.
export const PAYMENT_STATUSES = ["PENDING", "PROCESSING", "PAID", "FAILED"];
export function normalizeStatus(v) {
  const s = String(v ?? "")
    .trim()
    .toUpperCase();
  return PAYMENT_STATUSES.includes(s) ? s : "PENDING";
}

// Money in whole paise so sums never drift; returned as rupees with two decimals.
const toPaise = (v) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? 0
    : Math.round(Number(v) * 100);
const fromPaise = (p) => Math.round(p) / 100;

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const money = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clean = (v, max) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const pct = (part, whole) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

// Saved weekly_payments rows -> report records. Invalid rows are skipped and counted; duplicates are counted once.
// `hubByRider` maps a normalized Rider ID to its hub (from the partner rider lists); it is optional.
export function recordsFromWeeklyRows(rows, hubByRider = new Map()) {
  const byKey = new Map();
  let skipped = 0,
    duplicates = 0,
    adjusted = 0;
  for (const r of rows || []) {
    const riderId = clean(r?.rider_id ?? r?.riderId, 100).toUpperCase();
    const start = validDay(r?.week_start ?? r?.weekStart);
    if (!riderId || !start) {
      skipped++;
      continue;
    }
    const end = validDay(r?.week_end ?? r?.weekEnd) || start;
    const lm = count(r.lm),
      prime = count(r.primary_orders ?? r.primary),
      club = count(r.club),
      sdd = count(r.sdd);
    const storedTotal = r.total_orders ?? r.totalOrders;
    const total =
      storedTotal === null || storedTotal === undefined || storedTotal === ""
        ? lm + prime + club
        : count(storedTotal);
    const classified = lm + prime + club;
    if (total < classified) adjusted++; // informational: the category counts exceed the saved total (kept as saved)
    const rec = {
      riderId,
      riderName: clean(r.rider_name ?? r.riderName, 120),
      hub: hubByRider.get(riderId) || "",
      start,
      end,
      weekLabel: clean(r.week_label ?? r.weekLabel, 120),
      days: count(r.days),
      total,
      lm,
      prime,
      club,
      sdd,
      amounts: {
        lm: money(r.lm_amount ?? r.lmAmount),
        prime: money(r.prime_amount ?? r.primeAmount),
        club: money(r.club_amount ?? r.clubAmount),
        sdd: money(r.sdd_amount ?? r.sddAmount),
        total: money(r.amount) ?? 0,
      },
      orderId: orderIdOf(riderId, start),
      rowId: r.id ?? null,
      status: normalizeStatus(r.payment_status ?? r.paymentStatus),
    };
    const key = riderId + "|" + start;
    const prev = byKey.get(key);
    if (prev) {
      duplicates++;
      if (rec.total > prev.total) byKey.set(key, rec); // keep the fuller record once
      continue;
    }
    byKey.set(key, rec);
  }
  return {
    records: [...byKey.values()].sort(
      (a, b) =>
        a.start.localeCompare(b.start) || a.riderId.localeCompare(b.riderId),
    ),
    skipped,
    duplicates,
    adjusted,
  };
}

// Hub of each rider, from the partner rider lists (partner portal data `riders`).
export function hubMapOf(partnerDatas) {
  const map = new Map();
  for (const data of partnerDatas || []) {
    for (const r of Array.isArray(data?.riders) ? data.riders : []) {
      const id = clean(r?.id, 100).toUpperCase();
      const hub = clean(r?.hubLocation, 120);
      if (id && hub && !map.has(id)) map.set(id, hub);
    }
  }
  return map;
}

function parseIntIn(value, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
}

// Resolves query parameters into a concrete inclusive date range and filter set.
// Rules:
//   start/end given  -> that range (missing side defaults to the selected year).
//   otherwise        -> the selected year (default: current year), Jan 1 to Dec 31.
//   month given      -> restricts the range to that month (within the selected year).
export function resolveFilters(q, today) {
  const mode = q.mode === "365" ? "365" : "15";
  const explicitStart = q.start ? validDay(q.start) : "";
  const explicitEnd = q.end ? validDay(q.end) : "";
  if ((q.start && !explicitStart) || (q.end && !explicitEnd)) {
    throw new ReportError(400, "Enter valid dates (YYYY-MM-DD).");
  }
  if (explicitStart && explicitEnd && explicitStart > explicitEnd) {
    throw new ReportError(400, "The start date cannot be after the end date.");
  }
  const year = parseIntIn(q.year, 2000, 2100);
  const month = parseIntIn(q.month, 1, 12);
  if (Number.isNaN(year)) throw new ReportError(400, "Choose a valid year.");
  if (Number.isNaN(month)) throw new ReportError(400, "Choose a valid month.");

  const y = year ?? +today.slice(0, 4);
  let start = explicitStart || `${y}-01-01`;
  let end = explicitEnd || `${y}-12-31`;
  if (month !== null) {
    const ms = `${y}-${pad(month)}-01`;
    const me = lastDayOfMonth(y, month);
    if (ms > start) start = ms;
    if (me < end) end = me;
  }
  if (start <= end) {
    const days =
      (new Date(end + "T00:00:00Z") - new Date(start + "T00:00:00Z")) / DAY_MS +
      1;
    if (days > MAX_RANGE_DAYS)
      throw new ReportError(
        400,
        "The date range is too long. Choose up to about five years.",
      );
  }
  return {
    mode,
    start,
    end,
    year: year ?? null,
    month,
    search: clean(q.search, 80),
    hub: clean(q.hub, 80),
  };
}

function matches(rec, f) {
  if (rec.start < f.start || rec.start > f.end) return false;
  if (f.search) {
    const s = f.search.toLowerCase();
    if (
      !rec.riderId.toLowerCase().includes(s) &&
      !rec.riderName.toLowerCase().includes(s)
    )
      return false;
  }
  if (f.hub && !rec.hub.toLowerCase().includes(f.hub.toLowerCase()))
    return false;
  return true;
}

// 15-day periods: 1-15 and 16-end of each month, clipped to the selected range.
function buildPeriods(f) {
  const out = [];
  let cur = f.start;
  while (cur <= f.end) {
    const [y, m, d] = cur.split("-").map(Number);
    const boundary = d <= 15 ? `${y}-${pad(m)}-15` : lastDayOfMonth(y, m);
    const end = boundary < f.end ? boundary : f.end;
    const [, , ed] = end.split("-").map(Number);
    out.push({
      key: cur,
      start: cur,
      end,
      label: `${d}–${ed} ${MONTH_SHORT[m - 1]} ${y}`,
    });
    cur = addDays(end, 1);
  }
  return out;
}

// Monthly buckets for the 365-day report, clipped to the selected range.
function buildMonths(f) {
  const out = [];
  let cur = f.start;
  while (cur <= f.end) {
    const [y, m] = cur.split("-").map(Number);
    const monthEnd = lastDayOfMonth(y, m);
    const end = monthEnd < f.end ? monthEnd : f.end;
    out.push({
      key: `${y}-${pad(m)}`,
      start: cur,
      end,
      label: `${MONTH_SHORT[m - 1]} ${y}`,
    });
    cur = addDays(end, 1);
  }
  return out;
}

// Sum of optional money values: null when no record has a value (shown as —), so a missing rate is never a fake 0.
function sumMoney(values) {
  const present = values.filter((v) => v !== null && v !== undefined);
  return present.length
    ? Math.round(present.reduce((s, v) => s + v, 0) * 100) / 100
    : null;
}

function aggregate(recs) {
  const riders = new Set();
  let total = 0,
    prime = 0,
    club = 0,
    large = 0,
    sdd = 0;
  const status = Object.fromEntries(
    PAYMENT_STATUSES.map((k) => [k, { count: 0, amount: 0 }]),
  );
  let totalPaise = 0;
  for (const r of recs) {
    riders.add(r.riderId);
    total += r.total;
    prime += r.prime;
    club += r.club;
    large += r.lm;
    sdd += r.sdd;
    const st = status[normalizeStatus(r.status)];
    st.count++;
    st.amount += toPaise(r.amounts.total);
    totalPaise += toPaise(r.amounts.total);
  }
  for (const k of PAYMENT_STATUSES)
    status[k].amount = fromPaise(status[k].amount);
  return {
    riders: riders.size,
    total,
    prime,
    club,
    large,
    sdd,
    // Payment status totals. Pending is only PENDING; Processing and Failed are shown separately.
    paymentStatus: status,
    paidAmount: status.PAID.amount,
    pendingAmount: status.PENDING.amount,
    processingAmount: status.PROCESSING.amount,
    failedAmount: status.FAILED.amount,
    amounts: {
      lm: sumMoney(recs.map((r) => r.amounts.lm)),
      prime: sumMoney(recs.map((r) => r.amounts.prime)),
      club: sumMoney(recs.map((r) => r.amounts.club)),
      sdd: sumMoney(recs.map((r) => r.amounts.sdd)),
      total: fromPaise(totalPaise),
    },
    percent: {
      prime: pct(prime, total),
      club: pct(club, total),
      large: pct(large, total),
    },
  };
}

// ---------- Fixed snapshot blocks ----------
// Previous week, current week, monthly and 365-day blocks. They are built from the same saved records as the rest of
// the report, and are NOT changed by the filters above: the Admin always sees these fixed periods.
// Weeks are the 7-day Monday-to-Sunday cycle used by the Payments sheets. A record longer than seven days (a 15-day
// cycle) is never placed in a week, so two weeks never share data.
const spanDays = (r) =>
  Math.round(
    (Date.parse(r.end + "T00:00:00Z") - Date.parse(r.start + "T00:00:00Z")) /
      DAY_MS,
  ) + 1;
const pctChange = (from, to) =>
  from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : null;

export function weekOf(day) {
  const dow = new Date(day + "T00:00:00Z").getUTCDay(); // 0 = Sunday
  const start = addDays(day, -((dow + 6) % 7));
  return { start, end: addDays(start, 6) };
}

const inWindow = (recs, start, end) =>
  recs.filter((r) => r.start >= start && r.start <= end);
const block = (label, start, end, recs) => ({
  label,
  start,
  end,
  hasData: recs.length > 0,
  ...aggregate(recs),
});

export function buildSnapshot(collected, today) {
  const day = validDay(today);
  if (!day) throw new ReportError(500, "Today could not be read.");
  const weekly = collected.records.filter((r) => spanDays(r) <= 7);
  const cur = weekOf(day),
    prev = weekOf(addDays(day, -7));
  const currentWeek = block(
    "Current week",
    cur.start,
    cur.end,
    inWindow(weekly, cur.start, cur.end),
  );
  const previousWeek = block(
    "Previous week",
    prev.start,
    prev.end,
    inWindow(weekly, prev.start, prev.end),
  );

  const monthStart = day.slice(0, 8) + "01";
  const [y, m] = day.split("-").map(Number);
  const monthEnd = lastDayOfMonth(y, m);
  const monthly = block(
    `${MONTH_SHORT[m - 1]} ${y}`,
    monthStart,
    monthEnd,
    inWindow(collected.records, monthStart, monthEnd),
  );

  const yearStart = addDays(day, -364); // the last 365 days, including today
  const yearly = block(
    "Last 365 days",
    yearStart,
    day,
    inWindow(collected.records, yearStart, day),
  );

  return {
    today: day,
    currentWeek,
    previousWeek,
    comparison: {
      ridersChange: currentWeek.riders - previousWeek.riders,
      ordersChange: currentWeek.total - previousWeek.total,
      amountChange: fromPaise(
        toPaise(currentWeek.amounts.total) -
          toPaise(previousWeek.amounts.total),
      ),
      amountChangePct: pctChange(
        previousWeek.amounts.total,
        currentWeek.amounts.total,
      ),
    },
    monthly,
    yearly,
    allTime: aggregate(collected.records),
  };
}

// Builds the complete report from the records of recordsFromWeeklyRows(). `today` is YYYY-MM-DD.
export function buildReport(query, collected, today) {
  const f = resolveFilters(query, today);
  const filtered = collected.records.filter((r) => matches(r, f));
  const buckets =
    f.start <= f.end
      ? f.mode === "365"
        ? buildMonths(f)
        : buildPeriods(f)
      : [];

  const items = buckets.map((b) => {
    const recs = filtered.filter((r) => r.start >= b.start && r.start <= b.end);
    return {
      key: b.key,
      label: b.label,
      start: b.start,
      end: b.end,
      ...aggregate(recs),
    };
  });

  // One row per rider per saved week (never combined across weeks).
  const rows = filtered.map((r) => ({
    rowId: r.rowId,
    status: r.status,
    orderId: r.orderId,
    riderId: r.riderId,
    riderName: r.riderName,
    hub: r.hub,
    weekLabel: r.weekLabel,
    start: r.start,
    end: r.end,
    days: r.days,
    total: r.total,
    lm: r.lm,
    prime: r.prime,
    club: r.club,
    sdd: r.sdd,
    amounts: r.amounts,
    amount: r.amounts.total,
    primePct: pct(r.prime, r.total),
    clubPct: pct(r.club, r.total),
    largePct: pct(r.lm, r.total),
    // back-compatible names used by the dashboard
    large: r.lm,
  }));

  const outside = collected.records.length - filtered.length;
  return {
    mode: f.mode,
    range: { start: f.start, end: f.end },
    filters: { year: f.year, month: f.month, search: f.search, hub: f.hub },
    generatedAt: new Date().toISOString(),
    source: "weekly_payments",
    summary: aggregate(filtered),
    snapshot: buildSnapshot(collected, today),
    periods: f.mode === "15" ? items : [],
    months: f.mode === "365" ? items : [],
    rows,
    quality: {
      skippedInvalidRecords: collected.skipped,
      duplicateRecordsIgnored: collected.duplicates,
      totalBelowCategoryCount: collected.adjusted,
      recordsOutsideFilter: outside,
      ridersWithoutHub: new Set(
        filtered.filter((r) => !r.hub).map((r) => r.riderId),
      ).size,
    },
  };
}
