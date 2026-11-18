// Run with:  node --test --no-warnings test/weekly-payments.test.mjs   (from the backend folder)
// Part 1 tests the Excel reader (../../dashboard/payment-excel.js) on real .xlsx files in test/fixtures
//   (grids.json holds those files exactly as the browser's Excel library hands them over: dates as serial numbers).
// Part 2 tests saving, duplicates, refresh (re-reading the database) and search in weekly-payments.js.
// The database is Node's built-in SQLite, which has the same prepare/run/get/all/exec calls the backend uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createWeeklyPaymentService, WeeklyPaymentError} from '../weekly-payments.js';

const require = createRequire(import.meta.url);
const PX = require('../../dashboard/payment-excel.js');
const read = f => JSON.parse(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8'));
const grids = read('grids.json'), expected = read('expected.json');
const parse = name => PX.parseSheets(grids[name]);

// every Excel row must come out exactly as it was written in the sheet
function assertMatchesExcel(name, res) {
  assert.equal(res.ok, true, res.error);
  const want = expected[name];
  assert.equal(res.records.length, want.length, `${name}: record count`);
  for (const w of want) {
    const got = res.records.find(r => r.riderName === w.rider && r.weekLabel === w.week);
    assert.ok(got, `${name}: no record for ${w.rider} / ${w.week}. Got: ${res.records.map(r => r.riderName + '|' + r.weekLabel)}`);
    assert.equal(got.riderId, w.riderId, `${w.rider} rider id`);
    assert.equal(got.days, w.days, `${w.rider} days`);
    assert.equal(got.lm, w.lm, `${w.rider} lm`);
    assert.equal(got.primary, w.primary, `${w.rider} primary`);
    assert.equal(got.club, w.club, `${w.rider} club`);
    if (w.sdd !== undefined) assert.equal(got.sdd, w.sdd, `${w.rider} sdd`);
    assert.equal(got.amount, w.amount, `${w.rider} amount`);
  }
}

test('weekly sheet with a title row, a TOTAL row and a blank amount: every row matches Excel', () => {
  const res = parse('weekly-19oct-25oct');
  assertMatchesExcel('weekly-19oct-25oct', res);
  assert.equal(res.layout, 'weekly');
  assert.equal(res.sheets[0].amountColumn, 'WEEKLY AMOUNT (₹)');
  // blank and missing Excel amounts are normalized to ₹0 for display and storage
  assert.equal(res.records.find(r => r.riderName === 'Karedla Vijaya Seshagiri').amount, 0);
  assert.equal(res.records.find(r => r.riderName === 'Peram Krishna Rao').amount, 0);
  assert.equal(res.records.find(r => r.riderName === 'Peram Krishna Rao').amountRaw, '');
  assert.equal(res.totalAmount, 4520.5 + 3800 + 12345.75);
  assert.equal(res.records.find(r => r.riderName === 'Appari Ravi Kumar').weekStart, '2026-10-19');
});

test('other headers, blank (merged) week cells, a real date as the week, ₹ text amounts, and the WEEKLY column beats a per-day Payout column', () => {
  const res = parse('weekly-26oct-01nov');
  assertMatchesExcel('weekly-26oct-01nov', res);
  assert.equal(res.sheets[0].amountColumn, 'Weekly Amount');
  assert.equal(res.records.find(r => r.riderName === 'Appari Ravi Kumar').amount, 5210.25);
  assert.equal(res.records.find(r => r.riderName === 'Nagababu Annemreddy').amount, 1999.99);
  // all four rows are in the week of the first row (blank week cells repeat it)
  assert.equal(new Set(res.records.map(r => r.weekKey)).size, 1);
});

test('daily settlement sheet spanning two weeks: grouped per rider and week, days counted, payout summed', () => {
  const res = parse('daily-settlement-two-weeks');
  assertMatchesExcel('daily-settlement-two-weeks', res);
  assert.equal(res.layout, 'daily');
  assert.equal(res.weeks.length, 2);
  const fazzaley = res.records.filter(r => r.riderName === 'Mohammed Fazzaley Khaza');
  assert.equal(fazzaley.reduce((s, r) => s + r.days, 0), 6); // one day off
});

test('wide sheet (one column per date, "LM/Primary" cells, Payment Completed column)', () => {
  const res = parse('wide-summary');
  assertMatchesExcel('wide-summary', res);
  assert.equal(res.layout, 'wide');
});

test('a sheet without a rider table gives a clear error, not an empty import', () => {
  const res = parse('unreadable');
  assert.equal(res.ok, false);
  assert.match(res.error, /No payment table could be read/);
});

test('helpers: rupee text, Indian grouping, dates in text', () => {
  assert.equal(PX.toNumber('₹ 1,23,456.50'), 123456.5);
  assert.equal(PX.toNumber('Rs. 900'), 900);
  assert.equal(PX.toNumber('(500)'), -500);
  assert.equal(PX.toNumber(''), null);
  assert.equal(PX.toNumber('n/a'), null);
  assert.equal(PX.formatINR(1234567.5), '₹12,34,567.50');
  assert.equal(PX.formatINR(0), '₹0.00');
  assert.equal(PX.formatINR(null), '₹0.00');
  assert.deepEqual(PX.findDates('26/10/2026 - 01/11/2026'), ['2026-10-26', '2026-11-01']);
  assert.deepEqual(PX.findDates('26 Oct - 01 Nov 2026'), ['2026-10-26', '2026-11-01']);
  assert.deepEqual(PX.findDates('29 Dec - 04 Jan 2026'), ['2025-12-29', '2026-01-04']);
  assert.deepEqual(PX.findDates('26/10 - 01/11'), []); // no year anywhere: not guessed
  assert.equal(PX.cellDate(46321), '2026-10-26');
  assert.equal(PX.mondayOf('2026-11-01'), '2026-10-26'); // Sunday belongs to the week that started Monday 26 Oct
});

test('a big sheet (5,000 riders x 2 weeks) is read completely', () => {
  const grid = [['WEEK', 'RIDER ID', 'RIDER', 'DAYS', 'LM', 'PRIMARY', 'CLUB', 'SDD', 'WEEKLY AMOUNT']];
  for (let i = 0; i < 5000; i++) for (const w of ['19/10/2026 - 25/10/2026', '26/10/2026 - 01/11/2026']) grid.push([w, 'R' + i, 'Rider ' + i, 5, 100, 60, 40, 2, 1000 + i + 0.25]);
  const res = PX.parseSheets([{name: 'S', grid}]);
  assert.equal(res.records.length, 10000);
  assert.equal(res.skipped.length, 0);
  assert.equal(res.records[9999].amount, 1000 + 4999 + 0.25);
});

// ---------------- saving ----------------
const freshService = () => createWeeklyPaymentService({db: new DatabaseSync(':memory:')});
const send = (svc, name, extra = {}) => svc.importRecords({fileName: name + '.xlsx', fileHash: name, records: parse(name).records, ...extra}, 'admin@test');

test('import saves every row, keeps amounts exact, and a refresh (list) returns the same data', () => {
  const svc = freshService();
  const out = send(svc, 'weekly-19oct-25oct');
  assert.equal(out.inserted, 5);
  const {records} = svc.list();
  assert.equal(records.length, 5);
  const ravi = records.find(r => r.rider === 'Appari Ravi Kumar');
  assert.deepEqual([ravi.week, ravi.riderId, ravi.days, ravi.lm, ravi.primary, ravi.club, ravi.amount], ['19/10/2026 - 25/10/2026', 'OTW-101', 6, 214, 150, 64, 4520.5]);
  assert.equal(records.find(r => r.rider === 'Pollareddy Narayanareddy').amount, 12345.75);
  assert.equal(records.find(r => r.rider === 'Peram Krishna Rao').amount, 0);
  assert.equal(records.find(r => r.rider === 'Karedla Vijaya Seshagiri').amount, 0);
});

test('importing the same file twice adds nothing and says so', () => {
  const svc = freshService();
  send(svc, 'weekly-19oct-25oct');
  const again = send(svc, 'weekly-19oct-25oct');
  assert.equal(again.inserted, 0);
  assert.equal(again.unchanged, 5);
  assert.equal(again.alreadyImported, true);
  assert.equal(svc.list().records.length, 5);
});

test('a second week is added next to the first; the first week is untouched', () => {
  const svc = freshService();
  send(svc, 'weekly-19oct-25oct');
  const out = send(svc, 'weekly-26oct-01nov');
  assert.equal(out.inserted, 4);
  const {records} = svc.list();
  assert.equal(records.length, 9);
  assert.equal(new Set(records.map(r => r.weekKey)).size, 2);
  // oldest week first: the earliest week at the top, the latest at the bottom
  assert.equal(records[0].weekStart, '2026-10-19');
  assert.equal(records[records.length - 1].weekStart, '2026-10-26');
  const ravi = records.filter(r => r.rider === 'Appari Ravi Kumar');
  assert.deepEqual(ravi.map(r => r.amount).sort(), [4520.5, 5210.25]);
});

test('a corrected sheet for a week already imported updates those rows (no duplicates)', () => {
  const svc = freshService();
  send(svc, 'weekly-19oct-25oct');
  const fixed = parse('weekly-19oct-25oct').records.map(r => (r.riderName === 'Peram Krishna Rao' ? {...r, amount: 2750.4} : r));
  const out = svc.importRecords({fileName: 'corrected.xlsx', fileHash: 'other', records: fixed}, 'admin@test');
  assert.deepEqual([out.inserted, out.updated, out.unchanged], [0, 1, 4]);
  const rows = svc.list().records;
  assert.equal(rows.length, 5);
  assert.equal(rows.find(r => r.rider === 'Peram Krishna Rao').amount, 2750.4);
});

test('daily and weekly sheets of the same week do not create two rows for a rider', () => {
  const svc = freshService();
  send(svc, 'daily-settlement-two-weeks');
  const total = svc.list().records.length;
  send(svc, 'daily-settlement-two-weeks');
  assert.equal(svc.list().records.length, total);
  assert.equal(total, expected['daily-settlement-two-weeks'].length);
});

test('rows without Rider IDs are rejected rather than matched by name', () => {
  const svc = freshService();
  const wide = parse('wide-summary').records;
  assert.throws(() => svc.importRecords({fileName: 'wide.xlsx', fileHash: 'w', records: wide}, 'a'), /verified Rider ID/);
  assert.equal(svc.list().records.length, 0);
});

test('search by rider name, Rider ID and week', () => {
  const svc = freshService();
  send(svc, 'weekly-19oct-25oct');
  send(svc, 'weekly-26oct-01nov');
  assert.deepEqual(svc.list({q: 'ravi'}).records.map(r => r.rider), ['Appari Ravi Kumar', 'Appari Ravi Kumar']);
  assert.deepEqual(svc.list({q: 'otw-103'}).records.map(r => r.rider), ['Pollareddy Narayanareddy', 'Pollareddy Narayanareddy']);
  assert.equal(svc.list({q: '19/10/2026'}).records.length, 5);
  assert.equal(svc.list({q: '2026-10-26'}).records.length, 4);
  assert.equal(svc.list({q: '100%'}).records.length, 0); // % is not a wildcard
  assert.equal(svc.list({q: 'zzz'}).records.length, 0);
});

test('bad input is refused with a clear message and saves nothing', () => {
  const svc = freshService();
  assert.throws(() => svc.importRecords({records: []}), WeeklyPaymentError);
  assert.throws(() => svc.importRecords({records: [{riderName: 'A', riderId: 'R1', riderKey: 'id:r1', weekKey: 'd:x', weekLabel: 'W', amount: 'abc'}]}), /amount is not a number/);
  assert.throws(() => svc.importRecords({records: [{riderName: 'A', riderKey: 'n:a', weekKey: 'k', weekLabel: 'W'}]}), /verified Rider ID/);
  assert.equal(svc.list().records.length, 0);
});

// ---------------- the Weekly Payments table format (9 columns) ----------------
// The header names exactly as the admin's sheet uses them; a week written above the table.
const SPEC_HEADERS = ['S.No', 'Rider ID', 'Rider Name', 'Days', 'LM Orders', 'Prime Orders', 'Club Orders', 'SDD Orders', 'Total Amount'];
const specGrid = (extraCols = [], amountHeader = 'Total Amount') => {
  const headers = SPEC_HEADERS.map(h => (h === 'Total Amount' ? amountHeader : h)).concat(extraCols.map(c => c[0]));
  const rows = [
    ['Payment Week: 19/10/2026 - 25/10/2026'],
    [],
    headers,
    [1, 'OTW-201', 'Test Rider One', 5, 100, 70, 30, 4, 2345.5].concat(extraCols.map(c => c[1])),
    [2, 'OTW-202', 'Test Rider Two', 6, 120, 80, 40, 0, 0].concat(extraCols.map(c => c[2])),
    [3, 'OTW-203', 'Test Rider Three', 0, 0, 0, 0, 0, ''].concat(extraCols.map(c => c[3])),
  ];
  return rows;
};

test('the spec headers (Prime Orders, SDD Orders, Total Amount) are read exactly from the sheet', () => {
  const res = PX.parseSheets([{name: 'Weekly', grid: specGrid()}]);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.records.length, 3);
  const one = res.records.find(r => r.riderName === 'Test Rider One');
  assert.deepEqual(
    [one.riderId, one.days, one.lm, one.primary, one.club, one.sdd, one.amount, one.weekStart, one.weekEnd],
    ['OTW-201', 5, 100, 70, 30, 4, 2345.5, '2026-10-19', '2026-10-25']
  );
  // a zero stays zero; a blank Total Amount is normalized to zero
  assert.equal(res.records.find(r => r.riderName === 'Test Rider Two').sdd, 0);
  assert.equal(res.records.find(r => r.riderName === 'Test Rider Three').amount, 0);
  assert.equal(res.sheets[0].amountColumn, 'Total Amount');
});

