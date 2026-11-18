// Run with:  node --test test/hubs.test.mjs   (from the backend folder; uses Node's built-in SQLite, no web server needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {
  createHubService, normalizeHubInput, normalizeMobiles, normalizeDate, HubError, HUB_FORM_FIELDS, MAX_IMPORT_ROWS,
} from '../hubs.js';
import {registerHubRoutes} from '../hub-routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'hubs-seed.json'), 'utf8'));

// A fresh database and service for each test. The audit log is kept in an array so tests can check it.
function setup({seed = SEED} = {}) {
  const db = new DatabaseSync(':memory:');
  const audits = [];
  const service = createHubService({db, audit: (who, action, details) => audits.push({who, action, details}), seedRows: seed});
  return {db, service, audits};
}

const validHub = (over = {}) => ({
  hiName: 'Ravi Kumar', phone: '9876543210', name: 'GNT_Test_Hub', location: 'Brodipet', address: '12 Main Road',
  pincode: '522002', city: 'Guntur', district: 'Guntur', state: 'Andhra Pradesh', contactNumber: '9848012345',
  email: 'hub@example.com', manager: 'Sai Manager', openingDate: '2024-03-15', status: 'Active',
  url: 'https://www.example.com/hub', ...over,
});

function expectError(fn, status, field) {
  try { fn(); } catch (err) {
    assert.ok(err instanceof HubError, `expected HubError, got ${err}`);
    assert.equal(err.status, status);
    if (field !== undefined) assert.equal(err.field, field);
    return err;
  }
  assert.fail(`expected a HubError (${status})`);
}

// ---------- field rules ----------
test('mobile numbers: one or several 10-digit numbers starting 6-9', () => {
  assert.equal(normalizeMobiles('9876543210', 'P').value, '9876543210');
  assert.equal(normalizeMobiles('+91 98765 43210', 'P').value, '9876543210');
  assert.equal(normalizeMobiles('94938 94741', 'P').value, '9493894741');
  assert.equal(normalizeMobiles('9435692178, 7396500168', 'P').value, '9435692178, 7396500168');
  assert.equal(normalizeMobiles('', 'P').value, '');
  assert.ok(normalizeMobiles('93903333935', 'P').error, '11 digits is not valid');
  assert.ok(normalizeMobiles('1234567890', 'P').error, 'must start with 6-9');
  assert.ok(normalizeMobiles('9876543210, abc', 'P').error);
});

test('dates: Indian day/month/year and ISO are accepted; impossible dates are rejected', () => {
  assert.equal(normalizeDate('15/03/2024', 'D').value, '2024-03-15');
  assert.equal(normalizeDate('15-3-24', 'D').value, '2024-03-15');
  assert.equal(normalizeDate('2024-03-15', 'D').value, '2024-03-15');
  assert.equal(normalizeDate('', 'D').value, '');
  assert.ok(normalizeDate('31/02/2024', 'D').error);
  assert.ok(normalizeDate('March 15 2024', 'D').error);
});

