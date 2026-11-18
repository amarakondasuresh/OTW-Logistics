// Run with:  node --test --no-warnings test/rider-id-sync.test.mjs   (from the backend folder)
// End-to-end rule: a franchise submits a rider, Admin approves it, Admin imports the weekly Excel sheet, and the
// Rider ID decides which approved franchise sees each weekly row. Uses the real registration and payment services
// on an in-memory SQLite database. The Express routes wrap these same service functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRiderRegistrationService} from '../rider-registrations.js';
import {createWeeklyPaymentService, listForFranchise, listForVendor} from '../weekly-payments.js';

const ADMIN = {role: 'admin', accountId: 'acc-admin', identity: 'admin@onthewaylogistics.in'};
const FR_A = {role: 'franchise', accountId: 'acc-fr-a', identity: 'FP-000001', ownerName: 'Anantapur Franchise'};
const VN_A = {role: 'vendor', accountId: 'acc-vn-a', identity: 'VN-000001', ownerName: 'Vendor A'};
const VN_B = {role: 'vendor', accountId: 'acc-vn-b', identity: 'VN-000002', ownerName: 'Vendor B'};
const FR_B = {role: 'franchise', accountId: 'acc-fr-b', identity: 'FP-000002', ownerName: 'Guntur Franchise'};
const jpeg = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 1)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 4)]);
const files = () => ({selfie: {buffer: jpeg(), originalname: 'shot.jpg'}, aadhaar: {buffer: pdf(), originalname: 'aadhaar.pdf'}});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otw-sync-'));
  const db = new DatabaseSync(':memory:');
  const regs = createRiderRegistrationService({db, uploadDir: dir});
  const wp = createWeeklyPaymentService({db, riderRegistry: true});
  return {db, regs, wp};
}
// The same call the server makes after a successful APPROVED status change.
const approve = (s, id) => { const item = s.regs.setStatus(ADMIN, id, {status: 'APPROVED'}); s.wp.recheckPending('admin'); return item; };

const W = (start, end) => ({start, end});
const row = (riderId, riderName, week, amount, extra = {}) => ({
  riderId, riderName, riderKey: 'id:' + riderId.toLowerCase(), weekKey: 'd:' + week.start,
  weekLabel: `${week.start} - ${week.end}`, weekStart: week.start, weekEnd: week.end,
  days: 7, totalOrders: 20, lm: 5, primary: 10, club: 3, sdd: 2,
  lmAmount: 50, primeAmount: 180, clubAmount: 57, sddAmount: 36, amount, amountRaw: String(amount),
  sheet: 'Payments', rowNumber: 2, original: {}, ...extra,
});
const W1 = W('2026-11-02', '2026-11-08');
const W2 = W('2026-11-09', '2026-11-15');
const W3 = W('2026-11-16', '2026-11-22');
const register = (s, actor, riderId, riderName) => {
  const r = s.regs.create(actor, {riderId, riderName, mobile: '+91 98765 43210', hubPincode: '522002', hubLocation: 'Guntur - Brodipet hub'}, files());
  return r.id;
};

test('full workflow: franchise registers, Admin approves, Excel rows reach only the owning franchise', () => {
  const s = setup();
  const aId = register(s, FR_A, 'WL-A1', 'Ravi Kumar');
  const bId = register(s, FR_B, 'WL-B1', 'Sita Devi');

  // Admin imports before approval: nothing is assigned to any franchise.
  s.wp.importRecords({fileName: 'week1.xlsx', fileHash: 'h1', records: [
    row('WL-A1', 'Ravi Kumar', W1, 1000),
    row('WL-B1', 'Sita Devi', W1, 800),
    row('WL-X9', 'Unknown Rider', W1, 300),
  ]}, 'admin');
  assert.equal(listForFranchise(s.db, FR_A.accountId).length, 0);
  assert.equal(listForFranchise(s.db, FR_B.accountId).length, 0);

  // Approve Ravi: the pending row for WL-A1 is imported now, Sita's and the unknown rider stay pending.
  approve(s, aId);
  const a = listForFranchise(s.db, FR_A.accountId);
  assert.equal(a.length, 1);
  assert.equal(a[0].riderId, 'WL-A1');
  assert.equal(a[0].riderName, 'Ravi Kumar');
  assert.equal(a[0].amount, 1000);
  assert.equal(listForFranchise(s.db, FR_B.accountId).length, 0, 'unapproved rider is not shown to its franchise');

  approve(s, bId);
  const b = listForFranchise(s.db, FR_B.accountId);
  assert.equal(b.length, 1);
  assert.equal(b[0].riderId, 'WL-B1');
  assert.equal(listForFranchise(s.db, FR_A.accountId).some(r => r.riderId === 'WL-B1'), false, 'franchise A never sees B records');
  assert.equal(listForFranchise(s.db, FR_B.accountId).some(r => r.riderId === 'WL-X9'), false, 'unknown Rider ID is never shown');
  assert.equal(s.wp.listPending().pending.some(p => p.excelRiderId === 'WL-X9'), true, 'unknown rider is still pending');
});

