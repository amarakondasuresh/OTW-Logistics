// Portal separation guard. Rider Applications belong to the Admin Portal (full management), the Vendor
// Portal (own riders, can decide on them) and the Franchise Portal (own riders, read-only decisions).
// Each portal calls only its own API scope. These checks read the front-end and route files directly, so
// they run offline with no extra dependencies.
// Run with:  npm test   (from the backend folder)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Text that only the Rider Applications page uses (Admin and Vendor versions alike).
const RIDER_APPLICATION_SIGNS = [
  /\briderApps\b/,
  /\brr[A-Z]\w*/,
  /\breg(Stat|Rows|Filter|Refresh|Empty)\w*/,
  /\brr-filters\b/,
  /rider-registrations/,
  /Rider Applications/,
  /Add New Member/,
  /\bApprove\b/,
  /\bReject\b/,
];
const signsIn = text => RIDER_APPLICATION_SIGNS.filter(re => re.test(text)).map(String);

// ---------- Franchise Portal: own Rider Applications, read-only decisions ----------

test('Franchise Portal has its own Rider Applications menu entry, page and script', () => {
  const html = read('franchise-portal/index.html');
  assert.match(html, /data-page="riderApps"/);
  assert.match(html, /<section id="riderApps"/);
  assert.match(html, /<script src="rider-registrations\.js">/);
  assert.match(html, /＋ Add New Member/);
  assert.match(html, /id="rrRows"/);
  assert.match(html, /id="rrModal"/);
});

