// Weekly payment cycles for the 365-day payment period. Every cycle runs Monday to Sunday.
// Cycle 1 is the Monday-to-Sunday week that contains the first day of the period. The last cycle is cut
// short when the period ends in the middle of a week. Dates are plain YYYY-MM-DD strings (no time zones).
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, "0");

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Monday of the week that contains the given date.
export function mondayOf(iso) {
  if (!ISO.test(iso)) throw new Error(`Not a date: ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((dow + 6) % 7));
}

// The 365-day period as cycles. periodStart defaults to the earliest date in the rows.
// periodDays defaults to 365. Rows outside the period are returned separately, never added to a cycle.
export function buildCycles(rows, { periodStart, periodDays = 365 } = {}) {
  const dates = rows
    .map((r) => r.date)
    .filter((d) => ISO.test(d))
    .sort();
  const start = periodStart || dates[0];
  if (!start) return { cycles: [], outside: [] };
  const end = addDays(start, periodDays - 1);
  const cycles = [];
  for (
    let weekStart = mondayOf(start);
    weekStart <= end;
    weekStart = addDays(weekStart, 7)
  ) {
    const weekEnd = addDays(weekStart, 6);
    const from = weekStart < start ? start : weekStart;
    const to = weekEnd > end ? end : weekEnd;
    cycles.push({
      cycleNumber: cycles.length + 1,
      weekStart,
      weekEnd,
      daysInPeriod:
        Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1,
      from,
      to,
      rows: [],
    });
  }
  const outside = [];
  for (const r of rows) {
    const c = cycles.find((x) => r.date >= x.from && r.date <= x.to);
    if (c) c.rows.push(r);
    else outside.push(r);
  }
  return { cycles, outside, periodStart: start, periodEnd: end };
}

const sum = (rows, key) => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);

// Totals for one cycle. Money is summed in paise so the totals do not drift.
export function cycleTotals(cycle) {
  const rows = cycle.rows;
  const paise = rows.reduce(
    (n, r) => n + Math.round((Number(r.amount) || 0) * 100),
    0,
  );
  return {
    cycleNumber: cycle.cycleNumber,
    weekStart: cycle.weekStart,
    weekEnd: cycle.weekEnd,
    daysInPeriod: cycle.daysInPeriod,
    totalRiders: new Set(rows.map((r) => r.riderKey)).size,
    totalOrders: sum(rows, "lm"),
    totalLm: sum(rows, "lm"),
    totalPrime: sum(rows, "primary"),
    totalClub: sum(rows, "club"),
    totalSsdOrders: sum(rows, "sdd"),
    totalSsdPayment: sum(rows, "sddAmount"),
    totalAmount: paise / 100,
  };
}
