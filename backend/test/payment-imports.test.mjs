// Run with:  node --test --no-warnings test/payment-imports.test.mjs   (from the backend folder)
// Uses Node's built-in SQLite and a minimal copy of the accounts and rider_registrations tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPaymentImportService, PaymentImportError, MATCH} from '../payment-imports.js';
import {buildCycles, cycleTotals, mondayOf} from '../payment-cycles.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE accounts(id TEXT PRIMARY KEY, role TEXT NOT NULL, login_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE rider_registrations(id TEXT PRIMARY KEY, application_id TEXT NOT NULL UNIQUE, rider_id TEXT NOT NULL, rider_key TEXT NOT NULL,
      rider_name TEXT NOT NULL, registration_source TEXT NOT NULL, owner_account_id TEXT, owner_login_id TEXT,
      application_status TEXT NOT NULL DEFAULT 'PENDING');
    INSERT INTO accounts(id,role,login_id,status) VALUES ('F1','franchise','FP-000001','active'), ('F2','franchise','FP-000002','active'),
      ('V1','vendor','VN-000001','active'), ('F3','franchise','FP-000003','suspended');`);
  const reg = db.prepare(`INSERT INTO rider_registrations(id,application_id,rider_id,rider_key,rider_name,registration_source,owner_account_id,owner_login_id,application_status)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  reg.run('r1', 'RM-1', 'OTW-101', 'OTW-101', 'Appari Ravi Kumar', 'Franchise', 'F1', 'FP-000001', 'PENDING');
  reg.run('r2', 'RM-2', 'OTW-201', 'OTW-201', 'Shaik Ahmad Sharief', 'Franchise', 'F2', 'FP-000002', 'APPROVED');
  reg.run('r3', 'RM-3', 'OTW-301', 'OTW-301', 'Vendor Rider One', 'Vendor', 'V1', 'VN-000001', 'PENDING');
  reg.run('r4', 'RM-4', 'OTW-401', 'OTW-401', 'Admin Rider', 'Admin', null, null, 'APPROVED');
  reg.run('r5', 'RM-5', 'OTW-501', 'OTW-501', 'Suspended Partner Rider', 'Franchise', 'F3', 'FP-000003', 'APPROVED');
  reg.run('r6', 'RM-6', 'OTW-601', 'OTW-601', 'Rejected Rider', 'Franchise', 'F1', 'FP-000001', 'REJECTED');
  let t = 0;
  const service = createPaymentImportService({db, now: () => new Date(Date.UTC(2026, 10, 4, 0, 0, t++)).toISOString()});
  return {db, service};
}
const row = (over = {}) => ({name: 'Appari Ravi Kumar', riderId: 'OTW-101', date: '2026-10-26', lm: 24, primary: 20, club: 4, amount: 419, ...over});
const file = (records, fileName = 'day.xlsx', fileHash = '') => ({fileName, fileHash, records});

test('a rider whose ID and name match a franchise registration is matched to that franchise', () => {
  const {service} = setup();
  const out = service.importRows(file([row()]));
  const rows = service.rowsOf({ownerAccountId: 'F1'}).rows;
  assert.equal(out.version.matched, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].riderId, 'OTW-101');
  assert.equal(rows[0].ownerLoginId, 'FP-000001');
});

test('matching ignores case, spaces and punctuation in names and IDs', () => {
  const {service} = setup();
  service.importRows(file([row({name: 'appari  ravi-kumar', riderId: ' otw-101 '})]));
  assert.equal(service.rowsOf({ownerAccountId: 'F1'}).rows.length, 1);
});

test('Rider ID matches but the name differs: flagged for review and not shared', () => {
  const {service} = setup();
  const out = service.importRows(file([row({name: 'Someone Else'})]));
  assert.equal(out.version.review, 1);
  assert.equal(service.rowsOf({ownerAccountId: 'F1'}).rows.length, 0);
  assert.equal(service.rowsOf({status: MATCH.REVIEW}).rows[0].status, MATCH.REVIEW);
});