test('Franchise Rider Applications is read-only: no approve, reject or status-change controls', () => {
  const html = read('franchise-portal/index.html');
  const start = html.indexOf('<section id="riderApps"');
  const section = html.slice(start, html.indexOf('</section>', start));
  assert.doesNotMatch(section, /<button[^>]*>[^<]*(Approve|Reject)/, 'no approve or reject button in the franchise page');
  const js = read('franchise-portal/rider-registrations.js');
  assert.ok(!js.includes('data-rr-decide'), 'no decision buttons in the franchise script');
  assert.ok(!/['"]\/status['"]/.test(js), 'the franchise script must not call the status endpoint');
  assert.ok(!js.includes('confirmDecision'), 'no approve / reject dialog in the franchise script');
});

test('Franchise Rider Applications only ever call the franchise portal', () => {
  const js = read('franchise-portal/rider-registrations.js');
  assert.ok(js.includes('?portal=${PORTAL}'), 'requests name the portal from app.js (franchise)');
  assert.ok(!/['"](admin|vendor)['"]/.test(js), 'no admin or vendor portal in the franchise script');
  assert.ok(!js.includes('?portal=admin') && !js.includes('?portal=vendor'));
});

test('Franchise Portal stylesheet has the rider application styles it needs', () => {
  const css = read('franchise-portal/style.css');
  for (const rule of ['.rr-filters', '.rr-card', '.rr-doc-view', '.rr-grid', '.rejected']) {
    assert.ok(css.includes(rule), `${rule} must be defined for the franchise page`);
  }
});

test('Franchise Orders shows the Weekly Payments table with the 15 required columns in order', () => {
  const html = read('franchise-portal/index.html');
  const start = html.indexOf('<section id="orders"');
  const section = html.slice(start, html.indexOf('</section>', start));
  const tableStart = section.indexOf('<table'), tableEnd = section.indexOf('</table>', tableStart);
  const headers = [...section.slice(tableStart, tableEnd).matchAll(/<th>(.*?)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(headers, ['S.No.', 'Rider ID', 'Rider Name', 'Week', 'Days', 'Total Orders', 'LM Orders', 'Prime Orders', 'Club Orders', 'SDD Orders', 'LM Amount', 'Prime Amount', 'Club Amount', 'SDD Amount', 'Total Amount']);
  assert.equal(section.includes('Orders summary'), false);
});

test('Franchise Orders reads Admin weekly payments from central storage with owner scoping in the backend', () => {
  const html = read('franchise-portal/index.html');
  const js = read('franchise-portal/app.js');
  const server = read('backend/server.js');
  const weekly = read('backend/weekly-payments.js');
  assert.match(html, /<h3>Weekly Payments — Excel Automatic<\/h3>/);
  assert.match(js, /api\(\s*['"]\/api\/portal\/weekly-payments\?portal=franchise['"]/);
  const routeStart = server.search(/app\.get\(['"]\/api\/portal\/weekly-payments['"]/);
  assert.ok(routeStart >= 0, 'the weekly-payments portal route exists');
  const routeEnd = server.slice(routeStart).search(/app\.put\(['"]\/api\/portal\/data['"]/);
  const route = server.slice(routeStart, routeStart + routeEnd);
  assert.match(route, /req\.account\.role\s*!==\s*['"]franchise['"]\s*&&\s*req\.account\.role\s*!==\s*['"]vendor['"]/);
  assert.match(route, /partnerPortalPayload\(\s*db,\s*req\.account\.role,\s*req\.account\.id,\s*week,?\s*\)/);
  const reports = read('backend/partner-reports.js');
  assert.match(reports, /listForFranchise\(db, accountId\)/);
  assert.match(reports, /listForVendor\(db, accountId\)/);
  const fn = weekly.slice(weekly.indexOf('export function listForFranchise'));
  assert.match(fn, /rr\.owner_account_id=\?/);
  assert.match(fn, /rr\.registration_source='Franchise'/);
  assert.match(fn, /rr\.application_status='APPROVED'/);
  assert.match(fn, /FROM weekly_payments wp/);
  assert.match(fn, /provisional:%/);
});

test('Franchise Riders page keeps its Rider Management format (Add, Edit, Remove)', () => {
  const html = read('franchise-portal/index.html');
  const js = read('franchise-portal/app.js');
  assert.match(html, /<h3>Rider Management<\/h3>/);
  assert.match(html, /id="addRider"[^>]*>\s*＋ Add Rider\s*</);
  assert.match(html, /id="riderModalTitle">Add Rider</);
  assert.match(js, /function renderRiders\(/);
  assert.match(js, /editRider/);
  assert.match(js, /removeRider/);
});

// ---------- Admin Portal: full Rider Applications page kept ----------

test('Admin Portal keeps the full Rider Applications page', () => {
  const js = read('dashboard/app.js');
  for (const id of ['regStatTotal', 'regStatPending', 'regStatApproved', 'regStatRejected',
    'regRows', 'regFilterId', 'regFilterName', 'regFilterHub', 'regFilterStatus', 'regRefresh']) {
    assert.ok(js.includes(`id="${id}"`), `Admin Rider Applications is missing #${id}`);
  }
  assert.ok(js.includes('?portal=admin'), 'Admin rider calls must name the admin portal');
  assert.match(js, /data-rr-act="APPROVED"/);
  assert.match(js, /data-rr-act="REJECTED"/);
  assert.match(js, /data-rr-doc="selfie"/);
  assert.match(js, /data-rr-doc="aadhaar"/);
});

// ---------- Vendor Portal: its own Rider Applications, own riders only ----------

test('Vendor Portal keeps its own Rider Applications page and component', () => {
  const html = read('vendor-portal/index.html');
  assert.match(html, /data-page="riderApps"/);
  assert.match(html, /<section id="riderApps"/);
  assert.match(html, /<script src="rider-registrations\.js">/);
});

test('Vendor Rider Applications only ever call the vendor portal', () => {
  const js = read('vendor-portal/rider-registrations.js');
  assert.ok(js.includes('?portal=${PORTAL}'));
  assert.ok(!/['"]franchise['"]/.test(js), 'vendor component must not reference the franchise portal');
  assert.ok(!/['"]admin['"]/.test(js), 'vendor component must not reference the admin portal');
});

// ---------- Backend: every portal goes through the same sign-in guard; only admin and vendor decide ----------

test('Rider routes sign each portal in to its own scope and never refuse the franchise by name', () => {
  const routes = read('backend/rider-registration-routes.js');
  const rules = read('backend/rider-registrations.js');
  assert.ok(!routes.includes("portal === 'franchise'"), 'the old franchise refusal must be gone');
  assert.match(routes, /REG_PORTALS\.includes\(portal\)/);
  assert.match(routes, /auth\.requireRole\(portal\)/);
  assert.match(rules, /REG_PORTALS = \[['"]admin['"], ['"]vendor['"], ['"]franchise['"]\]/);
  assert.match(rules, /REG_DECIDER_ROLES = \[['"]admin['"], ['"]vendor['"]\]/);
  assert.match(rules, /Only the On The Way Logistics admin can approve or reject/);
});

// ---------- Vendor Rider Applications: no status dropdown, no Action column ----------

const vendorRiderApplications = () => {
  const html = read('vendor-portal/index.html');
  const start = html.indexOf('<section id="riderApps"');
  return html.slice(start, html.indexOf('</section>', start));
};

test('Vendor Rider Applications has no All Statuses dropdown and no Action column', () => {
  const section = vendorRiderApplications();
  assert.ok(!section.includes('rrFilterStatus'), 'the status dropdown must be removed');
  assert.ok(!section.includes('All statuses'), 'the All statuses option must be removed');
  assert.doesNotMatch(section, /<th>Action<\/th>/);
});

test('Vendor Rider Applications keeps every other column and the Status column', () => {
  const section = vendorRiderApplications();
  for (const heading of ['Rider ID', 'Rider Name', 'Mobile Number', 'Hub Pincode', 'Hub Location', 'Selfie', 'Aadhaar', 'Applied On', 'Status']) {
    assert.ok(section.includes(`<th>${heading}</th>`), `column "${heading}" must remain`);
  }
  assert.ok(section.includes('id="rrFilterId"') && section.includes('id="rrFilterName"') && section.includes('id="rrFilterHub"'), 'the three text filters must remain');
  assert.ok(section.includes('data-rr-refresh'), 'the Refresh button must remain');
  assert.ok(section.includes('＋ Add New Member'), 'Add New Member must remain');
});

test('Vendor rider rows open details, where approve and reject still live; the other vendor pages keep their Action columns', () => {
  const js = read('vendor-portal/rider-registrations.js');
  assert.ok(!js.includes('rrFilterStatus'), 'the script must not read the removed dropdown');
  assert.ok(!js.includes('rr-actions') && !/data-rr-act=/.test(js), 'rows must not render action buttons');
  assert.ok(js.includes('tr class="rr-row" data-rr-id'), 'rows open details when clicked');
  assert.ok(js.includes('data-rr-decide="APPROVED"') && js.includes('data-rr-decide="REJECTED"'), 'details window keeps Approve and Reject');
  assert.ok(/['"]\/status['"]/.test(js), 'the decision request still goes to the status endpoint');
  const html = read('vendor-portal/index.html');
  for (const page of ['locations', 'riders']) {
    const start = html.indexOf(`<section id="${page}"`);
    assert.ok(html.slice(start, html.indexOf('</section>', start)).includes('<th>Action</th>'), `${page} keeps its Action column`);
  }
});

test('Admin Client Members page keeps its own filters and Action controls', () => {
  const js = read('dashboard/app.js');
  assert.ok(js.includes('id="regFilterStatus"'));
  assert.ok(js.includes('data-rr-act="APPROVED"') && js.includes('data-rr-act="REJECTED"'));
});
