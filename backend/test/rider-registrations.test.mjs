// Run with:  node --test test/   (from the backend folder; uses Node's built-in test runner and SQLite)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  createRiderRegistrationService, validateRegistrationFields, checkDocuments, cleanMobile,
  normalizeRiderKey, sniffType, RegistrationError, REG_MAX_FILE_BYTES, REG_PORTALS, REG_DECIDER_ROLES,
} from '../rider-registrations.js';

// ---------- sample files (real headers, padded) ----------
const jpeg = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 1)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200, 2)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(200, 3)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 4)]);
const text = () => Buffer.from('this is not a picture at all, just text');

const validFields = (over = {}) => ({
  riderId: 'WL-28274601', riderName: 'Ravi Kumar', mobile: '+91 98765 43210',
  hubPincode: '522002', hubLocation: 'Guntur - Brodipet hub', ...over,
});
const validFiles = (over = {}) => ({
  selfie: {buffer: jpeg(), originalname: 'screenshot.jpg'},
  aadhaar: {buffer: pdf(), originalname: 'aadhaar card.pdf'},
  ...over,
});

const ADMIN = {role: 'admin', accountId: 'acc-admin', identity: 'admin@onthewaylogistics.in'};
const VENDOR_A = {role: 'vendor', accountId: 'acc-vendor-a', identity: 'VN-000001'};
const VENDOR_B = {role: 'vendor', accountId: 'acc-vendor-b', identity: 'VN-000002'};
const FRANCHISE = {role: 'franchise', accountId: 'acc-fr-a', identity: 'FP-000001', ownerName: 'Anantapur Franchise'};
const FRANCHISE_B = {role: 'franchise', accountId: 'acc-fr-b', identity: 'FP-000002', ownerName: 'Guntur Franchise'};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otw-reg-'));
  const db = new DatabaseSync(':memory:');
  const audits = [];
  let clock = 0;
  const service = createRiderRegistrationService({
    db, uploadDir: dir, audit: (who, action, details) => audits.push({who, action, details}),
    now: () => new Date(Date.UTC(2026, 9, 30, 10, 0, clock++)).toISOString(),
  });
  return {db, dir, service, audits};
}

function expectError(fn, status, field) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RegistrationError, `expected RegistrationError, got ${err && err.message}`);
    assert.equal(err.status, status, err.message);
    if (field !== undefined) assert.equal(err.field, field);
    return err;
  }
  assert.fail(`expected a ${status} error`);
}

// ---------- field and file rules ----------

test('mobile numbers: 10 digits starting 6-9, +91 and leading 0 accepted', () => {
  assert.equal(cleanMobile('+91 98765 43210'), '9876543210');
  assert.equal(cleanMobile('098765 43210'), '9876543210');
  assert.equal(cleanMobile('9876543210'), '9876543210');
  assert.equal(cleanMobile('5876543210'), '', 'must start with 6-9');
  assert.equal(cleanMobile('12345'), '');
  assert.equal(cleanMobile('98765abc10'), '', 'letters are not digits');
});

test('hub pincode must be 6 digits and not start with 0', () => {
  assert.equal(validateRegistrationFields(validFields({hubPincode: '522002'})).hubPincode, '522002');
  expectError(() => validateRegistrationFields(validFields({hubPincode: '052200'})), 400, 'hubPincode');
  expectError(() => validateRegistrationFields(validFields({hubPincode: '52200'})), 400, 'hubPincode');
  expectError(() => validateRegistrationFields(validFields({hubPincode: '52200A'})), 400, 'hubPincode');
});

test('rider name: letters only, no numbers; spaces collapsed', () => {
  assert.equal(validateRegistrationFields(validFields({riderName: '  Ravi   Kumar '})).riderName, 'Ravi Kumar');
  expectError(() => validateRegistrationFields(validFields({riderName: 'Ravi 2'})), 400, 'riderName');
  expectError(() => validateRegistrationFields(validFields({riderName: 'R@vi'})), 400, 'riderName');
  expectError(() => validateRegistrationFields(validFields({riderName: ''})), 400, 'riderName');
});

test('rider ID: letters, digits, dash, underscore, slash; no spaces; key ignores case and spaces', () => {
  expectError(() => validateRegistrationFields(validFields({riderId: 'WL 001'})), 400, 'riderId');
  expectError(() => validateRegistrationFields(validFields({riderId: 'W'})), 400, 'riderId');
  expectError(() => validateRegistrationFields(validFields({riderId: 'WL#1'})), 400, 'riderId');
  assert.equal(normalizeRiderKey(' wl 001 '), 'WL001');
  assert.equal(validateRegistrationFields(validFields({riderId: 'wl-001/a'})).riderKey, 'WL-001/A');
});

