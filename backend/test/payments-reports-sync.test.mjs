// Payments <-> Reports: payment status, previous/current week blocks, and the rule that an Excel re-import never
// changes the status an Admin has set. Run from the backend folder:
//   node --test --no-warnings test/payments-reports-sync.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createWeeklyPaymentService} from '../weekly-payments.js';
import {buildReport, buildSnapshot, recordsFromWeeklyRows, weekOf, normalizeStatus, PAYMENT_STATUSES} from '../report-stats.js';

const TODAY = '2026-11-11'; // a Wednesday: current week is Mon 09 Nov - Sun 15 Nov; previous is 02 - 08 Nov

const excelRow = (riderId, name, start, end, o = {}) => ({
  riderName: name, riderKey: 'id:' + riderId.toLowerCase(), riderId, weekKey: start + '|' + end,
  weekLabel: `${start} - ${end}`, weekStart: start, weekEnd: end, days: 7,
  totalOrders: o.total ?? 10, lm: o.lm ?? 4, primary: o.prime ?? 6, club: 0, sdd: 0,
  amount: o.amount ?? 100,
});

function newDb() {
  const db = new DatabaseSync(':memory:');
  const service = createWeeklyPaymentService({db, riderRegistry: false});
  return {db, service};
}

// ---------- week windows ----------
test('current and previous weeks are the Monday-to-Sunday cycles around today', () => {
  assert.deepEqual(weekOf('2026-11-11'), {start: '2026-11-09', end: '2026-11-15'});
  assert.deepEqual(weekOf('2026-11-08'), {start: '2026-11-02', end: '2026-11-08'}); // a Sunday belongs to the week before
  assert.deepEqual(weekOf('2026-11-09'), {start: '2026-11-09', end: '2026-11-15'}); // a Monday starts the week
});

test('payment status values are fixed; anything unknown is PENDING', () => {
  assert.deepEqual(PAYMENT_STATUSES, ['PENDING', 'PROCESSING', 'PAID', 'FAILED']);
  assert.equal(normalizeStatus('paid'), 'PAID');
  assert.equal(normalizeStatus('  failed '), 'FAILED');
  assert.equal(normalizeStatus('refunded'), 'PENDING');
  assert.equal(normalizeStatus(undefined), 'PENDING');
});

// ---------- payment status in storage ----------
test('a new weekly row starts as PENDING and an Admin can change only its status', () => {
  const {db, service} = newDb();
  service.importRecords({fileName: 'w.xlsx', records: [excelRow('WL001', 'Ravi', '2026-11-02', '2026-11-08', {amount: 100})]}, 'admin@x');
  const [row] = service.list().records;
  assert.equal(row.paymentStatus, 'PENDING');

  const res = service.setPaymentStatus(row.id, 'paid', 'admin@x');
  assert.equal(res.paymentStatus, 'PAID');
  assert.equal(res.changed, true);
  const after = service.list().records[0];
  assert.equal(after.paymentStatus, 'PAID');
  assert.equal(after.amount, 100, 'the amount is not touched by a status change');
  assert.equal(after.riderId, 'WL001');
  db.close();
});

test('setting the same status again changes nothing; an unknown status and an unknown row are refused', () => {
  const {db, service} = newDb();
  service.importRecords({fileName: 'w.xlsx', records: [excelRow('WL001', 'Ravi', '2026-11-02', '2026-11-08')]}, 'a');
  const id = service.list().records[0].id;
  service.setPaymentStatus(id, 'PROCESSING', 'a');
  assert.equal(service.setPaymentStatus(id, 'PROCESSING', 'a').changed, false);
  assert.throws(() => service.setPaymentStatus(id, 'REFUNDED', 'a'), /Choose Pending, Processing, Paid or Failed/);
  assert.throws(() => service.setPaymentStatus(999999, 'PAID', 'a'), /not found/);
  db.close();
});

test('an Excel re-import keeps the status an Admin set, and updates the amount without creating a duplicate', () => {
  const {db, service} = newDb();
  service.importRecords({fileName: 'w.xlsx', records: [excelRow('WL001', 'Ravi', '2026-11-02', '2026-11-08', {amount: 100})]}, 'a');
  service.setPaymentStatus(service.list().records[0].id, 'PAID', 'a');

  // the same rider and week come back from a corrected sheet with a different amount
  const second = service.importRecords({fileName: 'w2.xlsx', records: [excelRow('WL001', 'Ravi', '2026-11-02', '2026-11-08', {amount: 150})]}, 'a');
  const rows = service.list().records;
  assert.equal(rows.length, 1, 'still one row for the rider and week');
  assert.equal(rows[0].paymentStatus, 'PAID', 'the status is not reset by the import');
  assert.equal(rows[0].amount, 150, 'the corrected amount is saved');
  assert.equal(second.updated, 1);
  db.close();
});

test('a status change on one week never changes another week of the same rider', () => {
  const {db, service} = newDb();
  service.importRecords({fileName: 'w.xlsx', records: [
    excelRow('WL001', 'Ravi', '2026-11-02', '2026-11-08'),
    excelRow('WL001', 'Ravi', '2026-11-09', '2026-11-15'),
  ]}, 'a');
  const [older, newer] = service.list().records;
  service.setPaymentStatus(older.id, 'FAILED', 'a');
  const after = service.list().records;
  assert.equal(after.find(r => r.id === older.id).paymentStatus, 'FAILED');
  assert.equal(after.find(r => r.id === newer.id).paymentStatus, 'PENDING');
  db.close();
});