test('a weekly sheet missing SDD Orders is refused with a clear message, not imported with blanks', () => {
  const g = specGrid();
  const i = SPEC_HEADERS.indexOf('SDD Orders');
  g.forEach(r => r.splice(i, 1));
  const res = PX.parseSheets([{name: 'Weekly', grid: g}]);
  assert.equal(res.ok, false);
  assert.match(res.error, /SDD Orders/);
  assert.match(res.error, /missing or not recognised/);
});

test('a weekly sheet with no Total Amount column is refused with a clear message', () => {
  const g = specGrid([], 'Grand Figure');
  const res = PX.parseSheets([{name: 'Weekly', grid: g}]);
  assert.equal(res.ok, false);
  assert.match(res.error, /Total Amount/);
});

test('Total Amount beats a per-day Payout Amount column in the same sheet', () => {
  const g = specGrid([['Payout Amount', 900, 0, 0]]);
  g[2].splice(g[2].length - 1, 0); // keep layout simple: header still has both columns
  const res = PX.parseSheets([{name: 'Weekly', grid: g}]);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.sheets[0].amountColumn, 'Total Amount');
  assert.equal(res.records.find(r => r.riderName === 'Test Rider One').amount, 2345.5);
});

test('an existing database without the SDD column gets it added, and old rows keep their values', () => {
  const old = new DatabaseSync(':memory:');
  old.exec(`CREATE TABLE weekly_payments(id INTEGER PRIMARY KEY AUTOINCREMENT, rider_key TEXT NOT NULL, week_key TEXT NOT NULL,
    name_key TEXT NOT NULL DEFAULT '', week_label TEXT NOT NULL, week_start TEXT NOT NULL DEFAULT '', week_end TEXT NOT NULL DEFAULT '',
    rider_name TEXT NOT NULL, rider_id TEXT NOT NULL DEFAULT '', days REAL, lm REAL, primary_orders REAL, club REAL, amount REAL,
    amount_raw TEXT NOT NULL DEFAULT '', source_file TEXT NOT NULL DEFAULT '', sheet TEXT NOT NULL DEFAULT '', row_number INTEGER,
    original TEXT NOT NULL DEFAULT '{}', import_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(rider_key, week_key));`);
  old.prepare(`INSERT INTO weekly_payments(rider_key,week_key,name_key,week_label,week_start,week_end,rider_name,rider_id,days,lm,primary_orders,club,amount,created_at,updated_at)
    VALUES('id:otw-101','d:2026-10-19','appari ravi kumar','19/10/2026 - 25/10/2026','2026-10-19','2026-10-25','Appari Ravi Kumar','OTW-101',6,214,150,64,4520.5,'x','x')`).run();
  const svc = createWeeklyPaymentService({db: old});
  const before = svc.list().records;
  assert.equal(before.length, 1);
  assert.equal(before[0].amount, 4520.5);
  assert.equal(before[0].sdd, null);
  const out = svc.importRecords({fileName: 'w.xlsx', fileHash: 'h', records: [{
    riderKey: 'id:otw-101', weekKey: 'd:2026-10-19', weekLabel: '19/10/2026 - 25/10/2026', weekStart: '2026-10-19', weekEnd: '2026-10-25',
    riderName: 'Appari Ravi Kumar', riderId: 'OTW-101', days: 6, lm: 214, primary: 150, club: 64, sdd: 3, amount: 4520.5, amountRaw: '4520.5',
  }]}, 'admin@test');
  assert.deepEqual([out.inserted, out.updated], [0, 1]);
  assert.equal(svc.list().records[0].sdd, 3);
});