test('documents: both required, real type checked from the bytes, 5 MB limit', () => {
  expectError(() => checkDocuments({aadhaar: {buffer: pdf()}}), 400, 'selfie');
  expectError(() => checkDocuments({selfie: {buffer: jpeg()}}), 400, 'aadhaar');
  // a text file renamed .jpg is refused
  expectError(() => checkDocuments({selfie: {buffer: text(), originalname: 'x.jpg'}, aadhaar: {buffer: pdf()}}), 400, 'selfie');
  // a PDF is not accepted as the selfie
  expectError(() => checkDocuments({selfie: {buffer: pdf()}, aadhaar: {buffer: pdf()}}), 400, 'selfie');
  // too big
  const big = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(REG_MAX_FILE_BYTES)]);
  expectError(() => checkDocuments({selfie: {buffer: big}, aadhaar: {buffer: pdf()}}), 400, 'selfie');
  // all real types pass
  const ok = checkDocuments({selfie: {buffer: png(), originalname: 'a.png'}, aadhaar: {buffer: webp(), originalname: 'b.webp'}});
  assert.equal(ok.selfie.type, 'image/png');
  assert.equal(ok.aadhaar.type, 'image/webp');
  assert.equal(sniffType(pdf()), 'application/pdf');
});

// ---------- creating ----------

test('admin registration: saved as PENDING with an application ID, history and files', () => {
  const {service, dir, db, audits} = setup();
  const item = service.create(ADMIN, validFields(), validFiles());
  assert.equal(item.status, 'PENDING');
  assert.equal(item.applicationId, 'RM-000001');
  assert.equal(item.registrationSource, 'Admin');
  assert.equal(item.appliedBy, 'Admin');
  assert.equal(item.mobileNumber, '9876543210');
  assert.equal(item.selfie.type, 'image/jpeg');
  assert.equal(item.aadhaar.type, 'application/pdf');
  assert.equal(item.history.length, 1);
  assert.equal(item.history[0].toStatus, 'PENDING');
  assert.equal(item.history[0].actor, ADMIN.identity);

  const rows = db.prepare('SELECT selfie_path, aadhaar_path, owner_account_id FROM rider_registrations').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_account_id, null, 'admin registrations have no partner owner');
  for (const rel of [rows[0].selfie_path, rows[0].aadhaar_path]) {
    assert.ok(fs.existsSync(path.join(dir, rel)), 'file stored: ' + rel);
    assert.ok(!rel.startsWith('/') && !rel.includes('..'));
  }
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(dir, rows[0].aadhaar_path)).mode & 0o777;
    assert.equal(mode, 0o600, 'documents are readable by the owner only');
  }
  assert.ok(audits.some(a => a.action === 'rider_registration_created'));
});

test('application IDs count up and are never reused', () => {
  const {service} = setup();
  const a = service.create(ADMIN, validFields({riderId: 'WL1001'}), validFiles());
  const b = service.create(ADMIN, validFields({riderId: 'WL1002'}), validFiles());
  assert.equal(a.applicationId, 'RM-000001');
  assert.equal(b.applicationId, 'RM-000002');
});

test('vendor registrations are tagged with their source and owner', () => {
  const {service} = setup();
  const v = service.create(VENDOR_A, validFields({riderId: 'V1'}), validFiles());
  assert.equal(v.registrationSource, 'Vendor');
  assert.equal(v.ownerLoginId, 'VN-000001');
});

