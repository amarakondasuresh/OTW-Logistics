// Run with:  node --test --no-warnings test/rider-performance.test.mjs   (from the backend folder)
// Tests the Rider Performance Dashboard calculations (../../dashboard/rider-performance-core.js) on the same Excel grids
// the payment tests use (test/fixtures/grids.json, exactly as the browser's Excel reader hands them over).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const RP = require('../../dashboard/rider-performance-core.js');
const grids = JSON.parse(fs.readFileSync(new URL('./fixtures/grids.json', import.meta.url), 'utf8'));
const load = name => RP.parseWorkbook(grids[name].map(s => ({name: s.name, rows: s.grid})));

// Excel day number for a UTC date (what the Excel reader gives for a date cell)
const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;

test('weekly sheet (19-25 Oct): every rider counted, total line skipped, amounts as written', () => {
  const res = load('weekly-19oct-25oct');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.granularity, 'week');
  assert.ok(res.skipped.some(s => /total line/.test(s.reason)), 'TOTAL line must not be a rider');
  const t = RP.summarize(RP.filterRecords(res.records, {mode: 'all'}));
  assert.equal(t.riders, 5);
  assert.equal(t.large, 214 + 180 + 301 + 0 + 96);
  assert.equal(t.prime, 150 + 120 + 200 + 0 + 60);
  assert.equal(t.club, 64 + 60 + 101 + 0 + 36);
  assert.equal(t.amount, 20666.25, 'must match the sheet TOTAL line');
  assert.equal(t.fm, 0);
  assert.ok(res.warnings.some(w => /No FM Orders/.test(w)));
});

test('weekly sheet (26 Oct - 1 Nov): merged week cells use the date above, amounts with ₹ and commas', () => {
  const res = load('weekly-26oct-01nov');
  assert.equal(res.ok, true, res.error);
  const rows = RP.riderRows(res.records);
  assert.equal(rows.length, 4);
  const appari = rows.find(r => r.riderId === 'OTW-101');
  assert.equal(appari.amount, 5210.25);
  assert.equal(appari.large, 260);
  assert.equal(appari.sdd, 4);
  assert.equal(RP.weekLabel(res.records[0].weekKey), '26 Oct 2026 – 01 Nov 2026');
  assert.ok(RP.summarize(res.records).amount === 24320.24);
  assert.ok(res.warnings.some(w => /empty date/.test(w)));
});

test('daily sheet: riders grouped by Rider ID across days, combined totals, week and date filters', () => {
  const res = load('daily-settlement-two-weeks');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.granularity, 'day');

  const overall = RP.summarize(res.records);
  assert.equal(overall.riders, 3, 'three riders, each counted once');
  const r101 = RP.riderRows(res.records).find(r => r.riderId === 'OTW-101');
  assert.equal(r101.large, 178);
  assert.equal(r101.prime, 148);
  assert.equal(r101.club, 30);
  assert.equal(r101.amount, 3105.5);
  assert.equal(r101.totalOrders, 178 + 148 + 30);

  // week of 19 Oct 2026 (Mon) holds 22-25 Oct; 101 has LM 24+23+15+22 = 84 and 1497.75
  const week1 = RP.filterRecords(res.records, {mode: 'week', value: '2026-10-19'});
  const w1 = RP.riderRows(week1).find(r => r.riderId === 'OTW-101');
  assert.equal(w1.large, 84);
  assert.equal(w1.amount, 1497.75);
  assert.equal(RP.summarize(week1).riders, 3);

  // one single date
  const day = RP.filterRecords(res.records, {mode: 'date', value: '2026-10-22'});
  assert.equal(day.length, 3, 'three riders have a row for 22 Oct in this sheet');
  assert.equal(RP.summarize(day).riders, 3);

  const periods = RP.listPeriods(res.records);
  assert.deepEqual(periods.weeks.map(w => w.key), ['2026-10-26', '2026-10-19']);
});