test('SDD Orders is saved, shown after a refresh, and a change to it updates the row', () => {
  const svc = freshService();
  send(svc, 'weekly-19oct-25oct');
  const ravi = svc.list().records.find(r => r.rider === 'Appari Ravi Kumar');
  assert.equal(ravi.sdd, 3);
  const fixed = parse('weekly-19oct-25oct').records.map(r => (r.riderName === 'Appari Ravi Kumar' ? {...r, sdd: 7} : r));
  const out = svc.importRecords({fileName: 'sdd-fix.xlsx', fileHash: 'sdd-fix', records: fixed}, 'admin@test');
  assert.deepEqual([out.inserted, out.updated, out.unchanged], [0, 1, 4]);
  assert.equal(svc.list().records.find(r => r.rider === 'Appari Ravi Kumar').sdd, 7);
});

test('OnTheWay multi-week workbook: repairs Excel date headers, reads every weekly block and preserves formula amounts', () => {
  const source = read('otw-weekly-blocks.json');
  const res = PX.parseSheets(source);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.layout, 'wide');
  assert.equal(res.weeks.length, 10);
  assert.equal(res.weeks[0], '24/08/2026 - 30/08/2026');
  assert.equal(res.weeks[1], '31/08/2026 - 06/09/2026');
  assert.equal(res.weeks[6], '05/10/2026 - 11/10/2026');
  const ravi = res.records.find(r => r.riderName.startsWith('Appari Ravi Kumar') && r.weekStart === '2026-08-31');
  assert.ok(ravi);
  assert.deepEqual([ravi.days, ravi.totalOrders, ravi.lm, ravi.primary, ravi.club, ravi.amount], [7, 150, 150, 144, 6, 2628]);
  // no rate in this sheet, so Prime/Club amounts are unknown (—, null), not an invented ₹0 and not inferred from order counts
  assert.deepEqual([ravi.primeAmount, ravi.clubAmount], [null, null]);
  assert.ok(res.warnings.some(w => /did not match the week title/.test(w)));
});