// ---------- reports: totals by status ----------
test('Reports totals split paid, pending, processing and failed amounts and add up to the total', () => {
  const {db, service} = newDb();
  service.importRecords({fileName: 'w.xlsx', records: [
    excelRow('WL001', 'Ravi', '2026-11-02', '2026-11-08', {amount: 100}),
    excelRow('WL002', 'Sita', '2026-11-02', '2026-11-08', {amount: 200}),
    excelRow('WL003', 'Hari', '2026-11-02', '2026-11-08', {amount: 0.1}),
    excelRow('WL004', 'Lata', '2026-11-02', '2026-11-08', {amount: 0.2}),
  ]}, 'a');
  const rows = service.list().records;
  service.setPaymentStatus(rows[0].id, 'PAID', 'a');
  service.setPaymentStatus(rows[1].id, 'PROCESSING', 'a');
  service.setPaymentStatus(rows[2].id, 'FAILED', 'a');
  // rows[3] stays PENDING

  const collected = recordsFromWeeklyRows(db.prepare('SELECT * FROM weekly_payments').all());
  const report = buildReport({mode: '15', year: '2026'}, collected, TODAY);
  const s = report.summary;
  assert.equal(s.paidAmount, 100);
  assert.equal(s.processingAmount, 200);
  assert.equal(s.failedAmount, 0.1);
  assert.equal(s.pendingAmount, 0.2);
  assert.equal(s.amounts.total, 300.3, 'exact paise sum, no floating-point drift');
  assert.equal(s.paidAmount + s.processingAmount + s.failedAmount + s.pendingAmount, s.amounts.total);
  assert.equal(s.paymentStatus.PAID.count, 1);
  assert.equal(report.rows.find(r => r.riderId === 'WL001').status, 'PAID');
  assert.ok(report.rows.every(r => Number.isInteger(r.rowId)), 'each row carries its saved row id for status changes');
  db.close();
});

// ---------- snapshot blocks ----------
const rec = (riderId, start, end, o = {}) => ({
  rider_id: riderId, rider_name: 'R' + riderId, week_label: `${start} - ${end}`, week_start: start, week_end: end,
  days: 7, total_orders: o.total ?? 10, lm: 4, primary_orders: 6, club: 0, sdd: 0, amount: o.amount ?? 100,
  payment_status: o.status ?? 'PENDING', id: o.id ?? Math.floor(Math.random() * 1e9),
});

test('snapshot: current week, previous week, month and 365-day figures come from the right records', () => {
  const rows = [
    rec('WL001', '2026-11-02', '2026-11-08', {amount: 100, total: 10, status: 'PAID'}), // previous week
    rec('WL002', '2026-11-09', '2026-11-15', {amount: 300, total: 20, status: 'PENDING'}), // current week
    rec('WL003', '2026-11-09', '2026-11-15', {amount: 50, total: 5, status: 'FAILED'}), // current week
    rec('WL004', '2026-11-01', '2026-11-15', {amount: 999, total: 99}), // a 15-day record: never in a 7-day week
    rec('WL005', '2025-12-01', '2025-12-07', {amount: 70, total: 7, status: 'PAID'}), // older than 365 days? (inside: 11 Nov 2025 - 11 Nov 2026)
  ];
  const collected = recordsFromWeeklyRows(rows);
  const snap = buildSnapshot(collected, TODAY);

  assert.equal(snap.currentWeek.start, '2026-11-09');
  assert.equal(snap.currentWeek.riders, 2);
  assert.equal(snap.currentWeek.total, 25);
  assert.equal(snap.currentWeek.amounts.total, 350);

  assert.equal(snap.previousWeek.start, '2026-11-02');
  assert.equal(snap.previousWeek.riders, 1);
  assert.equal(snap.previousWeek.total, 10);
  assert.equal(snap.previousWeek.paidAmount, 100);

  assert.equal(snap.comparison.ordersChange, 15);
  assert.equal(snap.comparison.amountChange, 250);
  assert.equal(snap.comparison.amountChangePct, 250);

  // the 15-day record (1-15 Nov) is in the monthly block, but not in either week
  assert.equal(snap.monthly.label, 'Nov 2026');
  assert.equal(snap.monthly.start, '2026-11-01');
  assert.equal(snap.monthly.riders, 4);
  assert.equal(snap.monthly.amounts.total, 1449);

  // the last 365 days run from 12 Nov 2025 to 11 Nov 2026, so the 1 Dec 2025 record is inside
  assert.equal(snap.yearly.start, '2025-11-12');
  assert.equal(snap.yearly.riders, 5);
  assert.equal(snap.allTime.riders, 5);
});

test('snapshot: a week with no saved records reports zero and hasData false, not an error', () => {
  const snap = buildSnapshot(recordsFromWeeklyRows([rec('WL001', '2026-11-02', '2026-11-08')]), '2026-12-20');
  assert.equal(snap.currentWeek.hasData, false);
  assert.equal(snap.currentWeek.riders, 0);
  assert.equal(snap.comparison.amountChangePct, null, 'no percentage when the previous week was zero');
});

test('buildReport includes the snapshot and leaves the filtered summary unchanged', () => {
  const collected = recordsFromWeeklyRows([rec('WL001', '2026-11-02', '2026-11-08', {amount: 100})]);
  const filtered = buildReport({mode: '15', year: '2026', search: 'WL001'}, collected, TODAY);
  assert.ok(filtered.snapshot.previousWeek.hasData);
  assert.equal(filtered.summary.amounts.total, 100);
  const other = buildReport({mode: '15', year: '2026', search: 'NOPE'}, collected, TODAY);
  assert.equal(other.summary.amounts.total, 0, 'filters narrow the summary');
  assert.equal(other.snapshot.previousWeek.amounts.total, 100, 'the fixed snapshot is not narrowed by filters');
});