test('weekly and overall report: a rider in two weeks is counted once overall but once per week', () => {
  const res = load('daily-settlement-two-weeks');
  const report = RP.weeklyReport(res.records);
  assert.equal(report.length, 2);
  assert.equal(report[0].weekKey, '2026-10-26');
  const overall = RP.summarize(res.records);
  assert.equal(overall.riders, 3);
  const sumWeekly = report.reduce((s, w) => s + w.amount, 0);
  assert.ok(Math.abs(sumWeekly - overall.amount) < 0.001, 'weekly amounts add up to the overall amount');
});

test('same rider twice on the same date is counted once', () => {
  const rows = [
    ['Rider ID', 'Rider Name', 'Order Date', 'Large Orders', 'Prime Orders', 'Total Amount'],
    ['OTW-9', 'Test Rider', serial(2026, 10, 5), 10, 5, 300],
    ['OTW-9', 'Test Rider', serial(2026, 10, 5), 10, 5, 300],
    ['OTW-9', 'Test Rider', serial(2026, 10, 6), 4, 2, 120],
  ];
  const res = RP.parseWorkbook([{name: 'Daily', rows}]);
  assert.equal(res.ok, true);
  assert.equal(res.records.length, 2);
  assert.ok(res.skipped.some(s => s.duplicate));
  const r = RP.riderRows(res.records)[0];
  assert.equal(r.large, 14);
  assert.equal(r.amount, 420);
  assert.equal(RP.summarize(res.records).riders, 1);
});

test('row without Rider ID is matched to the ID of the same-named rider; otherwise kept separate', () => {
  const rows = [
    ['Rider ID', 'Rider Name', 'Order Date', 'Large Orders', 'Total Amount'],
    ['OTW-7', 'Sara Khan', serial(2026, 11, 2), 3, 90],
    ['', 'Sara Khan', serial(2026, 11, 3), 2, 60],
    ['', 'Unknown Person', serial(2026, 11, 3), 1, 30],
  ];
  const res = RP.parseWorkbook([{name: 'Daily', rows}]);
  assert.equal(RP.summarize(res.records).riders, 2);
  const sara = RP.riderRows(res.records).find(r => r.riderId === 'OTW-7');
  assert.equal(sara.large, 5);
  assert.equal(sara.amount, 150);
});

test('missing order columns are counted as 0 with a note; missing rider table is refused', () => {
  const rows = [['Rider ID', 'Rider Name', 'Date', 'Total Weekly Orders', 'Total Amount'],
    ['OTW-1', 'A', serial(2026, 10, 5), 50, 500]];
  const res = RP.parseWorkbook([{name: 'S', rows}]);
  assert.equal(res.ok, true);
  assert.equal(res.records[0].totalOrders, 50, 'sheet total column is used as written');
  assert.equal(res.records[0].fm, 0);
  assert.ok(res.warnings.some(w => /FM Orders/.test(w)));

  const bad = RP.parseWorkbook([{name: 'Notes', rows: [['Hello', 'World'], [1, 2]]}]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Rider ID or Rider Name/);

  // a sheet with only names and amounts (no order columns) is not treated as a rider table
  assert.equal(load('wide-summary').ok, false);
});

test('a second sheet with rider data is listed as ignored, not added to the totals', () => {
  const sheetA = {name: 'Weekly', rows: grids['weekly-19oct-25oct'][0].grid};
  const sheetB = {name: 'Daily', rows: grids['daily-settlement-two-weeks'][0].grid};
  const res = RP.parseWorkbook([sheetA, sheetB]);
  assert.equal(res.sheetName, 'Weekly');
  assert.equal(res.ignoredSheets[0].name, 'Daily');
  assert.equal(RP.summarize(res.records).riders, 5);
});

test('search matches Rider ID and name without changing the combined totals', () => {
  const res = load('weekly-26oct-01nov');
  const rows = RP.riderRows(res.records);
  assert.equal(RP.searchRows(rows, 'otw-103').length, 1);
  assert.equal(RP.searchRows(rows, 'nagababu').length, 1);
  assert.equal(RP.searchRows(rows, '').length, 4);
  assert.equal(RP.summarize(res.records).riders, 4);
});