// ---------- rider-wise payment spec: Excel columns, LM x ₹10, rider rates, zeros, duplicates ----------
const SPEC11 = ['S.NO', 'Rider ID', 'Rider Name', 'Week', 'Days', 'Total Orders', 'LM Orders', 'Prime Orders', 'Club Orders', 'SDD Orders', 'Amount'];
const WEEK = '26/10/2026 - 01/11/2026';
// rows: [id, name, days, totalOrders, lm, prime, club, sdd, amount, rate?]
const specRows = (rows, withRate) => {
  const headers = withRate ? [...SPEC11, 'Rate'] : SPEC11;
  return [headers, ...rows.map((r, i) => [i + 1, r[0], r[1], WEEK, r[2], r[3], r[4], r[5], r[6], r[7], r[8], ...(withRate ? [r[9] ?? ''] : [])].slice(0, headers.length))];
};
const byId = (res, id) => res.records.find(r => r.riderId === id);

test('spec headers: Total Orders is read from its own column (not copied from LM), and the Week is kept', () => {
  const grid = specRows([['OTW-301', 'Rider Alpha', 7, 380, 372, 300, 80, 5, 5970, 18]], true);
  const res = PX.parseSheets([{name: 'Payments', grid}]);
  assert.equal(res.ok, true, res.error);
  const r = byId(res, 'OTW-301');
  assert.equal(r.totalOrders, 380);
  assert.equal(r.lm, 372);
  assert.equal(r.days, 7);
  assert.equal(r.weekLabel, WEEK);
});

test('LM Amount = LM Orders x ₹10 (372 -> 3720, 399 -> 3990, 0 -> 0, 1 -> 10, 10 -> 100)', () => {
  const grid = specRows([
    ['OTW-301', 'Rider Alpha', 7, 380, 372, 0, 0, 0, 5970, 18],
    ['OTW-302', 'Rider Beta', 7, 399, 399, 0, 0, 0, 6482, 19],
    ['OTW-303', 'Rider Gamma', 1, 1, 1, 0, 0, 0, 0, 18],
    ['OTW-304', 'Rider Delta', 1, 10, 10, 0, 0, 0, 0, 18],
    ['OTW-305', 'Rider Zero', 0, 0, 0, 0, 0, 0, 0, 18],
  ], true);
  const res = PX.parseSheets([{name: 'Payments', grid}]);
  assert.equal(res.ok, true, res.error);
  assert.equal(byId(res, 'OTW-301').lmAmount, 3720);
  assert.equal(byId(res, 'OTW-302').lmAmount, 3990);
  assert.equal(byId(res, 'OTW-303').lmAmount, 10);
  assert.equal(byId(res, 'OTW-304').lmAmount, 100);
  assert.equal(byId(res, 'OTW-305').lmAmount, 0, 'a real zero LM count gives ₹0, not —');
});

test('Excel Amount is the Total Amount, exactly (₹5,970 and ₹6,482), and is never replaced by a calculation', () => {
  const grid = specRows([
    ['OTW-301', 'Rider Alpha', 7, 380, 372, 300, 80, 5, 5970, 18],
    ['OTW-302', 'Rider Beta', 7, 399, 399, 0, 0, 0, 6482, 19],
  ], true);
  const res = PX.parseSheets([{name: 'Payments', grid}]);
  assert.equal(byId(res, 'OTW-301').amount, 5970);
  assert.equal(byId(res, 'OTW-302').amount, 6482);
});