test('name matches but the Rider ID does not: not assigned to anyone', () => {
  const {service} = setup();
  const out = service.importRows(file([row({riderId: 'OTW-999'})]));
  assert.equal(out.version.unmatched, 1);
  const unmatched = service.rowsOf({status: MATCH.UNMATCHED}).rows;
  assert.match(unmatched[0].note, /name matches/);
  assert.equal(service.rowsOf({ownerAccountId: 'F1'}).rows.length, 0);
});

test('unknown rider ID is unmatched', () => {
  const {service} = setup();
  const out = service.importRows(file([row({name: 'Nobody', riderId: 'OTW-777'})]));
  assert.equal(out.version.unmatched, 1);
  assert.equal(service.rowsOf({status: MATCH.UNMATCHED}).rows[0].note, 'No registered rider has this Rider ID.');
});

test('riders registered by the admin, rejected riders and riders of a suspended franchise are never shared', () => {
  const {service} = setup();
  const out = service.importRows(file([
    row({name: 'Admin Rider', riderId: 'OTW-401'}),
    row({name: 'Rejected Rider', riderId: 'OTW-601'}),
    row({name: 'Suspended Partner Rider', riderId: 'OTW-501'}),
  ]));
  assert.equal(out.version.noPartner, 3);
  for (const owner of ['F1', 'F2', 'F3', 'V1']) assert.equal(service.rowsOf({ownerAccountId: owner}).rows.length, 0, owner);
});

test('a vendor-registered rider is shared with that vendor only', () => {
  const {service} = setup();
  service.importRows(file([row({name: 'Vendor Rider One', riderId: 'OTW-301'})]));
  assert.equal(service.rowsOf({ownerAccountId: 'V1'}).rows.length, 1);
  assert.equal(service.rowsOf({ownerAccountId: 'F1'}).rows.length, 0);
});

test('franchise F1 never sees the riders of franchise F2', () => {
  const {service} = setup();
  service.importRows(file([row(), row({name: 'Shaik Ahmad Sharief', riderId: 'OTW-201', date: '2026-10-26'})]));
  const f1 = service.rowsOf({ownerAccountId: 'F1'}).rows.map(r => r.riderId);
  const f2 = service.rowsOf({ownerAccountId: 'F2'}).rows.map(r => r.riderId);
  assert.deepEqual(f1, ['OTW-101']);
  assert.deepEqual(f2, ['OTW-201']);
});

test('the same file is not imported twice', () => {
  const {service} = setup();
  const first = service.importRows(file([row()], 'a.xlsx', 'hash-1'));
  const again = service.importRows(file([row()], 'a.xlsx', 'hash-1'));
  assert.equal(first.alreadyImported, false);
  assert.equal(again.alreadyImported, true);
  assert.equal(service.listVersions().versions.length, 1);
  assert.equal(service.rowsOf().rows.length, 1);
});

test('a new file becomes the active version and the earlier file is kept', () => {
  const {service} = setup();
  const v1 = service.importRows(file([row()], 'oct-1.xlsx', 'h1'));
  const v2 = service.importRows(file([row({date: '2026-10-27', lm: 30, primary: 25, club: 5})], 'oct-2.xlsx', 'h2'));
  const list = service.listVersions();
  assert.equal(list.activeVersionId, v2.activeVersionId);
  assert.equal(list.versions.length, 2);
  assert.equal(list.versions.find(v => v.id === v1.activeVersionId).active, false);
  // active data = the latest file only
  assert.deepEqual(service.rowsOf().rows.map(r => r.date), ['2026-10-27']);
  // the earlier file is still available
  assert.deepEqual(service.rowsOf({versionId: v1.activeVersionId}).rows.map(r => r.date), ['2026-10-26']);
});

test('a file with no readable rows is rejected and the active data does not change', () => {
  const {service} = setup();
  const v1 = service.importRows(file([row()], 'ok.xlsx', 'h1'));
  assert.throws(() => service.importRows(file([{name: '', date: 'not a date'}], 'bad.xlsx', 'h2')),
    err => err instanceof PaymentImportError && err.status === 400);
  assert.equal(service.listVersions().activeVersionId, v1.activeVersionId);
  assert.equal(service.listVersions().versions.length, 1);
});

