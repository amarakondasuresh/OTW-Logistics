// Run with:  node --test --no-warnings test/vendor-admin-integration.test.mjs   (from the backend folder)
// Vendor Portal <-> Admin Portal on one central database (SQLite via Node's built-in module, same as the server).
// Covers: vendor submits a rider -> Admin sees it with the vendor's Vendor ID -> Admin approves or rejects ->
// the vendor sees the new status -> Admin edits -> the vendor sees the change -> Excel rows reach only the owning vendor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRiderRegistrationService, RegistrationError} from '../rider-registrations.js';
import {createWeeklyPaymentService, listForVendor} from '../weekly-payments.js';

const ADMIN = {role: 'admin', accountId: 'acc-admin', identity: 'admin@onthewaylogistics.in'};
const VN_A = {role: 'vendor', accountId: 'acc-vn-a', identity: 'VN-000001', ownerName: 'Vendor A'};
const VN_B = {role: 'vendor', accountId: 'acc-vn-b', identity: 'VN-000002', ownerName: 'Vendor B'};
const jpeg = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 1)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 4)]);
const files = () => ({selfie: {buffer: jpeg(), originalname: 's.jpg'}, aadhaar: {buffer: pdf(), originalname: 'a.pdf'}});
const fields = (over = {}) => ({riderId: 'WL-V100', riderName: 'Ravi Kumar', mobile: '+91 98765 43210', hubPincode: '522002', hubLocation: 'Guntur - Brodipet hub', ...over});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otw-vn-'));
  const db = new DatabaseSync(':memory:');
  const regs = createRiderRegistrationService({db, uploadDir: dir});
  const wp = createWeeklyPaymentService({db, riderRegistry: true});
  return {db, regs, wp};
}
const expectError = (fn, status) => {
  assert.throws(fn, err => err instanceof RegistrationError && err.status === status);
};
const W = {start: '2026-11-02', end: '2026-11-08'};
const sheet = (riderId, name, amount) => ({
  riderId, riderName: name, riderKey: 'id:' + riderId.toLowerCase(), weekKey: 'd:' + W.start,
  weekLabel: `${W.start} - ${W.end}`, weekStart: W.start, weekEnd: W.end, days: 7, totalOrders: 20,
  lm: 5, primary: 10, club: 3, sdd: 2, lmAmount: 50, primeAmount: 180, clubAmount: 57, sddAmount: 36,
  amount, amountRaw: String(amount), sheet: 'Payments', rowNumber: 2, original: {},
});

test('vendor submits a rider; Admin sees it with the vendor Vendor ID; the vendor sees its own status', () => {
  const s = setup();
  const item = s.regs.create(VN_A, fields(), files());
  assert.equal(item.status, 'PENDING');
  assert.equal(item.registrationSource, 'Vendor');
  assert.equal(item.ownerLoginId, 'VN-000001', 'Vendor ID is stored with the rider');
  assert.equal(item.ownerName, 'Vendor A');

  const adminList = s.regs.list(ADMIN);
  assert.equal(adminList.length, 1);
  assert.equal(adminList[0].riderId, 'WL-V100');
  assert.equal(adminList[0].applicationId.length > 0, true);

  assert.equal(s.regs.list(VN_A)[0].status, 'PENDING');
  assert.equal(s.regs.list(VN_B).length, 0, 'another vendor does not see this application');
  expectError(() => s.regs.get(VN_B, item.id), 404);
});

test('a Rider ID already registered by one vendor is refused for another vendor (no mixed records)', () => {
  const s = setup();
  s.regs.create(VN_A, fields(), files());
  expectError(() => s.regs.create(VN_B, fields({riderName: 'Someone Else'}), files()), 409);
  assert.equal(s.regs.list(ADMIN).length, 1);
  assert.equal(s.regs.list(VN_B).length, 0);
});

test('a vendor decides only its own riders; the vendor sees REJECTED with the reason; a re-application can be approved', () => {
  const s = setup();
  const first = s.regs.create(VN_A, fields(), files());
  // Existing design (recorded decision): a vendor may decide only its own riders. Another vendor's rider is not visible to it.
  const other = s.regs.create(VN_B, fields({riderId: 'WL-V300', riderName: 'Other Vendor Rider'}), files());
  expectError(() => s.regs.setStatus(VN_A, other.id, {status: 'APPROVED'}), 404);
  s.regs.setStatus(ADMIN, first.id, {status: 'REJECTED', remarks: 'Aadhaar photo is not readable'});
  const seen = s.regs.list(VN_A)[0];
  assert.equal(seen.status, 'REJECTED');
  assert.equal(seen.rejectionRemarks, 'Aadhaar photo is not readable');

  // a rejected rider may be submitted again with the same Rider ID
  const second = s.regs.create(VN_A, fields(), files());
  assert.equal(second.status, 'PENDING');
  const approved = s.regs.setStatus(ADMIN, second.id, {status: 'APPROVED'});
  assert.equal(approved.status, 'APPROVED');
  assert.equal(s.regs.list(VN_A).find(x => x.id === second.id).status, 'APPROVED');
  assert.equal(s.regs.list(VN_A).find(x => x.id === first.id).status, 'REJECTED', 'the old decision stays on record');
});

test('Admin edits to an approved rider reach the vendor; the owner and Rider ID do not change', () => {
  const s = setup();
  const item = s.regs.create(VN_A, fields(), files());
  s.regs.setStatus(ADMIN, item.id, {status: 'APPROVED'});
  s.regs.update(ADMIN, item.id, fields({riderName: 'Ravi Kumar Appari', mobileNumber: '+91 98765 43210'}), {});
  const seen = s.regs.list(VN_A)[0];
  assert.equal(seen.riderName, 'Ravi Kumar Appari');
  assert.equal(seen.riderId, 'WL-V100', 'Rider ID is preserved');
  assert.equal(seen.ownerLoginId, 'VN-000001', 'Vendor ID association is preserved');
  expectError(() => s.regs.update(VN_A, item.id, fields({riderName: 'Changed by vendor'}), {}), 403);
});

test('an approved rider receives Excel working rows from Admin imports; only its vendor sees them, with the registered name', () => {
  const s = setup();
  const a = s.regs.create(VN_A, fields(), files());
  s.regs.create(VN_B, fields({riderId: 'WL-V200', riderName: 'Other Rider'}), files());
  s.regs.setStatus(ADMIN, a.id, {status: 'APPROVED'});
  s.wp.importRecords({fileName: 'wk.xlsx', fileHash: 'wk1', records: [
    sheet('WL-V100', 'R. Kumar', 1000),
    sheet('WL-V200', 'Other Rider', 700),
  ]}, 'admin');
  const aRows = listForVendor(s.db, VN_A.accountId);
  assert.deepEqual(aRows.map(r => r.riderId), ['WL-V100']);
  assert.equal(aRows[0].riderName, 'Ravi Kumar', 'the registered name is used, not the sheet name');
  assert.equal(aRows[0].amount, 1000);
  assert.equal(listForVendor(s.db, VN_B.accountId).length, 0, 'vendor B has no approved rider yet');
});