test('rider-wise rates: ₹18 and ₹19 are read per rider from the sheet and applied to Prime orders only', () => {
  const grid = specRows([
    ['OTW-301', 'Rider Alpha', 7, 380, 372, 300, 80, 5, 5970, 18],
    ['OTW-302', 'Rider Beta', 7, 399, 399, 200, 199, 0, 6482, 19],
  ], true);
  const res = PX.parseSheets([{name: 'Payments', grid}]);
  const a = byId(res, 'OTW-301'), b = byId(res, 'OTW-302');
  assert.deepEqual([a.primeRate, b.primeRate], [18, 19]);
  assert.equal(a.primeAmount, 300 * 18);
  assert.equal(b.primeAmount, 200 * 19);
  assert.equal(a.clubAmount, null, 'no club rate in the sheet: Club amount is unknown (—), not invented');
  assert.equal(a.lmRate, 10);
});

test('a rate column with Prime and Club rates in one cell is split correctly', () => {
  const headers = [...SPEC11, 'Rate Applicable'];
  const grid = [headers, [1, 'OTW-301', 'Rider Alpha', WEEK, 7, 380, 372, 300, 80, 5, 5970, '₹18.5 Pri / ₹12.25 Club']];
  const res = PX.parseSheets([{name: 'Payments', grid}]);
  assert.equal(res.ok, true, res.error);
  const a = byId(res, 'OTW-301');
  assert.deepEqual([a.primeRate, a.clubRate], [18.5, 12.25]);
  assert.equal(a.primeAmount, 300 * 18.5);
  assert.equal(a.clubAmount, 80 * 12.25);
});

test('zeros stay zeros: a rider with all-zero orders and ₹0 shows 0 counts, ₹0 LM and ₹0 total', () => {
  const grid = specRows([['OTW-305', 'Rider Zero', 0, 0, 0, 0, 0, 0, 0, 18]], true);
  const res = PX.parseSheets([{name: 'Payments', grid}]);
  const z = byId(res, 'OTW-305');
  assert.deepEqual([z.days, z.totalOrders, z.lm, z.primary, z.club, z.sdd, z.lmAmount, z.primeAmount, z.amount], [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('storage: amounts, rates and Total Orders are saved per Rider ID and week; re-import makes no duplicates; a changed sheet updates the row', () => {
  const svc = freshService();
  const grid = specRows([
    ['OTW-301', 'Rider Alpha', 7, 380, 372, 300, 80, 5, 5970, 18],
    ['OTW-302', 'Rider Beta', 7, 399, 399, 0, 0, 0, 6482, 19],
  ], true);
  const records = PX.parseSheets([{name: 'Payments', grid}]).records;
  const first = svc.importRecords({fileName: 'oct.xlsx', fileHash: 'h1', records}, 'admin@test');
  assert.equal(first.inserted, 2);
  // refresh: read the database again
  let rows = svc.list().records;
  const a = rows.find(r => r.riderId === 'OTW-301');
  assert.deepEqual([a.totalOrders, a.lm, a.lmAmount, a.primeRate, a.primeAmount, a.clubAmount, a.amount], [380, 372, 3720, 18, 5400, null, 5970]);
  assert.equal(rows.find(r => r.riderId === 'OTW-302').amount, 6482);
  // the same file again: nothing duplicated, nothing changed
  const again = svc.importRecords({fileName: 'oct.xlsx', fileHash: 'h1', records}, 'admin@test');
  assert.deepEqual([again.inserted, again.updated, again.unchanged], [0, 0, 2]);
  assert.equal(svc.list().records.length, 2);
  // corrected amount for one rider updates only that rider's row
  const fixed = records.map(r => (r.riderId === 'OTW-302' ? {...r, amount: 6500} : r));
  const third = svc.importRecords({fileName: 'oct-fixed.xlsx', fileHash: 'h2', records: fixed}, 'admin@test');
  assert.deepEqual([third.inserted, third.updated, third.unchanged], [0, 1, 1]);
  rows = svc.list().records;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.riderId === 'OTW-302').amount, 6500);
  assert.equal(rows.find(r => r.riderId === 'OTW-301').amount, 5970);
});

// Final rule: Total Amount is exactly the Excel Amount cell, never recalculated from orders or rates.
test('FINAL RULE: Total Amount = Excel Amount exactly (5,970 / 6,482 / 0), kept after re-reading the database; LM Amount stays separate', () => {
  const svc = freshService();
  const grid = specRows([
    ['OTW-301', 'Rider Alpha', 7, 380, 372, 300, 80, 5, 5970, 18],
    ['OTW-302', 'Rider Beta', 7, 399, 399, 200, 0, 0, 6482, 19],
    ['OTW-305', 'Rider Zero', 0, 0, 0, 0, 0, 0, 0, 18],
  ], true);
  const records = PX.parseSheets([{name: 'Payments', grid}]).records;
  svc.importRecords({fileName: 'final.xlsx', fileHash: 'final', records}, 'admin@test');
  const rows = svc.list().records; // refresh: read back from the database
  const amt = id => rows.find(r => r.riderId === id);
  assert.equal(amt('OTW-301').amount, 5970);
  assert.equal(amt('OTW-302').amount, 6482);
  assert.equal(amt('OTW-305').amount, 0);
  assert.equal(amt('OTW-301').lmAmount, 3720);   // shown separately
  assert.equal(amt('OTW-301').amount, 5970, 'LM Amount is not added to Total Amount');
  assert.equal(PX.formatINR(5970), '₹5,970.00');
  assert.equal(PX.formatINR(6482), '₹6,482.00');
  assert.equal(PX.formatINR(0), '₹0.00');
});

// ---------- oldest-first order and permanent Rider IDs against Rider Registration ----------
const freshRegistryService = (regs) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rider_registrations(id TEXT PRIMARY KEY, rider_id TEXT NOT NULL, rider_key TEXT NOT NULL, rider_name TEXT NOT NULL, application_status TEXT NOT NULL)');
  regs.forEach((r, i) => db.prepare('INSERT INTO rider_registrations VALUES(?,?,?,?,?)').run('r' + i, r.id, r.id.toUpperCase(), r.name, r.status || 'APPROVED'));
  return {db, svc: createWeeklyPaymentService({db, riderRegistry: true})};
};
const sheetRow = (id, name, week, amount = 100) => ({riderId: id, riderName: name, riderKey: 'id:' + id.toLowerCase(), weekKey: 'd:' + week.start,
  weekLabel: `${week.start} - ${week.end}`, weekStart: week.start, weekEnd: week.end, days: 7, totalOrders: 10, lm: 10, primary: 0, club: 0, sdd: 0,
  amount, amountRaw: String(amount), sheet: 'S', rowNumber: 1, original: {}});
const W = (s, e) => ({start: s, end: e});

test('records come back oldest week first, whatever order they were imported in', () => {
  const {svc} = freshRegistryService([{id: 'WL001', name: 'Appari Ravi Kumar'}]);
  svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: [
    sheetRow('WL001', 'Appari Ravi Kumar', W('2026-10-26', '2026-11-01')),
    sheetRow('WL001', 'Appari Ravi Kumar', W('2026-08-24', '2026-08-30')),
    sheetRow('WL001', 'Appari Ravi Kumar', W('2026-09-07', '2026-09-13')),
  ]}, 'admin');
  assert.deepEqual(svc.list().records.map(r => r.weekStart), ['2026-08-24', '2026-09-07', '2026-10-26']);
});

