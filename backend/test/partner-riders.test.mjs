// Run with:  node --test --no-warnings test/partner-riders.test.mjs   (from the backend folder)
// Admin Portal > Client: riders under each Vendor / Franchise, with their payment summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const PR = require('../../dashboard/partner-riders.js');

const vendor = {id: 'a1', appId: 'VN-000001', type: 'Vendor', name: 'Suresh', portalLogin: {loginId: 'VN-000001'}};
const franchise = {id: 'a2', appId: 'FP-000001', type: 'Franchise', name: 'Lakshmi', portalLogin: {loginId: 'FP-000001'}};
const pending = {id: 'a3', appId: 'VN-000002', type: 'Vendor', name: 'Kiran', portalLogin: null};
const reg = (id, riderId, source, owner, status, createdAt) => ({id, riderId, riderName: 'R ' + riderId, registrationSource: source, ownerLoginId: owner, status, createdAt});
const regs = [
  reg('r1', 'OTW-101', 'Vendor', 'VN-000001', 'APPROVED', '2026-11-01T10:00:00Z'),
  reg('r2', 'OTW-102', 'Vendor', 'vn-000001', 'PENDING', '2026-11-03T10:00:00Z'),
  reg('r3', 'OTW-777', 'Vendor', 'VN-000001', 'REJECTED', '2026-11-02T10:00:00Z'),
  reg('r4', 'OTW-103', 'Franchise', 'FP-000001', 'APPROVED', '2026-11-01T10:00:00Z'),
  reg('r5', 'OTW-900', 'Admin', '', 'APPROVED', '2026-11-01T10:00:00Z'),
  reg('r6', 'OTW-901', 'Franchise', 'VN-000001', 'APPROVED', '2026-11-01T10:00:00Z'), // wrong type for this owner: not shown
];
const weekly = [
  {riderId: 'OTW-101', week: '19/10 - 25/10', weekStart: '2026-10-19', totalOrders: 214, amount: 4520.5, paymentStatus: 'PAID', verificationStatus: 'VERIFIED'},
  {riderId: 'otw-101', week: '26/10', weekStart: '2026-10-26', totalOrders: null, lm: 260, primary: 180, club: 80, amount: 5210.25, paymentStatus: 'PENDING', verificationStatus: 'VERIFIED'},
  {riderId: '', riderName: 'Unverified', week: 'x', weekStart: '2026-10-26', totalOrders: 5, amount: 99, verificationStatus: 'PENDING_VERIFICATION'},
];

test('every rider a vendor registered is listed under it, newest first, with status counts', () => {
  const [g] = PR.ridersByPartner([vendor], regs, weekly);
  assert.deepEqual(g.riders.map(r => r.riderId), ['OTW-102', 'OTW-777', 'OTW-101']);
  assert.deepEqual(g.counts, {total: 3, APPROVED: 1, PENDING: 1, REJECTED: 1});
});

test('franchise riders stay with the franchise; admin registrations and other partners never mix in', () => {
  const [v, f, p] = PR.ridersByPartner([vendor, franchise, pending], regs, weekly);
  assert.deepEqual(f.riders.map(r => r.riderId), ['OTW-103']);
  assert.ok(!v.riders.some(r => r.riderId === 'OTW-103' || r.riderId === 'OTW-900' || r.riderId === 'OTW-901'));
  assert.equal(p.counts.total, 0, 'an application without a login has no riders');
});

test('payment summary per rider uses verified weekly rows and the Reports total rule', () => {
  const [g] = PR.ridersByPartner([vendor], regs, weekly);
  const r = g.riders.find(x => x.riderId === 'OTW-101');
  assert.deepEqual([r.payments.weeks, r.payments.orders, r.payments.amount, r.payments.paid, r.payments.latest],
    [2, 214 + 260 + 180 + 80, 4520.5 + 5210.25, 4520.5, '26/10']);
  assert.equal(g.riders.find(x => x.riderId === 'OTW-102').payments, null);
  assert.equal(g.totals.amount, 4520.5 + 5210.25);
});

test('riders registered before a vendor application was moved to franchise still show (previous ID)', () => {
  const moved = {...franchise, appId: 'FP-000009', previousAppId: 'VN-000001', type: 'Vendor', portalLogin: null};
  const [g] = PR.ridersByPartner([moved], regs, []);
  assert.equal(g.counts.total, 3);
});
