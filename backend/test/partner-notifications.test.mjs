// Run with:  node --test --no-warnings test/partner-notifications.test.mjs   (from the backend folder)
// Regression tests for:
//  - partners are told when weekly payment rows for their riders are saved (import, re-check after approval);
//  - a weekly sheet with no Total Orders column stores Total Orders = LM (like the daily and date-column layouts);
//  - partner Reports and Admin Reports give the same total for rows saved without a Total Orders value.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createRiderRegistrationService} from '../rider-registrations.js';
import {createWeeklyPaymentService, partnerGroupsForImport, listForVendor} from '../weekly-payments.js';
import {buildPartnerReport} from '../partner-reports.js';
import {recordsFromWeeklyRows} from '../report-stats.js';

const require = createRequire(import.meta.url);
const PX = require('../../dashboard/payment-excel.js');

const ADMIN = {role: 'admin', accountId: 'acc-admin', identity: 'admin@onthewaylogistics.in'};
const VN_A = {role: 'vendor', accountId: 'acc-vn-a', identity: 'VN-000001', ownerName: 'Vendor A'};
const VN_OFF = {role: 'vendor', accountId: 'acc-vn-off', identity: 'VN-000002', ownerName: 'Vendor Off'};
const FR_B = {role: 'franchise', accountId: 'acc-fr-b', identity: 'FP-000001', ownerName: 'Franchise B'};
const jpeg = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 1)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 4)]);
const files = () => ({selfie: {buffer: jpeg(), originalname: 's.jpg'}, aadhaar: {buffer: pdf(), originalname: 'a.pdf'}});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otw-notify-'));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY, role TEXT, login_id TEXT, status TEXT);
    INSERT INTO accounts VALUES ('acc-vn-a','vendor','VN-000001','active'), ('acc-vn-off','vendor','VN-000002','disabled'),
      ('acc-fr-b','franchise','FP-000001','active');`);
  const saved = [];
  const regs = createRiderRegistrationService({db, uploadDir: dir});
  const wp = createWeeklyPaymentService({db, riderRegistry: true, onSaved: info => saved.push(info)});
  return {db, regs, wp, saved};
}
const register = (s, actor, riderId, riderName, approve = true) => {
  const r = s.regs.create(actor, {riderId, riderName, mobile: '9876543210', hubPincode: '522002', hubLocation: 'Guntur hub'}, files());
  if (approve) s.regs.setStatus(ADMIN, r.id, {status: 'APPROVED'});
  return r.id;
};
const W1 = {start: '2026-11-02', end: '2026-11-08'};
const row = (riderId, riderName, week, amount, extra = {}) => ({
  riderId, riderName, riderKey: 'id:' + riderId.toLowerCase(), weekKey: 'd:' + week.start,
  weekLabel: `${week.start} - ${week.end}`, weekStart: week.start, weekEnd: week.end,
  days: 7, totalOrders: 20, lm: 20, primary: 15, club: 5, sdd: 0, amount, amountRaw: String(amount),
  sheet: 'Payments', rowNumber: 2, original: {}, ...extra,
});

test('an import tells each partner how many of its riders received rows; inactive and unapproved owners get nothing', () => {
  const s = setup();
  register(s, VN_A, 'WL-A1', 'Ravi Kumar');
  register(s, VN_A, 'WL-A2', 'Sita Devi');
  register(s, FR_B, 'WL-B1', 'Mohan Rao');
  register(s, VN_OFF, 'WL-O1', 'Off Rider');
  register(s, VN_A, 'WL-A9', 'Not Approved', false);
  s.wp.importRecords({fileName: 'w1.xlsx', fileHash: 'h1', records: [
    row('WL-A1', 'Ravi Kumar', W1, 1000), row('WL-A2', 'Sita Devi', W1, 900),
    row('WL-B1', 'Mohan Rao', W1, 800), row('WL-O1', 'Off Rider', W1, 700), row('WL-A9', 'Not Approved', W1, 600),
  ]}, 'admin');
  assert.equal(s.saved.length, 1, 'onSaved runs once for the import');
  const groups = partnerGroupsForImport(s.db, s.saved[0].importId);
  assert.deepEqual(groups.map(g => [g.accountId, g.records, g.riders, g.orders]),
    [['acc-fr-b', 1, 1, 20], ['acc-vn-a', 2, 2, 40]]);
  assert.equal(groups[1].fromDay, '2026-11-02');
  assert.equal(groups[1].toDay, '2026-11-08');
  // the same rows the vendor's Orders page shows
  assert.equal(listForVendor(s.db, 'acc-vn-a').length, 2);
});

test('re-importing an identical file changes nothing and notifies nobody; a corrected file notifies again', () => {
  const s = setup();
  register(s, VN_A, 'WL-A1', 'Ravi Kumar');
  const records = [row('WL-A1', 'Ravi Kumar', W1, 1000)];
  s.wp.importRecords({fileName: 'w1.xlsx', fileHash: 'h1', records}, 'admin');
  s.wp.importRecords({fileName: 'w1.xlsx', fileHash: 'h1', records}, 'admin');
  assert.equal(s.saved.length, 1);
  s.wp.importRecords({fileName: 'w1-fixed.xlsx', fileHash: 'h2', records: [row('WL-A1', 'Ravi Kumar', W1, 1250)]}, 'admin');
  assert.equal(s.saved.length, 2);
  assert.equal(partnerGroupsForImport(s.db, s.saved[1].importId)[0].records, 1);
});

test('rows waiting for a rider approval notify the partner when the approval imports them', () => {
  const s = setup();
  const id = register(s, VN_A, 'WL-A1', 'Ravi Kumar', false);
  s.wp.importRecords({fileName: 'w1.xlsx', fileHash: 'h1', records: [row('WL-A1', 'Ravi Kumar', W1, 1000)]}, 'admin');
  const before = s.saved.length;
  s.regs.setStatus(ADMIN, id, {status: 'APPROVED'});
  s.wp.recheckPending('admin');
  assert.equal(s.saved.length, before + 1);
  const groups = partnerGroupsForImport(s.db, s.saved.at(-1).importId);
  assert.deepEqual(groups.map(g => [g.accountId, g.records]), [['acc-vn-a', 1]]);
});

test('a weekly sheet with no Total Orders column stores Total Orders = LM; a Total Orders column is read as written', () => {
  const headers = ['Week', 'Rider ID', 'Rider Name', 'Days', 'LM Orders', 'Prime Orders', 'Club Orders', 'SDD Orders', 'Total Amount'];
  const noTotal = PX.parseSheets([{name: 'Weekly', grid: [headers, ['02/11/2026 - 08/11/2026', 'WL-1', 'Ravi', 6, 214, 150, 64, 0, 4520]]}]);
  assert.equal(noTotal.ok, true, noTotal.error);
  assert.equal(noTotal.records[0].totalOrders, 214);
  const withTotal = PX.parseSheets([{name: 'Weekly', grid: [[...headers, 'Total Orders'], ['02/11/2026 - 08/11/2026', 'WL-1', 'Ravi', 6, 214, 150, 64, 0, 4520, 230]]}]);
  assert.equal(withTotal.records[0].totalOrders, 230);
});

test('partner Reports and Admin Reports agree on rows saved without a Total Orders value', () => {
  const saved = {riderId: 'WL-1', riderName: 'Ravi', week: '02/11/2026 - 08/11/2026', weekKey: 'd:2026-11-02',
    weekStart: '2026-11-02', weekEnd: '2026-11-08', cycle: 'weekly', totalOrders: null, lm: 10, primaryOrders: 6, club: 4, sdd: 0};
  const partner = buildPartnerReport([saved], [{riderId: 'WL-1', riderName: 'Ravi', hubLocation: 'Guntur'}]);
  const admin = recordsFromWeeklyRows([{rider_id: 'WL-1', rider_name: 'Ravi', week_start: '2026-11-02', week_end: '2026-11-08',
    total_orders: null, lm: 10, primary_orders: 6, club: 4, sdd: 0}]);
  assert.equal(admin.records[0].total, 20);
  assert.equal(partner.weekly.total, admin.records[0].total);
  assert.equal(partner.allTimeOrders, 20);
  assert.equal(partner.riders.withOrders, 1);
});