test('a name alone never replaces a Rider ID: rows with an unregistered ID are held, the approved ID row is verified', () => {
  const {svc} = freshRegistryService([{id: 'WL001', name: 'Appari Ravi Kumar'}]);
  const out = svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: [
    sheetRow('WLoo82', 'Appari Ravi Kumar', W('2026-08-24', '2026-08-30')),
    sheetRow('WLoo73', 'Appari Ravi Kumar', W('2026-08-31', '2026-09-06')),
    sheetRow('WL001', 'Appari Ravi Kumar', W('2026-09-07', '2026-09-13')),
  ]}, 'admin');
  assert.equal(out.inserted, 3);
  assert.equal(out.review.length, 2);
  assert.deepEqual(svc.list().records.filter(r => r.verificationStatus === 'VERIFIED').map(r => r.riderId), ['WL001']);
  assert.equal(svc.list().records.filter(r => r.verificationStatus === 'PENDING_VERIFICATION').every(r => r.riderId === ''), true);
});

test('a Rider ID is matched by ID; the registered name is shown and the different sheet name is reported', () => {
  const {svc} = freshRegistryService([{id: 'WL002', name: 'Shaik Ahmad Sharief'}]);
  const out = svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: [
    sheetRow('WL002', 'Appari Ravi Kumar', W('2026-08-24', '2026-08-30')),
    sheetRow('WL002', 'Shaik Ahmad Sharief', W('2026-08-31', '2026-09-06')),
  ]}, 'admin');
  assert.equal(out.inserted, 2);
  assert.equal(out.corrections.length, 1);
  assert.equal(out.corrections[0].to, 'Shaik Ahmad Sharief');
  const rows = svc.list().records;
  assert.ok(rows.every(r => r.riderId === 'WL002' && r.rider === 'Shaik Ahmad Sharief' && r.verificationStatus === 'VERIFIED'));
});

test('a rider not in Rider Registration is held for review; a shared name never decides the match', () => {
  const {svc} = freshRegistryService([{id: 'WL001', name: 'Twin Name'}, {id: 'WL009', name: 'Twin Name'}]);
  const out = svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: [
    sheetRow('WL777', 'Twin Name', W('2026-08-24', '2026-08-30')),
    sheetRow('WL555', 'Nobody Known', W('2026-08-24', '2026-08-30')),
    sheetRow('WL001', 'Twin Name', W('2026-08-24', '2026-08-30')),
  ]}, 'admin');
  assert.equal(out.inserted, 3, 'all rows, including provisional riders, are saved');
  assert.equal(out.review.length, 2);
  assert.match(out.review[0].reason, /not in Rider Registration/);
  assert.match(out.review[1].reason, /Saved provisionally/);
  assert.equal(svc.list().records.filter(r => r.verificationStatus === 'PENDING_VERIFICATION').length, 2);
  assert.equal(svc.list().records.find(r => r.weekStart === '2026-08-24' && r.riderId === 'WL001').verificationStatus, 'VERIFIED');
});

test('when no row can be verified, nothing is rejected: every row is kept as pending with its reason', () => {
  const {svc} = freshRegistryService([]);
  const out = svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: [sheetRow('WL001', 'Nobody', W('2026-08-24', '2026-08-30'))]}, 'admin');
  assert.equal(out.inserted, 1, 'the provisional weekly payment is saved');
  assert.equal(out.pendingAdded, 1);
  assert.equal(out.provisionalSaved, 1);
  assert.equal(out.registeredCount, 0);
  assert.equal(svc.list().records.length, 1);
  assert.equal(svc.list().records[0].verificationStatus, 'PENDING_VERIFICATION');
  const p = svc.listPending().pending;
  assert.equal(p.length, 1);
  assert.equal(p[0].rider, 'Nobody');
  assert.equal(p[0].excelRiderId, 'WL001');
  assert.equal(p[0].weekStart, '2026-08-24');
  assert.match(p[0].reason, /not in Rider Registration/);
});

test('a partly verified file saves every verified row and keeps the rest as pending (no valid row lost)', () => {
  const {svc} = freshRegistryService([{id: 'WL001', name: 'Appari Ravi Kumar'}]);
  const out = svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: [
    sheetRow('WL001', 'Appari Ravi Kumar', W('2026-08-24', '2026-08-30')),
    sheetRow('WL001', 'Appari Ravi Kumar', W('2026-08-31', '2026-09-06')),
    sheetRow('WL777', 'Someone Else', W('2026-08-24', '2026-08-30')),
  ]}, 'admin');
  assert.equal(out.importedFromFile, 2);
  assert.equal(svc.list().records.length, 3, 'two verified rows and one provisional row are saved');
  assert.equal(out.provisionalSaved, 1);
  assert.equal(out.pendingTotal, 1);
});

