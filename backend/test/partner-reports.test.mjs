// Run with:  node --test --no-warnings test/partner-reports.test.mjs   (from the backend folder)
// Vendor Portal Reports: every figure is calculated from the same saved weekly_payments rows the Orders page shows,
// for the logged-in vendor's approved riders only. Uses the real registration and payment services on SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRiderRegistrationService} from '../rider-registrations.js';
import {createWeeklyPaymentService, listForVendor} from '../weekly-payments.js';
import {buildPartnerReport, franchisePortalPayload, isValidLocation, listApprovedRidersForVendor, vendorPortalPayload} from '../partner-reports.js';

const ADMIN = {role: 'admin', accountId: 'acc-admin', identity: 'admin@onthewaylogistics.in'};
const VN_A = {role: 'vendor', accountId: 'acc-vn-a', identity: 'VN-000001', ownerName: 'Vendor A'};
const VN_B = {role: 'vendor', accountId: 'acc-vn-b', identity: 'VN-000002', ownerName: 'Vendor B'};
const jpeg = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 1)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 4)]);
const files = () => ({selfie: {buffer: jpeg(), originalname: 's.jpg'}, aadhaar: {buffer: pdf(), originalname: 'a.pdf'}});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otw-rep-'));
  const db = new DatabaseSync(':memory:');
  const regs = createRiderRegistrationService({db, uploadDir: dir});
  const wp = createWeeklyPaymentService({db, riderRegistry: true});
  return {db, regs, wp};
}
const approve = (s, actor, riderId, riderName, hub) => {
  const r = s.regs.create(actor, {riderId, riderName, mobile: '+91 98765 43210', hubPincode: '522002', hubLocation: hub}, files());
  s.regs.setStatus(ADMIN, r.id, {status: 'APPROVED'});
  s.wp.recheckPending('admin');
  return r.id;
};

const W1 = {start: '2026-11-02', end: '2026-11-08'};
const W2 = {start: '2026-11-09', end: '2026-11-15'};
const FIFTEEN = {start: '2026-11-01', end: '2026-11-15'};
const row = (riderId, riderName, week, extra = {}) => ({
  riderId, riderName, riderKey: 'id:' + riderId.toLowerCase(), weekKey: 'd:' + week.start,
  weekLabel: `${week.start} - ${week.end}`, weekStart: week.start, weekEnd: week.end,
  days: 7, totalOrders: 129, lm: 0, primary: 118, club: 11, sdd: 0,
  lmAmount: 0, primeAmount: 2124, clubAmount: 209, sddAmount: 0, amount: 2333, amountRaw: '2333',
  sheet: 'Payments', rowNumber: 2, original: {}, ...extra,
});

// Two vendors, each with approved riders; a third rider is pending and must never be counted.
function seeded() {
  const s = setup();
  approve(s, VN_A, 'WL-V1', 'Sridevi Kanth Valluri', 'Guntur - Brodipet hub');
  approve(s, VN_A, 'WL-V3', 'Ravi Kumar', 'Guntur - Brodipet hub');   // same hub: one location
  approve(s, VN_B, 'WL-V2', 'Sita Devi', 'Vijayawada - Benz Circle');
  s.regs.create(VN_A, {riderId: 'WL-V9', riderName: 'Pending Person', mobile: '+91 98765 43210', hubPincode: '522002', hubLocation: 'Tenali hub'}, files());
  s.wp.importRecords({fileName: 'weekly-a.xlsx', fileHash: 'h-a', records: [
    row('WL-V1', 'Sridevi Kanth Valluri', W1, {totalOrders: 100, primary: 80, club: 10, lm: 10, sdd: 0, amount: 1800}),
    row('WL-V1', 'Sridevi Kanth Valluri', W2, {totalOrders: 129, primary: 118, club: 11, lm: 0, sdd: 0, amount: 2333}),
    row('WL-V3', 'Ravi Kumar', W2, {totalOrders: 40, primary: 30, club: 5, lm: 5, sdd: 2, amount: 700}),
    row('WL-V2', 'Sita Devi', W2, {totalOrders: 999, primary: 900, club: 99, lm: 0, sdd: 0, amount: 9999}),
    row('WL-V9', 'Pending Person', W2, {totalOrders: 500, amount: 500}),
    row('WL-V1', 'Sridevi Kanth Valluri', FIFTEEN, {totalOrders: 300, primary: 260, club: 25, lm: 15, sdd: 0, amount: 5000}),
  ]}, 'admin');
  return s;
}

test('vendor A sees only its own approved riders, locations and order totals', () => {
  const s = seeded();
  const {records, report} = vendorPortalPayload(s.db, VN_A.accountId);
  assert.equal(records.length, 4, 'WL-V1 (2 weeks + 15-day) and WL-V3 (1 week)');
  assert.deepEqual([...new Set(records.map(r => r.riderId))].sort(), ['WL-V1', 'WL-V3']);
  assert.equal(report.riders.total, 2, 'two approved riders for vendor A');
  assert.equal(report.riders.withOrders, 2);
  assert.equal(report.locations, 1, 'two riders in the same hub count once');
  // all-time: 100 + 129 + 40 + 300, never vendor B (999) or the pending rider (500)
  assert.equal(report.allTimeOrders, 569);
  assert.ok(!records.some(r => r.riderId === 'WL-V2'));
});