test('a second weekly import adds the next week and keeps the earlier week; a re-imported week updates, not duplicates', () => {
  const s = setup();
  approve(s, register(s, FR_A, 'WL-A1', 'Ravi Kumar'));
  s.wp.importRecords({fileName: 'week1.xlsx', fileHash: 'h1', records: [row('WL-A1', 'Ravi Kumar', W1, 1000)]}, 'admin');
  s.wp.importRecords({fileName: 'week2.xlsx', fileHash: 'h2', records: [row('WL-A1', 'Ravi Kumar', W2, 1200)]}, 'admin');
  let a = listForFranchise(s.db, FR_A.accountId);
  assert.deepEqual(a.map(r => r.weekStart).sort(), [W1.start, W2.start].sort(), 'both weeks kept');

  // Corrected week 1 re-imported with a new amount: updated in place, no duplicate row.
  const again = s.wp.importRecords({fileName: 'week1-fixed.xlsx', fileHash: 'h3', records: [row('WL-A1', 'Ravi Kumar', W1, 1111)]}, 'admin');
  assert.equal(again.updated, 1);
  a = listForFranchise(s.db, FR_A.accountId);
  assert.equal(a.length, 2);
  assert.equal(a.find(r => r.weekStart === W1.start).amount, 1111);
  assert.equal(a.find(r => r.weekStart === W2.start).amount, 1200, 'the other week is untouched');
});

test('re-importing the same file adds nothing, and the same rider-week is never shown twice', () => {
  const s = setup();
  approve(s, register(s, FR_A, 'WL-A1', 'Ravi Kumar'));
  const records = [row('WL-A1', 'Ravi Kumar', W1, 1000), row('WL-A1', 'Ravi Kumar', W2, 1200)];
  s.wp.importRecords({fileName: 'w.xlsx', fileHash: 'same', records}, 'admin');
  const second = s.wp.importRecords({fileName: 'w.xlsx', fileHash: 'same', records}, 'admin');
  assert.equal(second.inserted, 0);
  assert.equal(second.unchanged, 2);
  const a = listForFranchise(s.db, FR_A.accountId);
  assert.equal(a.length, 2);
  assert.equal(new Set(a.map(r => r.weekKey)).size, 2);
});

test('a rejected rider stops being shown to its franchise; a name alone never assigns a row', () => {
  const s = setup();
  const id = register(s, FR_A, 'WL-A1', 'Ravi Kumar');
  approve(s, id);
  s.wp.importRecords({fileName: 'w.xlsx', fileHash: 'w', records: [row('WL-A1', 'Ravi Kumar', W1, 1000)]}, 'admin');
  assert.equal(listForFranchise(s.db, FR_A.accountId).length, 1);
  s.regs.setStatus(ADMIN, id, {status: 'REJECTED', remarks: 'Documents unclear'});
  assert.equal(listForFranchise(s.db, FR_A.accountId).length, 0, 'rejected rider rows are hidden from the franchise');

  // A row with no Rider ID but the same name as an approved rider is not assigned to that rider.
  s.wp.importRecords({fileName: 'n.xlsx', fileHash: 'n', records: [row('', 'Ravi Kumar', W2, 500)]}, 'admin');
  assert.equal(listForFranchise(s.db, FR_A.accountId).length, 0);
});

test('the registered rider name is shown even when the Excel name differs (matched by Rider ID)', () => {
  const s = setup();
  approve(s, register(s, FR_A, 'WL-A1', 'Ravi Kumar'));
  s.wp.importRecords({fileName: 'w.xlsx', fileHash: 'w', records: [row('WL-A1', 'R. Kumar', W1, 1000)]}, 'admin');
  const a = listForFranchise(s.db, FR_A.accountId);
  assert.equal(a.length, 1);
  assert.equal(a[0].riderName, 'Ravi Kumar');
});

test('a franchise with no approved riders receives an empty list, and an unknown account receives nothing', () => {
  const s = setup();
  approve(s, register(s, FR_A, 'WL-A1', 'Ravi Kumar'));
  s.wp.importRecords({fileName: 'w.xlsx', fileHash: 'w', records: [row('WL-A1', 'Ravi Kumar', W1, 1000)]}, 'admin');
  assert.equal(listForFranchise(s.db, FR_B.accountId).length, 0);
  assert.equal(listForFranchise(s.db, '').length, 0);
  assert.equal(listForFranchise(s.db, undefined).length, 0);
});

test('vendors: each vendor sees only its own approved riders; franchises never see vendor riders; pending riders are hidden', () => {
  const s = setup();
  const a1 = register(s, VN_A, 'WL-V1', 'Vendor A Rider');
  const b1 = register(s, VN_B, 'WL-V2', 'Vendor B Rider');
  const pend = register(s, VN_A, 'WL-V3', 'Pending Rider');
  approve(s, a1);
  approve(s, b1);
  s.wp.importRecords({fileName: 'wk1.xlsx', fileHash: 'v1', records: [
    row('WL-V1', 'Vendor A Rider', W1, 700),
    row('WL-V2', 'Vendor B Rider', W1, 800),
    row('WL-V3', 'Pending Rider', W1, 900),
  ]}, 'admin');
  const aRows = listForVendor(s.db, VN_A.accountId);
  assert.deepEqual(aRows.map(r => r.riderId), ['WL-V1']);
  assert.equal(aRows[0].riderName, 'Vendor A Rider');
  assert.equal(aRows[0].amount, 700);
  assert.deepEqual(listForVendor(s.db, VN_B.accountId).map(r => r.riderId), ['WL-V2']);
  assert.equal(listForVendor(s.db, FR_A.accountId).length, 0, 'a franchise account gets no vendor rows');
  assert.equal(listForFranchise(s.db, VN_A.accountId).length, 0, 'a vendor account gets no franchise rows');
  assert.equal(listForVendor(s.db, '').length, 0);
  // once the pending rider is approved, only that vendor receives its row
  approve(s, pend);
  assert.deepEqual(listForVendor(s.db, VN_A.accountId).map(r => r.riderId).sort(), ['WL-V1', 'WL-V3']);
  assert.deepEqual(listForVendor(s.db, VN_B.accountId).map(r => r.riderId), ['WL-V2']);
});