test('a blank Rider ID is never matched by name: the row stays pending', () => {
  const {svc} = freshRegistryService([{id: 'WL001', name: 'Appari Ravi Kumar (Palakollu 1)'}]);
  const out = svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: [
    sheetRow('', 'Appari  Ravi Kumar (palakollu 1)', W('2026-08-24', '2026-08-30')),
  ]}, 'admin');
  assert.equal(out.inserted, 1);
  assert.equal(out.review.length, 1);
  assert.equal(svc.list().records[0].verificationStatus, 'PENDING_VERIFICATION');
  assert.equal(svc.list().records[0].riderId, '');
});



test('a matching Rider ID with a different hub name is verified by ID and the name difference is reported', () => {
  const {svc} = freshRegistryService([{id: 'WL001', name: 'Appari Ravi Kumar (Palakollu 1)'}]);
  const out = svc.importRecords({fileName: 'different-hub.xlsx', fileHash: 'different-hub', records: [
    sheetRow('WL001', 'Appari Ravi Kumar (Hyderabad)', W('2026-08-24', '2026-08-30')),
  ]}, 'admin');
  assert.equal(out.review.length, 0);
  assert.equal(out.corrections.length, 1);
  assert.equal(svc.list().records.length, 1);
  assert.equal(svc.list().records[0].riderId, 'WL001');
  assert.equal(svc.list().records[0].rider, 'Appari Ravi Kumar (Palakollu 1)');
});

test('a pending row is imported automatically once its rider is registered, with no duplicate', () => {
  const {db, svc} = freshRegistryService([]);
  const recs = [sheetRow('WL001', 'Late Registered', W('2026-08-24', '2026-08-30'), 700)];
  svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: recs}, 'admin');
  svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: recs}, 'admin'); // same file again: still one pending row
  assert.equal(svc.listPending().pending.length, 1);
  db.prepare("INSERT INTO rider_registrations VALUES('rx','WL001','WL001','Late Registered','APPROVED')").run();
  const out = svc.importRecords({fileName: 'other.xlsx', fileHash: 'other', records: [sheetRow('WL002', 'Nobody Here', W('2026-08-31', '2026-09-06'))]}, 'admin');
  assert.equal(out.importedFromPending, 1);
  assert.equal(svc.listPending().pending.length, 1, 'only the unrelated row is still pending');
  assert.equal(svc.list().records.find(r => r.rider === 'Late Registered').amount, 700);
});

test('pending applications are not treated as verified riders and cannot receive mapped payments before approval', () => {
  const {db, svc} = freshRegistryService([{id: 'WL010', name: 'Awaiting Approval', status: 'PENDING'}]);
  const imported = svc.importRecords({fileName: 'pending.xlsx', fileHash: 'pending', records: [
    sheetRow('WL010', 'Awaiting Approval', W('2026-08-24', '2026-08-30'), 900),
  ]}, 'admin');
  assert.equal(imported.provisionalSaved, 1);
  assert.equal(svc.list().records[0].verificationStatus, 'PENDING_VERIFICATION');
  assert.equal(svc.listPending().registeredCount, 0);
  assert.throws(() => svc.mapPending(svc.listPending().pending[0].id, 'WL010', 'admin'), /APPROVED status/);
  db.prepare("UPDATE rider_registrations SET application_status='APPROVED' WHERE rider_id='WL010'").run();
  assert.equal(svc.listPending().registeredCount, 1);
  const mapped = svc.mapPending(svc.listPending().pending[0].id, 'WL010', 'admin');
  assert.equal(mapped.importedFromPending, 1);
  assert.equal(svc.list().records[0].verificationStatus, 'VERIFIED');
});

test('Admin maps a pending row to a registered rider; the row is imported and cannot be mapped twice', () => {
  const {svc} = freshRegistryService([{id: 'WL005', name: 'Peram Krishna Rao'}]);
  svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: [sheetRow('WL999', 'Peram Krishna', W('2026-08-24', '2026-08-30'), 555)]}, 'admin');
  const id = svc.listPending().pending[0].id;
  assert.throws(() => svc.mapPending(id, 'WL404', 'admin'), /Choose a rider that is in Rider Registration/);
  const out = svc.mapPending(id, 'WL005', 'admin');
  assert.equal(out.importedFromPending, 1);
  assert.equal(svc.listPending().pending.length, 0);
  const saved = svc.list().records;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].riderId, 'WL005');
  assert.equal(saved[0].amount, 555);
  assert.throws(() => svc.mapPending(id, 'WL005', 'admin'), /not found or has already been imported/);
});

test('one Map action resolves every weekly row for the same Excel rider and the mapping persists on re-import', () => {
  const {svc} = freshRegistryService([{id: 'WL005', name: 'Peram Krishna Rao'}]);
  const rows = [
    sheetRow('WL999', 'Peram Krishna', W('2026-08-24', '2026-08-30'), 555),
    sheetRow('WL999', 'Peram Krishna', W('2026-08-31', '2026-09-06'), 650),
  ];
  svc.importRecords({fileName: 'a.xlsx', fileHash: 'a', records: rows}, 'admin');
  assert.equal(svc.list().records.length, 2);
  assert.equal(svc.listPending().pending.length, 2);
  const id = svc.listPending().pending[0].id;
  const out = svc.mapPending(id, 'WL005', 'admin');
  assert.equal(out.importedFromPending, 2);
  assert.equal(svc.listPending().pending.length, 0);
  assert.equal(svc.list().records.length, 2);
  assert.deepEqual(svc.list().records.map(r => r.riderId), ['WL005', 'WL005']);
  const again = svc.importRecords({fileName: 'reimport.xlsx', fileHash: 'reimport', records: rows}, 'admin');
  assert.equal(again.inserted, 0);
  assert.equal(again.unchanged, 2);
  assert.equal(svc.list().records.length, 2);
});