test('if partner data cannot be saved, the new version is rolled back', () => {
  const {service, db} = setup();
  const v1 = service.importRows(file([row()], 'ok.xlsx', 'h1'));
  assert.throws(() => service.importRows(file([row({date: '2026-10-28'})], 'next.xlsx', 'h2'), 'admin', () => {
    throw new Error('disk full');
  }), /disk full/);
  assert.equal(service.listVersions().activeVersionId, v1.activeVersionId);
  assert.equal(service.listVersions().versions.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_import_rows').get().n, 1);
});

test('the same rider and date inside one file is stored once (the last row wins)', () => {
  const {service} = setup();
  const out = service.importRows(file([row({lm: 10}), row({lm: 12})]));
  assert.equal(out.version.rows, 1);
  assert.equal(out.version.duplicates, 1);
  assert.equal(service.rowsOf().rows[0].lm, 12);
});

test('rows with an invalid date or a blank name are skipped and counted', () => {
  const {service} = setup();
  const out = service.importRows(file([row(), row({date: '26/10/2026'}), row({name: ''})]));
  assert.equal(out.version.rows, 1);
  assert.equal(out.version.skipped, 2);
});

test('project() receives only the matched rows', () => {
  const {service} = setup();
  let seen = null;
  service.importRows(file([row(), row({name: 'Someone Else', date: '2026-10-27'}), row({riderId: 'OTW-999', date: '2026-10-28'})]), 'admin', (id, matched) => { seen = matched; });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].riderId, 'OTW-101');
});

test('Monday-to-Sunday cycles: cycle 1 starts on the Monday of the first week and each cycle has seven days', () => {
  assert.equal(mondayOf('2026-10-26'), '2026-10-26'); // a Monday
  assert.equal(mondayOf('2026-11-01'), '2026-10-26'); // the Sunday of the same week
  const {cycles} = buildCycles([{date: '2026-10-28'}], {periodStart: '2026-10-28', periodDays: 365});
  assert.equal(cycles[0].weekStart, '2026-10-26');
  assert.equal(cycles[0].weekEnd, '2026-11-01');
  assert.equal(cycles[0].daysInPeriod, 5); // period starts on Wednesday
  assert.equal(cycles[1].weekStart, '2026-11-02');
  assert.equal(cycles[1].daysInPeriod, 7);
  assert.equal(cycles.length, 53); // 365 days starting mid-week
  const last = cycles[cycles.length - 1];
  assert.ok(last.daysInPeriod >= 1 && last.daysInPeriod <= 7);
});

test('a record is never counted in two cycles, and records outside the period are kept separately', () => {
  const rows = [{date: '2026-11-01'}, {date: '2026-11-02'}, {date: '2030-01-01'}];
  const out = buildCycles(rows, {periodStart: '2026-10-26', periodDays: 365});
  assert.equal(out.cycles[0].rows.length, 1);
  assert.equal(out.cycles[1].rows.length, 1);
  assert.equal(out.outside.length, 1);
});

test('cycle totals add up exactly, money in paise', () => {
  const rows = [
    {date: '2026-10-26', riderKey: 'A', lm: 24, primary: 20, club: 4, sdd: 0, sddAmount: 0, amount: 0.1},
    {date: '2026-10-27', riderKey: 'A', lm: 10, primary: 8, club: 2, sdd: 1, sddAmount: 0, amount: 0.2},
    {date: '2026-10-27', riderKey: 'B', lm: 5, primary: 3, club: 2, sdd: 0, sddAmount: 0, amount: 419},
  ];
  const {cycles} = buildCycles(rows, {periodStart: '2026-10-26', periodDays: 7});
  const t = cycleTotals(cycles[0]);
  assert.equal(t.totalRiders, 2);
  assert.equal(t.totalOrders, 39);
  assert.equal(t.totalPrime, 31);
  assert.equal(t.totalClub, 8);
  assert.equal(t.totalSsdOrders, 1);
  assert.equal(t.totalAmount, 419.3);
});