test('vendor B cannot see vendor A riders or totals', () => {
  const s = seeded();
  const {report} = vendorPortalPayload(s.db, VN_B.accountId);
  assert.equal(report.riders.total, 1);
  assert.equal(report.locations, 1);
  assert.equal(report.allTimeOrders, 999);
});

test('weekly summary uses the newest weekly cycle and maps Excel columns exactly', () => {
  const s = seeded();
  const {report} = vendorPortalPayload(s.db, VN_A.accountId);
  assert.equal(report.weekly.label, '2026-11-09 - 2026-11-15', 'same Week label the Orders page shows');
  assert.equal(report.weekly.total, 129 + 40, 'Total Orders column');
  assert.equal(report.weekly.primary, 118 + 30, 'Prime Orders feed Primary');
  assert.equal(report.weekly.club, 11 + 5, 'Club Orders feed Club');
  assert.equal(report.weekly.large, 0 + 5, 'LM Orders feed Large');
  assert.equal(report.weekly.sdd, 2, 'SDD kept separately');
  assert.equal(report.weekly.riders, 2);
});

test('15-day cycle is reported separately from weekly rows', () => {
  const s = seeded();
  const {report} = vendorPortalPayload(s.db, VN_A.accountId);
  assert.equal(report.cycle15.total, 300);
  assert.equal(report.cycle15.primary, 260);
  assert.equal(report.periods15.length, 1);
  assert.equal(report.periods15[0].large, 15);
});

test('re-importing the same sheet does not double-count', () => {
  const s = seeded();
  const again = s.wp.importRecords({fileName: 'weekly-a.xlsx', fileHash: 'h-a', records: [
    row('WL-V1', 'Sridevi Kanth Valluri', W1, {totalOrders: 100, primary: 80, club: 10, lm: 10, sdd: 0, amount: 1800}),
    row('WL-V1', 'Sridevi Kanth Valluri', W2, {totalOrders: 129, primary: 118, club: 11, lm: 0, sdd: 0, amount: 2333}),
    row('WL-V3', 'Ravi Kumar', W2, {totalOrders: 40, primary: 30, club: 5, lm: 5, sdd: 2, amount: 700}),
  ]}, 'admin');
  assert.equal(again.inserted, 0);
  const {report} = vendorPortalPayload(s.db, VN_A.accountId);
  assert.equal(report.allTimeOrders, 569, 'unchanged after re-import');
});

test('a new import that changes a Total Orders value updates the report', () => {
  const s = seeded();
  s.wp.importRecords({fileName: 'weekly-b.xlsx', fileHash: 'h-b', records: [
    row('WL-V3', 'Ravi Kumar', W2, {totalOrders: 60, primary: 50, club: 5, lm: 5, sdd: 0, amount: 1000}),
  ]}, 'admin');
  const {report} = vendorPortalPayload(s.db, VN_A.accountId);
  assert.equal(report.weekly.total, 129 + 60);
  assert.equal(report.allTimeOrders, 100 + 129 + 60 + 300);
});

test('a vendor with no imported rows gets zeros and no weekly period', () => {
  const s = setup();
  approve(s, VN_A, 'WL-V1', 'Sridevi Kanth Valluri', 'Guntur hub');
  const {report} = vendorPortalPayload(s.db, VN_A.accountId);
  assert.equal(report.riders.total, 1);
  assert.equal(report.riders.withOrders, 0);
  assert.equal(report.allTimeOrders, 0);
  assert.equal(report.weekly, null);
  assert.equal(report.cycle15, null);
});

test('rider counts ignore duplicate Rider IDs and placeholder locations', () => {
  const report = buildPartnerReport(
    [{riderId: 'WL-1', weekKey: 'a', weekStart: '2026-11-02', weekEnd: '2026-11-08', cycle: 'weekly', week: 'w', totalOrders: 5, primaryOrders: 5, club: 0, lm: 0, sdd: 0},
     {riderId: 'wl-1', weekKey: 'a', weekStart: '2026-11-02', weekEnd: '2026-11-08', cycle: 'weekly', week: 'w', totalOrders: 5, primaryOrders: 5, club: 0, lm: 0, sdd: 0}],
    [{riderId: 'WL-1', hubLocation: 'Guntur'}, {riderId: 'wl-1', hubLocation: 'guntur'}, {riderId: 'WL-2', hubLocation: '-'}, {riderId: 'WL-3', hubLocation: ''}]);
  assert.equal(report.allTimeOrders, 5, 'same rider and week counted once');
  assert.equal(report.riders.total, 3, 'WL-1 and wl-1 are one rider; WL-2 and WL-3 have no valid location but are still riders');
  assert.equal(report.locations, 1, 'only Guntur is a valid, unique location');
});