test('form rules: status, pincode, email and URL are checked with a message naming the field', () => {
  const r = normalizeHubInput(validHub({status: 'inactive', pincode: '522002'}), {mode: 'form'});
  assert.deepEqual(r.errors, []);
  assert.equal(r.values.status, 'Inactive');
  const bad = normalizeHubInput(validHub({pincode: '052200', email: 'not-an-email', url: 'ftp://x.com', status: 'Open'}), {mode: 'form'});
  assert.deepEqual(bad.errors.map(e => e.field).sort(), ['email', 'pincode', 'status', 'url']);
  assert.match(bad.errors.find(e => e.field === 'url').message, /http:\/\/ or https:\/\//);
  // www. without a scheme is accepted and stored with https://
  assert.equal(normalizeHubInput({name: 'X', state: 'AP', url: 'www.example.com'}, {mode: 'form'}).values.url, 'https://www.example.com');
});

test('the form has exactly the 15 requested fields', () => {
  assert.equal(HUB_FORM_FIELDS.length, 15);
  assert.deepEqual(HUB_FORM_FIELDS, ['hiName', 'phone', 'name', 'location', 'address', 'pincode', 'city', 'district',
    'state', 'contactNumber', 'email', 'manager', 'openingDate', 'status', 'url']);
});

// ---------- create / read ----------
test('a new hub is saved with all 15 fields and reads back unchanged', () => {
  const {service} = setup();
  const hub = service.create(validHub(), 'admin@test');
  assert.match(hub.id, /^XH-\d{3}$/);
  assert.equal(hub.name, 'GNT_Test_Hub');
  assert.equal(hub.hiName, 'Ravi Kumar');
  assert.equal(hub.phone, '9876543210');
  assert.equal(hub.location, 'Brodipet');
  assert.equal(hub.address, '12 Main Road');
  assert.equal(hub.pincode, '522002');
  assert.equal(hub.city, 'Guntur');
  assert.equal(hub.district, 'Guntur');
  assert.equal(hub.state, 'Andhra Pradesh');
  assert.equal(hub.contactNumber, '9848012345');
  assert.equal(hub.email, 'hub@example.com');
  assert.equal(hub.manager, 'Sai Manager');
  assert.equal(hub.openingDate, '2024-03-15');
  assert.equal(hub.status, 'Active');
  assert.equal(hub.url, 'https://www.example.com/hub');
  assert.equal(service.get(hub.id).url, 'https://www.example.com/hub');
});

test('a new hub defaults to Active and needs Hub Name and State', () => {
  const {service} = setup();
  const hub = service.create({name: 'Plain Hub', state: 'Telangana', status: ''}, 'a');
  assert.equal(hub.status, 'Active');
  expectError(() => service.create({state: 'Telangana'}, 'a'), 400, 'name');
  expectError(() => service.create({name: 'No State Hub'}, 'a'), 400, 'state');
});

test('duplicate Hub Name is refused, ignoring letter case and extra spaces', () => {
  const {service} = setup();
  service.create(validHub({name: 'Lakshmi  Nagar Hub'}), 'a');
  expectError(() => service.create(validHub({name: 'lakshmi nagar hub'}), 'a'), 409, 'name');
  assert.equal(service.list().filter(h => h.name.toLowerCase().includes('lakshmi')).length, 1);
});

test('a database-level UNIQUE rule also protects Hub Name', () => {
  const {db, service} = setup();
  service.create(validHub({name: 'Unique Hub'}), 'a');
  assert.throws(() => db.prepare("INSERT INTO hubs(id,name,name_key,created_at,updated_at) VALUES('X-1','Unique Hub','unique hub','t','t')").run(), /UNIQUE/);
});

// ---------- update (individual fields) ----------
test('an Edit changes only the fields sent; the rest keep their saved values', () => {
  const {service, audits} = setup();
  const hub = service.create(validHub(), 'a');
  const out = service.update(hub.id, {phone: '9000000001'}, 'b');
  assert.deepEqual(out.changed, ['phone']);
  assert.equal(out.hub.phone, '9000000001');
  assert.equal(out.hub.city, 'Guntur', 'untouched field kept');
  assert.equal(out.hub.updatedBy, 'b');
  assert.equal(audits.at(-1).action, 'hub_updated');
  assert.deepEqual(audits.at(-1).details.changed, ['phone']);
});

test('saving with nothing changed does not write', () => {
  const {service} = setup();
  const hub = service.create(validHub(), 'a');
  const out = service.update(hub.id, {phone: hub.phone, city: hub.city}, 'b');
  assert.deepEqual(out.changed, []);
  assert.equal(out.hub.updatedBy, 'a', 'updated_by not touched');
});

test('an Edit can clear an optional field and can change status', () => {
  const {service} = setup();
  const hub = service.create(validHub(), 'a');
  const out = service.update(hub.id, {url: '', status: 'Inactive'}, 'b');
  assert.equal(out.hub.url, '');
  assert.equal(out.hub.status, 'Inactive');
});

test('an Edit with an invalid value is refused and names the field', () => {
  const {service} = setup();
  const hub = service.create(validHub(), 'a');
  expectError(() => service.update(hub.id, {url: 'nonsense'}, 'b'), 400, 'url');
  expectError(() => service.update(hub.id, {status: ''}, 'b'), 400, 'status');
  expectError(() => service.update(hub.id, {name: ''}, 'b'), 400, 'name');
  assert.equal(service.get(hub.id).url, 'https://www.example.com/hub', 'nothing was changed');
});

test('renaming to a name another hub already uses is refused; renaming only the case is allowed', () => {
  const {service} = setup();
  const a = service.create(validHub({name: 'Hub Alpha'}), 'a');
  service.create(validHub({name: 'Hub Beta'}), 'a');
  expectError(() => service.update(a.id, {name: 'hub beta'}, 'b'), 409, 'name');
  assert.equal(service.update(a.id, {name: 'HUB ALPHA'}, 'b').hub.name, 'HUB ALPHA');
});

test('updating a hub that does not exist returns 404', () => {
  const {service} = setup();
  expectError(() => service.update('XH-999', {phone: '9876543210'}, 'a'), 404);
});

// ---------- delete and notes ----------
test('delete removes the hub; a second delete reports it is gone', () => {
  const {service} = setup();
  const hub = service.create(validHub(), 'a');
  assert.deepEqual(service.remove(hub.id, 'a'), {ok: true});
  assert.equal(service.get(hub.id), null);
  expectError(() => service.remove(hub.id, 'a'), 404);
});

test('hub down notes are saved on the hub', () => {
  const {service} = setup();
  const hub = service.create(validHub(), 'a');
  const out = service.addNote(hub.id, {text: 'Shutter closed for repairs', vacancies: 2}, 'a');
  assert.equal(out.hub.notes.length, 1);
  assert.equal(out.hub.notes[0].text, 'Shutter closed for repairs');
  assert.equal(out.hub.notes[0].vacancies, 2);
  expectError(() => service.addNote(hub.id, {text: ''}, 'a'), 400, 'text');
  expectError(() => service.addNote(hub.id, {text: 'x', vacancies: -1}, 'a'), 400, 'vacancies');
});

// ---------- existing hubs (seed) ----------
test('the 100 existing hubs are loaded once, keeping their ids, POD, Region, Hub Code and contacts', () => {
  const {service, db} = setup();
  const list = service.list();
  assert.equal(list.length, 100);
  const first = list.find(h => h.id === 'XH-001');
  assert.equal(first.name, 'AMP_BlackBridge');
  assert.equal(first.code, 'AMP_BlackBridge');
  assert.equal(first.pod, 'POD_AP/TS');
  assert.equal(first.region, 'East');
  assert.equal(first.hiName, 'Vipparthi Prema Kiran');
  assert.deepEqual(first.contacts, [{name: 'Vipparthi Prema Kiran', phone: '9014377900'}]);
  const messy = list.find(h => h.id === 'XH-017');
  assert.equal(messy.phone, '9435692178, 7396500168', 'existing messy phone kept as saved');
  assert.equal(messy.contacts.length, 2);
  // a second start does not add the seed again
  const again = createHubService({db, seedRows: SEED});
  assert.equal(again.list().length, 100);
});

test('a hub deleted by an admin stays deleted after the server restarts', () => {
  const {service, db} = setup();
  service.remove('XH-001', 'a');
  const restarted = createHubService({db, seedRows: SEED});
  assert.equal(restarted.get('XH-001'), null);
  assert.equal(restarted.list().length, 99);
});

test('new hubs get ids after the existing ones', () => {
  const {service} = setup();
  assert.equal(service.create(validHub({name: 'Brand New'}), 'a').id, 'XH-101');
});

// ---------- import ----------
const row = (over = {}) => ({
  hiName: '', phone: '', name: '', location: '', address: '', pincode: '', city: '', district: '', state: '',
  contactNumber: '', email: '', manager: '', openingDate: '', status: '', url: '', code: '', pod: '', region: '',
  contacts: [], notes: [], ...over,
});

test('import preview writes nothing; commit adds the new hubs', () => {
  const {service} = setup();
  const before = service.list().length;
  const rows = [
    row({name: 'Import Hub 1', state: 'Andhra Pradesh', city: 'Vijayawada', phone: '9876543210', hiName: 'A B', rowNumber: 2}),
    row({name: 'Import Hub 2', state: 'Telangana', openingDate: '01/06/2025', status: 'Inactive', rowNumber: 3}),
  ];
  const preview = service.importRows(rows, {dryRun: true, fileName: 'master.xlsx'});
  assert.equal(preview.counts.new, 2);
  assert.equal(service.list().length, before, 'preview saved nothing');
  const committed = service.importRows(rows, {dryRun: false, actor: 'admin@test', fileName: 'master.xlsx'});
  assert.equal(committed.counts.new, 2);
  assert.equal(service.list().length, before + 2);
  const hub2 = service.list().find(h => h.name === 'Import Hub 2');
  assert.equal(hub2.openingDate, '2025-06-01');
  assert.equal(hub2.status, 'Inactive');
});

test('import: a row with errors is reported with messages while the valid rows still import', () => {
  const {service} = setup();
  const report = service.importRows([
    row({name: 'Good Hub', state: 'Kerala', rowNumber: 2}),
    row({name: 'Bad Phone Hub', state: 'Kerala', phone: '12345', rowNumber: 3}),
    row({name: 'No State Hub', state: '', rowNumber: 4}),
    row({name: 'Bad URL Hub', state: 'Kerala', url: 'hub-site', rowNumber: 5}),
  ], {dryRun: false, actor: 'a'});
  assert.equal(report.counts.new, 1);
  assert.equal(report.counts.error, 3);
  const bad = report.rows.find(r => r.name === 'Bad Phone Hub');
  assert.equal(bad.status, 'error');
  assert.match(bad.messages[0], /Phone Number/);
  assert.match(report.rows.find(r => r.name === 'No State Hub').messages[0], /State is required/);
  assert.ok(service.list().find(h => h.name === 'Good Hub'));
  assert.equal(service.list().find(h => h.name === 'Bad Phone Hub'), undefined);
});

test('import: a hub that already exists is never overwritten; blanks are filled and differences reported', () => {
  const {service} = setup();
  // XH-001 "AMP_BlackBridge" has manager and phone, but no pincode, location or email.
  const report = service.importRows([row({
    name: 'amp_blackbridge', state: 'Andhra Pradesh', phone: '9999999999', pincode: '533201', email: 'amp@example.com',
    manager: 'Someone Else', rowNumber: 2,
  })], {dryRun: false, actor: 'a'});
  assert.equal(report.counts.update, 1);
  const r = report.rows[0];
  assert.match(r.messages[0], /fill blank fields: Hub Pincode, Hub Email ID/);
  assert.deepEqual(r.conflicts.map(c => c.field).sort(), ['manager', 'phone']);
  const saved = service.get('XH-001');
  assert.equal(saved.pincode, '533201', 'blank field filled');
  assert.equal(saved.email, 'amp@example.com', 'blank field filled');
  assert.equal(saved.phone, '9014377900', 'existing phone kept');
  assert.equal(saved.manager, 'Vipparthi Prema Kiran', 'existing manager kept');
});

test('import: an existing hub with nothing new is reported as already in the system', () => {
  const {service} = setup();
  const report = service.importRows([row({name: 'AMP_BlackBridge', state: 'Andhra Pradesh', rowNumber: 2})], {dryRun: false, actor: 'a'});
  assert.equal(report.counts.existing, 1);
  assert.equal(report.rows[0].status, 'existing');
});

test('import: the same Hub Name twice in one file imports only the first row', () => {
  const {service} = setup();
  const report = service.importRows([
    row({name: 'Twin Hub', state: 'Odisha', city: 'Bhubaneswar', rowNumber: 2}),
    row({name: 'TWIN   hub', state: 'Odisha', city: 'Cuttack', rowNumber: 3}),
  ], {dryRun: false, actor: 'a'});
  assert.equal(report.counts.new, 1);
  assert.equal(report.counts.duplicate, 1);
  assert.match(report.rows[1].messages[0], /Row 2/);
  assert.equal(service.list().find(h => h.name === 'Twin Hub').city, 'Bhubaneswar');
});

test('import: a file with only Hub Code uses it as the Hub Name', () => {
  const {service} = setup();
  service.importRows([row({code: 'CODE_ONLY_HUB', state: 'Assam', rowNumber: 2})], {dryRun: false, actor: 'a'});
  assert.ok(service.list().find(h => h.name === 'CODE_ONLY_HUB'));
});

test('import: legacy Hub Code, POD and Region are stored, not discarded', () => {
  const {service} = setup();
  service.importRows([row({name: 'Legacy Cols Hub', state: 'Assam', code: 'LCH-9', pod: 'POD_NE', region: 'North', rowNumber: 2})],
    {dryRun: false, actor: 'a'});
  const hub = service.list().find(h => h.name === 'Legacy Cols Hub');
  assert.equal(hub.code, 'LCH-9');
  assert.equal(hub.pod, 'POD_NE');
  assert.equal(hub.region, 'North');
});

test('import: an empty file and a file over the row limit are refused', () => {
  const {service} = setup();
  expectError(() => service.importRows([], {dryRun: true}), 400);
  const big = Array.from({length: MAX_IMPORT_ROWS + 1}, (_, i) => row({name: `Hub ${i}`, state: 'X'}));
  expectError(() => service.importRows(big, {dryRun: true}), 400);
});

test('browser migration: older records are accepted as saved, even where a strict rule would reject them', () => {
  const {service} = setup({seed: []});
  const report = service.importRows([{
    rowNumber: 1, name: 'Old Browser Hub', state: '', phone: '93903333935', pincode: '', code: 'HUB-OLD',
    contacts: [{name: 'Old Contact', phone: '93903333935'}], notes: [{text: 'Old note', vacancies: 1, date: '2026-01-02'}],
  }], {source: 'browser', dryRun: false, actor: 'a'});
  assert.equal(report.counts.new, 1);
  const hub = service.list().find(h => h.name === 'Old Browser Hub');
  assert.equal(hub.phone, '93903333935');
  assert.equal(hub.code, 'HUB-OLD');
  assert.equal(hub.contacts[0].name, 'Old Contact');
  assert.equal(hub.notes[0].text, 'Old note');
});

test('browser migration of a hub that already exists adds only its extra contacts and notes', () => {
  const {service} = setup();
  const report = service.importRows([{
    rowNumber: 1, name: 'AMP_BlackBridge', state: 'Andhra Pradesh', phone: '9014377900',
    contacts: [{name: 'Extra Person', phone: '9000012345'}], notes: [{text: 'Pump issue', vacancies: 0, date: '2026-02-02'}],
  }], {source: 'browser', dryRun: false, actor: 'a'});
  assert.equal(report.counts.update, 1);
  const saved = service.get('XH-001');
  assert.equal(saved.contacts.length, 2);
  assert.equal(saved.notes.length, 1);
  assert.equal(saved.phone, '9014377900');
});

// ---------- HTTP routes (through a small stand-in for the web framework) ----------
function fakeApp() {
  const routes = [];
  const add = method => (route, ...handlers) => routes.push({method, route, handlers: handlers.flat()});
  return {routes, get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE')};
}
function call(app, method, url, body) {
  const pathOnly = url.split('?')[0];
  for (const r of app.routes) {
    if (r.method !== method) continue;
    const names = [], rx = new RegExp('^' + r.route.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const m = pathOnly.match(rx);
    if (!m) continue;
    const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const req = {params, body, adminEmail: 'admin@test', query: {}};
    const res = {statusCode: 200, body: undefined,
      status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }};
    const [guard, handler] = r.handlers;
    let passed = false;
    guard(req, res, () => { passed = true; });
    if (!passed) return res;
    handler(req, res);
    return res;
  }
  throw new Error(`no route ${method} ${url}`);
}

test('routes: create, list, edit one field, notes, delete, and error responses', () => {
  const {service} = setup();
  const app = fakeApp();
  registerHubRoutes(app, {guard: (req, res, next) => next(), service});

  const created = call(app, 'POST', '/api/admin/hubs', validHub({name: 'Route Hub'}));
  assert.equal(created.statusCode, 201);
  const id = created.body.hub.id;

  assert.equal(call(app, 'POST', '/api/admin/hubs', validHub({name: 'Route Hub'})).statusCode, 409);
  const badPin = call(app, 'POST', '/api/admin/hubs', validHub({name: 'Pin Hub', pincode: '12'}));
  assert.equal(badPin.statusCode, 400);
  assert.equal(badPin.body.field, 'pincode');

  const listed = call(app, 'GET', '/api/admin/hubs');
  assert.equal(listed.body.hubs.length, 101);

  const edited = call(app, 'PATCH', `/api/admin/hubs/${id}`, {phone: '9111111111'});
  assert.equal(edited.body.hub.phone, '9111111111');
  assert.deepEqual(edited.body.changed, ['phone']);
  assert.equal(call(app, 'PATCH', '/api/admin/hubs/XH-404', {phone: '9111111111'}).statusCode, 404);

  const note = call(app, 'POST', `/api/admin/hubs/${id}/notes`, {text: 'Road closed', vacancies: 1});
  assert.equal(note.body.hub.notes.length, 1);

  assert.equal(call(app, 'DELETE', `/api/admin/hubs/${id}`).statusCode, 200);
  assert.equal(call(app, 'DELETE', `/api/admin/hubs/${id}`).statusCode, 404);
});

test('routes: import defaults to a preview, and writes only when dryRun is false', () => {
  const {service} = setup();
  const app = fakeApp();
  registerHubRoutes(app, {guard: (req, res, next) => next(), service});
  const rows = [row({name: 'Route Import', state: 'Goa', rowNumber: 2})];
  const preview = call(app, 'POST', '/api/admin/hubs/import', {rows, fileName: 'x.csv'});
  assert.equal(preview.body.report.dryRun, true);
  assert.equal(service.get('XH-101'), null);
  const commit = call(app, 'POST', '/api/admin/hubs/import', {rows, fileName: 'x.csv', dryRun: false});
  assert.equal(commit.body.report.counts.new, 1);
  assert.ok(service.list().find(h => h.name === 'Route Import'));
  assert.equal(call(app, 'POST', '/api/admin/hubs/import', {rows: []}).statusCode, 400);
});

test('routes: a request that fails the admin guard never reaches the hub code', () => {
  const {service} = setup();
  const app = fakeApp();
  registerHubRoutes(app, {guard: (req, res) => res.status(401).json({error: 'sign in'}), service});
  const res = call(app, 'GET', '/api/admin/hubs');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.hubs, undefined);
});