test('duplicate Rider ID is refused, nothing is saved, and the attempt files are removed', () => {
  const {service, dir, db} = setup();
  service.create(ADMIN, validFields({riderId: 'WL-1'}), validFiles());
  const before = fs.readdirSync(path.join(dir, 'registrations')).length;
  const err = expectError(
    () => service.create(VENDOR_A, validFields({riderId: ' wl-1 '}), validFiles()), 409, 'riderId');
  assert.match(err.message, /already registered/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rider_registrations').get().n, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'registrations')).length, before, 'no leftover folder from the refused attempt');
});

test('rider IDs are enforced by the database itself, not only by the code', () => {
  const {service, db} = setup();
  service.create(ADMIN, validFields({riderId: 'DB-1'}), validFiles());
  const sql = `INSERT INTO rider_registrations(id,application_id,rider_id,rider_key,rider_name,mobile_number,hub_pincode,hub_location,
      selfie_path,selfie_name,selfie_type,selfie_size,aadhaar_path,aadhaar_name,aadhaar_type,aadhaar_size,registration_source,
      created_by,application_status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  assert.throws(() => db.prepare(sql).run('x1', 'RM-X1', 'db-1', 'DB-1', 'N', '9876543210', '522002', 'H',
    'p', 'p', 'image/png', 1, 'p', 'p', 'application/pdf', 1, 'Admin', 'a', 'PENDING', 'now', 'now'), /UNIQUE constraint failed/);
  // a REJECTED row does not block the same rider ID
  db.prepare("UPDATE rider_registrations SET application_status='REJECTED', rejection_remarks='r'").run();
  assert.doesNotThrow(() => db.prepare(sql).run('x2', 'RM-X2', 'db-1', 'DB-1', 'N', '9876543210', '522002', 'H',
    'p', 'p', 'image/png', 1, 'p', 'p', 'application/pdf', 1, 'Admin', 'a', 'PENDING', 'now', 'now'));
});

test('invalid submissions are refused and leave no record behind', () => {
  const {service, db, dir} = setup();
  expectError(() => service.create(ADMIN, validFields({mobile: '1234567890'}), validFiles()), 400, 'mobile');
  expectError(() => service.create(ADMIN, validFields(), validFiles({aadhaar: undefined})), 400, 'aadhaar');
  expectError(() => service.create({role: 'nobody', identity: 'x'}, validFields(), validFiles()), 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rider_registrations').get().n, 0);
  assert.equal(fs.existsSync(path.join(dir, 'registrations')) ? fs.readdirSync(path.join(dir, 'registrations')).length : 0, 0);
});

// ---------- portal separation ----------

test('the Admin, Vendor and Franchise portals may use rider applications; only admin and vendor may decide', () => {
  assert.deepEqual(REG_PORTALS, ['admin', 'vendor', 'franchise']);
  assert.deepEqual(REG_DECIDER_ROLES, ['admin', 'vendor']);
});

test('a franchise submits its own riders and sees only its own', () => {
  const {service} = setup();
  const admin = service.create(ADMIN, validFields({riderId: 'A1'}), validFiles());
  const mine = service.create(FRANCHISE, validFields({riderId: 'FR1'}), validFiles());
  service.create(FRANCHISE_B, validFields({riderId: 'FR2'}), validFiles());

  assert.equal(mine.registrationSource, 'Franchise');
  assert.equal(mine.ownerLoginId, 'FP-000001', 'associated with the franchise ID');
  assert.equal(mine.ownerName, 'Anantapur Franchise');
  assert.equal(mine.status, 'PENDING');
  assert.deepEqual(service.list(FRANCHISE).map(x => x.riderId), ['FR1']);
  expectError(() => service.get(FRANCHISE, admin.id), 404);
  expectError(() => service.fileFor(FRANCHISE, admin.id, 'aadhaar'), 404);
  assert.equal(service.fileFor(FRANCHISE, mine.id, 'selfie').type, 'image/jpeg');
});

test('a franchise cannot approve or reject anything, including its own riders', () => {
  const {service} = setup();
  const mine = service.create(FRANCHISE, validFields({riderId: 'FR3'}), validFiles());
  const admin = service.create(ADMIN, validFields({riderId: 'A3'}), validFiles());
  expectError(() => service.setStatus(FRANCHISE, mine.id, {status: 'APPROVED'}), 403);
  expectError(() => service.setStatus(FRANCHISE, mine.id, {status: 'REJECTED', remarks: 'x'}), 403);
  expectError(() => service.setStatus(FRANCHISE, admin.id, {status: 'APPROVED'}), 403);
  assert.equal(service.get(ADMIN, mine.id).status, 'PENDING');
});

test('admin approval and rejection with remarks reach the franchise; the approver is shown as On The Way Logistics', () => {
  const {service} = setup();
  const ok = service.create(FRANCHISE, validFields({riderId: 'FR4'}), validFiles());
  const bad = service.create(FRANCHISE, validFields({riderId: 'FR5'}), validFiles());

  service.setStatus(ADMIN, ok.id, {status: 'APPROVED', remarks: 'Aadhaar matches'});
  service.setStatus(ADMIN, bad.id, {status: 'REJECTED', remarks: 'Selfie is not clear'});

  const seenOk = service.get(FRANCHISE, ok.id);
  assert.equal(seenOk.status, 'APPROVED');
  assert.equal(seenOk.decisionRemarks, 'Aadhaar matches', 'approval remarks are saved and shown');
  assert.equal(seenOk.approvedBy, 'On The Way Logistics', 'admin login is not exposed to the franchise');
  assert.ok(seenOk.approvalDate);
  assert.equal(seenOk.history.at(-1).actor, 'On The Way Logistics');

  const seenBad = service.list(FRANCHISE).find(x => x.id === bad.id);
  assert.equal(seenBad.status, 'REJECTED');
  assert.equal(seenBad.rejectionRemarks, 'Selfie is not clear');
  assert.equal(seenBad.decisionRemarks, 'Selfie is not clear');

  // The admin still sees the real approver.
  assert.equal(service.get(ADMIN, ok.id).approvedBy, ADMIN.identity);
});

test('a franchise rider ID can be registered again only after the earlier one is rejected', () => {
  const {service} = setup();
  service.create(FRANCHISE, validFields({riderId: 'FR6'}), validFiles());
  expectError(() => service.create(FRANCHISE_B, validFields({riderId: 'fr6'}), validFiles()), 409, 'riderId');
  const again = service.list(FRANCHISE)[0];
  service.setStatus(ADMIN, again.id, {status: 'REJECTED', remarks: 'duplicate photo'});
  const retry = service.create(FRANCHISE_B, validFields({riderId: 'FR6'}), validFiles());
  assert.equal(retry.ownerLoginId, 'FP-000002');
});

test('a database created before the franchise columns existed is upgraded without losing records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otw-old-'));
  const db = new DatabaseSync(':memory:');
  // The table as the vendor / admin version had it (no owner_name, no decision_remarks).
  db.exec(`CREATE TABLE rider_registrations(id TEXT PRIMARY KEY, application_id TEXT NOT NULL UNIQUE, rider_id TEXT NOT NULL,
    rider_key TEXT NOT NULL, rider_name TEXT NOT NULL, mobile_number TEXT NOT NULL, hub_pincode TEXT NOT NULL, hub_location TEXT NOT NULL,
    selfie_path TEXT NOT NULL, selfie_name TEXT NOT NULL, selfie_type TEXT NOT NULL, selfie_size INTEGER NOT NULL,
    aadhaar_path TEXT NOT NULL, aadhaar_name TEXT NOT NULL, aadhaar_type TEXT NOT NULL, aadhaar_size INTEGER NOT NULL,
    registration_source TEXT NOT NULL, owner_account_id TEXT, owner_login_id TEXT, created_by TEXT NOT NULL,
    application_status TEXT NOT NULL DEFAULT 'PENDING', rejection_remarks TEXT, approved_by TEXT, approval_date TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO rider_registrations VALUES('old-1','RM-000001','OLD1','OLD1','Old Rider','9876543210','522002','Guntur','p','s.jpg','image/jpeg',10,'q','a.pdf','application/pdf',10,'Vendor',NULL,'VN-000001','VN-000001','PENDING',NULL,NULL,NULL,'2026-01-01','2026-01-01');`);
  const service = createRiderRegistrationService({db, uploadDir: dir});
  const cols = db.prepare('PRAGMA table_info(rider_registrations)').all().map(c => c.name);
  assert.ok(cols.includes('owner_name') && cols.includes('decision_remarks'));
  const old = service.get(ADMIN, 'old-1');
  assert.equal(old.riderId, 'OLD1');
  assert.equal(old.ownerName, '');
  assert.equal(old.decisionRemarks, '');
});

test('each portal sees only its own registrations; admin sees all', () => {
  const {service} = setup();
  service.create(ADMIN, validFields({riderId: 'A1'}), validFiles());
  const va = service.create(VENDOR_A, validFields({riderId: 'VA1'}), validFiles());
  service.create(VENDOR_B, validFields({riderId: 'VB1'}), validFiles());

  assert.equal(service.list(ADMIN).length, 3);
  assert.deepEqual(service.list(VENDOR_A).map(x => x.id), [va.id]);
  assert.equal(service.list(VENDOR_B).length, 1);
  assert.equal(service.list(VENDOR_B)[0].riderId, 'VB1');
});

test("a vendor cannot open, decide on or download another vendor's rider", () => {
  const {service} = setup();
  const vb = service.create(VENDOR_B, validFields({riderId: 'VB9'}), validFiles());
  expectError(() => service.get(VENDOR_A, vb.id), 404);
  expectError(() => service.setStatus(VENDOR_A, vb.id, {status: 'REJECTED', remarks: 'no'}), 404);
  expectError(() => service.fileFor(VENDOR_A, vb.id, 'aadhaar'), 404);
  assert.equal(service.get(VENDOR_B, vb.id).status, 'PENDING');
});

test('a vendor can approve its own rider', () => {
  const {service} = setup();
  const v = service.create(VENDOR_A, validFields({riderId: 'VA2'}), validFiles());
  const done = service.setStatus(VENDOR_A, v.id, {status: 'approved'});
  assert.equal(done.status, 'APPROVED');
  assert.equal(done.approvedBy, VENDOR_A.identity);
  assert.ok(done.approvalDate);
});

test('legacy franchise records are kept: admin still sees and manages them; the owner franchise sees only its own', () => {
  const {service, db, dir} = setup();
  const legacy = service.create(ADMIN, validFields({riderId: 'LEG-1'}), validFiles());
  db.prepare("UPDATE rider_registrations SET registration_source='Franchise', owner_account_id='acc-fr-a', owner_login_id='FP-000001', created_by='FP-000001' WHERE id=?").run(legacy.id);
  const filesBefore = fs.readdirSync(path.join(dir, 'registrations', legacy.id)).sort();

  const seen = service.list(ADMIN).find(x => x.id === legacy.id);
  assert.ok(seen, 'admin sees the legacy record');
  assert.equal(seen.registrationSource, 'Franchise');
  assert.equal(seen.ownerLoginId, 'FP-000001');
  assert.equal(service.list(VENDOR_A).length, 0);
  assert.equal(service.get(FRANCHISE, legacy.id).id, legacy.id, 'its owner franchise sees it');
  expectError(() => service.get(FRANCHISE_B, legacy.id), 404);
  expectError(() => service.setStatus(FRANCHISE, legacy.id, {status: 'APPROVED'}), 403);

  const approved = service.setStatus(ADMIN, legacy.id, {status: 'APPROVED', remarks: 'checked'});
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.registrationSource, 'Franchise');
  assert.equal(approved.history.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'registrations', legacy.id)).sort(), filesBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rider_registrations').get().n, 1, 'no record deleted');
});

// ---------- approval workflow ----------

test('approve sets APPROVED with approver and date; history keeps every change', () => {
  const {service} = setup();
  const r = service.create(ADMIN, validFields({riderId: 'AP1'}), validFiles());
  const ok = service.setStatus(ADMIN, r.id, {status: 'APPROVED', remarks: 'documents verified'});
  assert.equal(ok.status, 'APPROVED');
  assert.equal(ok.approvedBy, ADMIN.identity);
  assert.equal(ok.rejectionRemarks, '');
  assert.deepEqual(ok.history.map(h => [h.fromStatus, h.toStatus]), [['', 'PENDING'], ['PENDING', 'APPROVED']]);
  assert.equal(ok.history[1].remarks, 'documents verified');
  expectError(() => service.setStatus(ADMIN, r.id, {status: 'APPROVED'}), 400);
});

test('rejection needs a reason and stores it; approval details are cleared', () => {
  const {service} = setup();
  const r = service.create(ADMIN, validFields({riderId: 'RJ1'}), validFiles());
  expectError(() => service.setStatus(ADMIN, r.id, {status: 'REJECTED', remarks: '   '}), 400, 'remarks');
  const rej = service.setStatus(ADMIN, r.id, {status: 'REJECTED', remarks: 'Aadhaar photo not readable'});
  assert.equal(rej.status, 'REJECTED');
  assert.equal(rej.rejectionRemarks, 'Aadhaar photo not readable');
  assert.equal(rej.approvedBy, '');
  assert.equal(rej.approvalDate, '');
  assert.equal(rej.history.at(-1).toStatus, 'REJECTED');
  assert.equal(rej.history.at(-1).actor, ADMIN.identity);
});

test('status must be one of the three values', () => {
  const {service} = setup();
  const r = service.create(ADMIN, validFields({riderId: 'ST1'}), validFiles());
  expectError(() => service.setStatus(ADMIN, r.id, {status: 'DONE'}), 400, 'status');
});

test('a rejected rider can be registered again; the old one cannot be re-approved while the new one is live', () => {
  const {service} = setup();
  const old = service.create(ADMIN, validFields({riderId: 'RE1'}), validFiles());
  service.setStatus(ADMIN, old.id, {status: 'REJECTED', remarks: 'wrong photo'});
  const fresh = service.create(VENDOR_A, validFields({riderId: 're1'}), validFiles());
  assert.equal(fresh.applicationId, 'RM-000002');
  const err = expectError(() => service.setStatus(ADMIN, old.id, {status: 'APPROVED'}), 409, 'status');
  assert.match(err.message, /already has a live application/);
  // once the new one is rejected, the old one can be approved
  service.setStatus(ADMIN, fresh.id, {status: 'REJECTED', remarks: 'duplicate'});
  assert.equal(service.setStatus(ADMIN, old.id, {status: 'APPROVED'}).status, 'APPROVED');
});

// ---------- documents ----------

test('documents are served only to people who may see the record; Aadhaar views are logged', () => {
  const {service, audits} = setup();
  const r = service.create(VENDOR_A, validFields({riderId: 'DOC1'}), validFiles());
  const selfie = service.fileFor(VENDOR_A, r.id, 'selfie');
  assert.equal(selfie.type, 'image/jpeg');
  assert.ok(fs.existsSync(selfie.path));
  service.fileFor(VENDOR_A, r.id, 'aadhaar');
  assert.ok(audits.some(a => a.action === 'rider_aadhaar_viewed' && a.who === VENDOR_A.identity));
  expectError(() => service.fileFor(VENDOR_B, r.id, 'aadhaar'), 404);
  expectError(() => service.fileFor(ADMIN, r.id, 'passport'), 404);
});

test('a stored path that points outside the uploads folder is never served', () => {
  const {service, db} = setup();
  const r = service.create(ADMIN, validFields({riderId: 'TRAV1'}), validFiles());
  db.prepare('UPDATE rider_registrations SET aadhaar_path = ? WHERE id = ?').run('../../../../etc/passwd', r.id);
  expectError(() => service.fileFor(ADMIN, r.id, 'aadhaar'), 404);
});

test('a missing document file reports a clear error instead of crashing', () => {
  const {service, dir} = setup();
  const r = service.create(ADMIN, validFields({riderId: 'MISS1'}), validFiles());
  fs.rmSync(path.join(dir, 'registrations', r.id), {recursive: true, force: true});
  expectError(() => service.fileFor(ADMIN, r.id, 'selfie'), 404);
});

test('approving or rejecting never removes uploaded documents', () => {
  const {service, dir} = setup();
  const r = service.create(ADMIN, validFields({riderId: 'KEEP1'}), validFiles());
  const before = fs.readdirSync(path.join(dir, 'registrations', r.id)).sort();
  service.setStatus(ADMIN, r.id, {status: 'REJECTED', remarks: 'x'});
  service.setStatus(ADMIN, r.id, {status: 'APPROVED'});
  assert.deepEqual(fs.readdirSync(path.join(dir, 'registrations', r.id)).sort(), before);
});


test('admin can edit an approved rider and keep existing documents when no replacement is uploaded', () => {
  const {service, dir, db, audits} = setup();
  const created = service.create(ADMIN, validFields({riderId:'WL-OLD01',riderName:'Appari Ravi Kumar'}), validFiles());
  const approved = service.setStatus(ADMIN, created.id, {status:'APPROVED',remarks:'Verified'});
  const updated = service.update(ADMIN, approved.id, validFields({
    riderId:'28050593', riderName:'Appari Ravi Kumar', mobile:'9908068749',
    hubPincode:'534260', hubLocation:'Palakollu',
  }), {});
  assert.equal(updated.status, 'APPROVED');
  assert.equal(updated.riderId, '28050593');
  assert.equal(updated.mobileNumber, '9908068749');
  assert.equal(updated.hubPincode, '534260');
  assert.equal(updated.selfie.name, 'screenshot.jpg');
  assert.equal(updated.aadhaar.name, 'aadhaar card.pdf');
  assert.ok(audits.some(a => a.action === 'rider_registration_updated'));
  fs.rmSync(dir, {recursive:true, force:true});
});

test('only admin can edit rider registration details', () => {
  const {service, dir} = setup();
  const created = service.create(ADMIN, validFields(), validFiles());
  expectError(() => service.update(VENDOR_A, created.id, validFields(), {}), 403);
  fs.rmSync(dir, {recursive:true, force:true});
});