test('re-importing the same file or a corrected file never duplicates a rider-week; an older wrong-ID row is kept and reported', () => {
  const {db, svc} = freshRegistryService([{id: 'WL001', name: 'Appari Ravi Kumar'}]);
  // an older import saved this week under a wrong ID (before verification existed)
  createWeeklyPaymentService({db}).importRecords({fileName: 'old.xlsx', fileHash: 'old', records: [sheetRow('WLoo82', 'Appari Ravi Kumar', W('2026-08-24', '2026-08-30'))]}, 'admin');
  const recs = [sheetRow('WL001', 'Appari Ravi Kumar', W('2026-08-24', '2026-08-30'), 2141)];
  const first = svc.importRecords({fileName: 'new.xlsx', fileHash: 'new', records: recs}, 'admin');
  assert.equal(first.conflicts.length, 1);
  assert.equal(first.conflicts[0].riderId, 'WLoo82');
  assert.equal(svc.list().records.length, 2, 'historical row kept, new verified row added');
  svc.importRecords({fileName: 'new.xlsx', fileHash: 'new', records: recs}, 'admin');
  const corrected = svc.importRecords({fileName: 'new2.xlsx', fileHash: 'new2', records: [sheetRow('WL001', 'Appari Ravi Kumar', W('2026-08-24', '2026-08-30'), 2500)]}, 'admin');
  assert.equal(corrected.updated, 1);
  const verified = svc.list().records.filter(r => r.riderId === 'WL001');
  assert.equal(verified.length, 1);
  assert.equal(verified[0].amount, 2500);
});

// ---------- Excel order: oldest period first, and rows of a period in sheet order (top to bottom) ----------
const sheetRowAt = (id, name, week, rowNumber, sheet = 'Payments') => ({...sheetRow(id, name, week), rowNumber, sheet});

test('rows of the same week follow the Excel sheet order, not the rider name, whatever order they were imported in', () => {
  const {svc} = freshRegistryService([
    {id: 'WL001', name: 'Aaron Rider'}, {id: 'WL002', name: 'Zed Rider'}, {id: 'WL003', name: 'Mid Rider'},
  ]);
  const w = W('2026-08-24', '2026-08-30');
  svc.importRecords({fileName: 's.xlsx', fileHash: 's', records: [
    sheetRowAt('WL001', 'Aaron Rider', w, 7), // bottom of the sheet
    sheetRowAt('WL002', 'Zed Rider', w, 3),   // top of the sheet
    sheetRowAt('WL003', 'Mid Rider', w, 5),
  ]}, 'admin');
  assert.deepEqual(svc.list().records.map(r => r.rider), ['Zed Rider', 'Mid Rider', 'Aaron Rider']);
});

test('weekly and 15-day periods are listed oldest first, one after another', () => {
  const {svc} = freshRegistryService([{id: 'WL001', name: 'Appari Ravi Kumar'}]);
  svc.importRecords({fileName: 'm.xlsx', fileHash: 'm', records: [
    {...sheetRowAt('WL001', 'Appari Ravi Kumar', W('2026-09-16', '2026-09-30'), 2), weekKey: 'f:2026-09-16'},
    sheetRowAt('WL001', 'Appari Ravi Kumar', W('2026-08-01', '2026-08-07'), 1),
    sheetRowAt('WL001', 'Appari Ravi Kumar', W('2026-08-08', '2026-08-14'), 2),
    sheetRowAt('WL001', 'Appari Ravi Kumar', W('2026-08-15', '2026-08-21'), 3),
  ]}, 'admin');
  assert.deepEqual(svc.list().records.map(r => r.weekStart), ['2026-08-01', '2026-08-08', '2026-08-15', '2026-09-16']);
});

test('search and filtering keep the same order as the full list', () => {
  const {svc} = freshRegistryService([{id: 'WL001', name: 'Aaron Rider'}, {id: 'WL002', name: 'Zed Rider'}]);
  svc.importRecords({fileName: 'o.xlsx', fileHash: 'o', records: [
    sheetRowAt('WL002', 'Zed Rider', W('2026-08-24', '2026-08-30'), 3),
    sheetRowAt('WL001', 'Aaron Rider', W('2026-08-24', '2026-08-30'), 4),
    sheetRowAt('WL002', 'Zed Rider', W('2026-08-31', '2026-09-06'), 3),
  ]}, 'admin');
  const all = svc.list().records.map(r => `${r.weekStart}|${r.rider}`);
  const zed = svc.list({q: 'zed'}).records.map(r => `${r.weekStart}|${r.rider}`);
  assert.deepEqual(zed, all.filter(x => x.endsWith('|Zed Rider')));
});

test('pending rows are listed in Excel order as well', () => {
  const {svc} = freshRegistryService([]);
  svc.importRecords({fileName: 'p.xlsx', fileHash: 'p', records: [
    sheetRowAt('WL9', 'Second In Sheet', W('2026-08-24', '2026-08-30'), 9),
    sheetRowAt('WL8', 'First In Sheet', W('2026-08-24', '2026-08-30'), 4),
  ]}, 'admin');
  assert.deepEqual(svc.listPending().pending.map(p => p.rider), ['First In Sheet', 'Second In Sheet']);
});

test('the Excel reader keeps the sheet order: rows of each week come out top to bottom', () => {
  for (const name of ['weekly-19oct-25oct', 'weekly-26oct-01nov']) {
    const res = parse(name);
    assert.equal(res.ok, true);
    const rows = res.records.map(r => r.rowNumber);
    assert.deepEqual(rows, [...rows].sort((a, b) => a - b), `${name}: rows are not read top to bottom`);
  }
});