test('isValidLocation accepts real place names and rejects placeholders', () => {
  assert.equal(isValidLocation('Guntur - Brodipet hub'), true);
  assert.equal(isValidLocation('  '), false);
  assert.equal(isValidLocation('-'), false);
  assert.equal(isValidLocation('NA'), false);
  assert.equal(isValidLocation('522002'), false);
});

test('approved riders list is limited to this vendor and to APPROVED status', () => {
  const s = seeded();
  const riders = listApprovedRidersForVendor(s.db, VN_A.accountId).map(r => r.riderId).sort();
  assert.deepEqual(riders, ['WL-V1', 'WL-V3']);
  assert.equal(listForVendor(s.db, VN_A.accountId).some(r => r.riderId === 'WL-V9'), false, 'pending rider has no rows');
});

// ---------- Franchise Portal Reports: same rules, franchise-owned riders only ----------
const FR_A = {role: 'franchise', accountId: 'acc-fr-a', identity: 'FP-000001', ownerName: 'Anantapur Franchise'};
const FR_B = {role: 'franchise', accountId: 'acc-fr-b', identity: 'FP-000002', ownerName: 'Guntur Franchise'};
const AUG = {start: '2026-08-24', end: '2026-08-30'};

function seededFranchise() {
  const s = setup();
  approve(s, FR_A, '28588592', 'Kandi Nithin', 'Anantapur hub');
  approve(s, FR_A, 'WL-F2', 'Lakshmi Devi', 'Anantapur hub');
  approve(s, FR_B, 'WL-G1', 'Mohan Rao', 'Guntur hub');
  approve(s, VN_A, 'WL-V1', 'Sridevi Kanth Valluri', 'Guntur - Brodipet hub');
  s.wp.importRecords({fileName: 'aug.xlsx', fileHash: 'h-aug', records: [
    row('28588592', 'Kandi Nithin', AUG, {totalOrders: 250, primary: 213, club: 37, lm: 0, sdd: 0,
      days: 7, lmAmount: 0, primeAmount: 3834, clubAmount: 222, sddAmount: 0, amount: 4056, amountRaw: '4056'}),
    row('WL-F2', 'Lakshmi Devi', W2, {totalOrders: 60, primary: 50, club: 5, lm: 5, sdd: 0, amount: 900}),
    row('WL-G1', 'Mohan Rao', W2, {totalOrders: 700, primary: 600, club: 100, lm: 0, sdd: 0, amount: 9000}),
    row('WL-V1', 'Sridevi Kanth Valluri', W2, {totalOrders: 800, amount: 8000}),
  ]}, 'admin');
  return s;
}

test('franchise report: only its own approved riders, rider IDs matched, other partners excluded', () => {
  const s = seededFranchise();
  const a = franchisePortalPayload(s.db, FR_A.accountId);
  assert.equal(a.report.riders.total, 2);
  assert.equal(a.records.some(r => r.riderId === 'WL-G1' || r.riderId === 'WL-V1'), false);
  assert.equal(a.report.allTimeOrders, 250 + 60, 'Kandi 250 + Lakshmi 60 only');
  const b = franchisePortalPayload(s.db, FR_B.accountId);
  assert.equal(b.report.allTimeOrders, 700);
  assert.equal(b.report.riders.total, 1);
  assert.equal(b.report.locations, 1);
});

test('franchise report: default is the newest week; a selected week shows only that week', () => {
  const s = seededFranchise();
  const latest = franchisePortalPayload(s.db, FR_A.accountId).report;
  assert.equal(latest.weekly.label, '2026-11-09 - 2026-11-15', 'newest week by default');
  assert.equal(latest.weekly.total, 60);
  const aug = franchisePortalPayload(s.db, FR_A.accountId, '2026-08-24..2026-08-30').report;
  assert.equal(aug.weekly.label, '2026-08-24 - 2026-08-30');
  assert.equal(aug.weekly.total, 250, 'Kandi Nithin only, not the November week');
  assert.equal(aug.weekly.primary, 213, 'Prime Orders');
  assert.equal(aug.weekly.club, 37, 'Club Orders');
  assert.equal(aug.weekly.large, 0, 'LM Orders');
  assert.equal(aug.weekly.sdd, 0, 'SDD Orders');
  assert.equal(aug.weekly.riders, 1);
  assert.equal(aug.allTimeOrders, 310, 'the all-time total is not affected by the selected week');
  assert.deepEqual(aug.weeks.map(w => w.label), ['2026-11-09 - 2026-11-15', '2026-08-24 - 2026-08-30']);
});

test('franchise week selection by label also works, and an unknown week falls back to the newest', () => {
  const s = seededFranchise();
  assert.equal(franchisePortalPayload(s.db, FR_A.accountId, '2026-08-24 - 2026-08-30').report.weekly.total, 250);
  assert.equal(franchisePortalPayload(s.db, FR_A.accountId, '1999-01-01..1999-01-07').report.weekly.label, '2026-11-09 - 2026-11-15');
});
