// Reports read the saved weekly payment rows (weekly_payments), the same rows the Payments page shows.
// The integration tests import the real fixture through the same code the admin uses, then build the report.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createWeeklyPaymentService} from '../weekly-payments.js';
import {validDay, recordsFromWeeklyRows, hubMapOf, buildReport, orderIdOf, ReportError} from '../report-stats.js';

const require = createRequire(import.meta.url);
const PX = require('../../dashboard/payment-excel.js');
const fixture = name => JSON.parse(fs.readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
const grids = fixture('grids.json');
const TODAY = '2026-11-01';

// one saved weekly row, as weekly_payments stores it (snake_case)
const row = (riderId, name, start, end, o = {}) => ({
  rider_id: riderId, rider_name: name, week_label: `${start} - ${end}`, week_start: start, week_end: end,
  days: o.days ?? 7, total_orders: o.total ?? null, lm: o.lm ?? 0, primary_orders: o.prime ?? 0, club: o.club ?? 0, sdd: o.sdd ?? 0,
  lm_amount: o.lmAmount ?? null, prime_amount: o.primeAmount ?? null, club_amount: o.clubAmount ?? null, sdd_amount: o.sddAmount ?? null,
  amount: o.amount ?? 0,
});
const HUBS = new Map([['WL001', 'Palakollu'], ['WL002', 'Nidadavole']]);
const build = (rows, q = {}, hubs = HUBS) => buildReport(q, recordsFromWeeklyRows(rows, hubs), TODAY);

// ---------- validation and ids ----------
test('validDay accepts real dates and rejects impossible ones', () => {
  assert.equal(validDay('2026-10-15'), '2026-10-15');
  assert.equal(validDay('2028-02-29'), '2028-02-29');
  assert.equal(validDay('2026-02-29'), '');
  assert.equal(validDay('15/10/2026'), '');
});

test('order ID is a stable generated reference from rider and week start', () => {
  assert.equal(orderIdOf('wl001', '2026-10-19'), 'ORD-WL001-20261019');
  assert.equal(orderIdOf('WL001', '2026-10-19'), orderIdOf('WL001', '2026-10-19'));
});

// ---------- records ----------
test('invalid rows are skipped and counted; a missing Total Orders is LM + Prime + Club', () => {
  const c = recordsFromWeeklyRows([
    row('WL001', 'A', '2026-10-19', '2026-10-25', {lm: 10, prime: 6, club: 4}),
    row('', 'No ID', '2026-10-19', '2026-10-25', {lm: 1}),
    row('WL002', 'Bad week', 'Week 43', '', {lm: 1}),
  ], HUBS);
  assert.equal(c.records.length, 1);
  assert.equal(c.skipped, 2);
  assert.equal(c.records[0].total, 20);
  assert.equal(c.records[0].hub, 'Palakollu');
});

test('each rider-week is counted once: a repeated Rider ID + week keeps the fuller record', () => {
  const c = recordsFromWeeklyRows([
    row('WL001', 'A', '2026-10-19', '2026-10-25', {total: 50, lm: 50}),
    row('WL001', 'A', '2026-10-19', '2026-10-25', {total: 80, lm: 80}),
  ], HUBS);
  assert.equal(c.records.length, 1);
  assert.equal(c.duplicates, 1);
  assert.equal(c.records[0].total, 80);
});

// ---------- periods ----------
test('15-day report: weekly records fall into the 1-15 or 16-end period of their week start, counted once', () => {
  const rows = [
    row('WL001', 'A', '2026-10-12', '2026-10-18', {total: 10, lm: 10}), // starts 12 Oct -> 1-15 Oct
    row('WL002', 'B', '2026-10-19', '2026-10-25', {total: 20, lm: 20}), // starts 19 Oct -> 16-31 Oct
  ];
  const r = build(rows, {mode: '15', start: '2026-10-01', end: '2026-10-31'});
  assert.equal(r.periods.length, 2);
  assert.deepEqual(r.periods.map(p => p.total), [10, 20]);
  assert.equal(r.summary.total, 30);
  assert.equal(r.summary.riders, 2);
  assert.equal(r.rows.length, 2);
});

test('365 report: one bucket per month, and totals equal the sum of the rows', () => {
  const rows = [
    row('WL001', 'A', '2026-01-05', '2026-01-11', {total: 5, lm: 5, amount: 100}),
    row('WL001', 'A', '2026-03-02', '2026-03-08', {total: 7, lm: 7, amount: 200}),
  ];
  const r = build(rows, {mode: '365', year: '2026'});
  assert.equal(r.months.length, 12);
  assert.equal(r.months[0].total, 5);
  assert.equal(r.months[2].total, 7);
  assert.equal(r.summary.total, 12);
  assert.equal(r.summary.amounts.total, 300);
});

// ---------- money ----------
test('Total Amount is the saved Excel amount, summed exactly; a missing category amount is null, not 0', () => {
  const rows = [row('WL001', 'A', '2026-10-19', '2026-10-25', {total: 5, lm: 5, amount: 5970, lmAmount: 50})];
  const r = build(rows);
  assert.equal(r.rows[0].amount, 5970);
  assert.equal(r.summary.amounts.total, 5970);
  assert.equal(r.summary.amounts.prime, null);
});

// ---------- filters ----------
test('rider and hub filters narrow every figure together', () => {
  const rows = [
    row('WL001', 'Appari Ravi Kumar', '2026-10-19', '2026-10-25', {total: 10, lm: 10}),
    row('WL002', 'Shaik Ahmad Sharief', '2026-10-19', '2026-10-25', {total: 30, lm: 30}),
  ];
  assert.equal(build(rows, {search: 'ravi'}).summary.total, 10);
  assert.equal(build(rows, {hub: 'nidadavole'}).summary.total, 30);
  assert.equal(build(rows, {hub: 'nidadavole'}).rows.length, 1);
});

test('invalid query values produce clear 400 errors', () => {
  assert.throws(() => build([], {start: '2026-02-30'}), ReportError);
  assert.throws(() => build([], {start: '2026-10-10', end: '2026-10-01'}), /cannot be after/);
  assert.throws(() => build([], {month: '13'}), /valid month/);
});

test('hub map comes from partner rider lists', () => {
  const m = hubMapOf([{riders: [{id: 'wl001', hubLocation: 'Palakollu'}, {id: 'WL003'}]}]);
  assert.equal(m.get('WL001'), 'Palakollu');
  assert.equal(m.has('WL003'), false);
});

// ---------- integration: Payments and Reports read the same saved rows ----------
test('INTEGRATION: an Excel import into Payments is what Reports shows, with no second upload', () => {
  const db = new DatabaseSync(':memory:');
  const svc = createWeeklyPaymentService({db});
  const parsed = PX.parseSheets(grids['weekly-19oct-25oct'] ? grids['weekly-19oct-25oct'] : []);
  assert.equal(parsed.ok, true, parsed.error);
  svc.importRecords({fileName: 'oct.xlsx', fileHash: 'oct', records: parsed.records}, 'admin@test');

  const savedRows = db.prepare('SELECT * FROM weekly_payments').all();
  const report = buildReport({}, recordsFromWeeklyRows(savedRows, HUBS), TODAY);
  const payments = svc.list().records;

  // same number of rider-week records, the same Total Amount and the same Total Orders
  assert.equal(report.rows.length, payments.length);
  const sumExcel = payments.reduce((t, p) => t + (p.amount || 0), 0);
  assert.equal(Math.round(report.summary.amounts.total * 100) / 100, Math.round(sumExcel * 100) / 100);
  const ravi = report.rows.find(r => r.riderName === 'Appari Ravi Kumar');
  assert.equal(ravi.amount, 4520.5);
  assert.equal(ravi.start, '2026-10-19');
  assert.equal(ravi.orderId, 'ORD-OTW-101-20261019');

  // a corrected import updates the report; a repeated import does not double it
  const fixed = parsed.records.map(r => (r.riderId === 'OTW-101' ? {...r, amount: 9999} : r));
  svc.importRecords({fileName: 'oct-fixed.xlsx', fileHash: 'oct-fixed', records: fixed}, 'admin@test');
  svc.importRecords({fileName: 'oct-fixed.xlsx', fileHash: 'oct-fixed', records: fixed}, 'admin@test');
  const after = buildReport({}, recordsFromWeeklyRows(db.prepare('SELECT * FROM weekly_payments').all(), HUBS), TODAY);
  assert.equal(after.rows.length, payments.length);
  assert.equal(after.rows.find(r => r.riderName === 'Appari Ravi Kumar').amount, 9999);
});
