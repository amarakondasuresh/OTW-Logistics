// Run with:  node --test --no-warnings test/admin-documents.test.mjs   (from the backend folder)
// Admin Portal > Documents: files are stored privately on the server, checked by content, linked to one Rider ID,
// listed for every admin, replaced, viewed and deleted with an audit entry. Existing records are never lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAdminDocumentService, AdminDocumentError, DOC_TYPES, LEGACY_DOC_TYPES} from '../admin-documents.js';

const jpeg = (tag = 1) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(300, tag)]);
const png = (tag = 2) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(300, tag)]);
const pdf = (tag = 4) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, tag)]);
const doc = (buffer, originalname) => ({buffer, originalname});

function setup(db = new DatabaseSync(':memory:')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otw-docs-'));
  const log = [];
  const svc = createAdminDocumentService({db, uploadDir: dir, audit: (who, action, details) => log.push({who, action, details})});
  return {dir, db, svc, log};
}
const expectError = (fn, status, re) => assert.throws(fn, e => e instanceof AdminDocumentError && e.status === status && (!re || re.test(e.message)));
const fileExists = (dir, stored) => fs.existsSync(path.join(dir, 'admin-documents', stored));

test('the document list is the seven requested types; legacy types are kept only for old records', () => {
  assert.deepEqual([...DOC_TYPES], ['Aadhaar / ID Proof', 'PAN Card', 'Driving Licence', 'Bank Passbook', 'RC Book', 'Insurance Document', 'Other Documents']);
  assert.ok(LEGACY_DOC_TYPES.includes('PAN') && !DOC_TYPES.includes('PAN'));
});

test('a document and a selfie are stored privately and linked to the rider ID', () => {
  const s = setup();
  const r = s.svc.add('admin1@x.in', {riderId: 'WL 001', riderName: 'Appari Ravi Kumar', type: 'PAN Card'},
    {document: doc(pdf(), 'pan card.pdf'), selfie: doc(png(), 'selfie.png')});
  assert.equal(r.duplicate, false);
  const item = r.item;
  assert.equal(item.riderId, 'WL001', 'rider ID is stored without spaces');
  assert.equal(item.type, 'PAN Card');
  assert.equal(item.name, 'pan card.pdf');
  assert.equal(item.selfie.name, 'selfie.png');
  assert.equal(item.selfie.mime, 'image/png');
  const f = s.svc.fileOf('admin2@x.in', item.id);
  assert.ok(f.path.startsWith(path.join(s.dir, 'admin-documents')));
  assert.deepEqual(fs.readFileSync(f.path), pdf());
  const sf = s.svc.fileOf('admin2@x.in', item.id, 'selfie');
  assert.deepEqual(fs.readFileSync(sf.path), png());
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(s.log.map(x => x.action), ['rider_document_uploaded', 'rider_document_viewed', 'rider_selfie_viewed']);
});

test('the selfie is optional; a document alone works and the selfie field is empty', () => {
  const s = setup();
  const {item} = s.svc.add('a', {riderId: 'R1', type: 'Bank Passbook'}, {document: doc(jpeg(), 'passbook.jpg')});
  assert.equal(item.selfie, null);
  expectError(() => s.svc.fileOf('a', item.id, 'selfie'), 404, /no selfie/);
});

test('the document is required and the selfie accepts images only', () => {
  const s = setup();
  expectError(() => s.svc.add('a', {riderId: '', type: 'PAN Card'}, {document: doc(pdf(), 'x.pdf')}), 400, /rider/);
  expectError(() => s.svc.add('a', {riderId: 'R1', type: 'Passport'}, {document: doc(pdf(), 'x.pdf')}), 400, /document type/);
  expectError(() => s.svc.add('a', {riderId: 'R1', type: 'PAN Card'}, {}), 400, /Choose a document file/);
  expectError(() => s.svc.add('a', {riderId: 'R1', type: 'PAN Card'}, {document: doc(pdf(), 'x.pdf'), selfie: doc(pdf(), 'x.pdf')}), 400, /Selfie.*JPG, JPEG, PNG or WEBP/);
  assert.equal(s.svc.list().length, 0);
});

test('files are checked by content, extension and size; a renamed program is refused', () => {
  const s = setup();
  expectError(() => s.svc.add('a', {riderId: 'R1', type: 'PAN Card'}, {document: doc(Buffer.from('MZ fake'), 'x.jpg')}), 400, /JPG, JPEG, PNG, WEBP or PDF/);
  expectError(() => s.svc.add('a', {riderId: 'R1', type: 'PAN Card'}, {document: doc(jpeg(), 'x.gif')}), 400, /must be a JPG/);
});

test('a file larger than 5 MB is refused for the document and for the selfie', () => {
  const s = setup();
  const big = Buffer.concat([jpeg(), Buffer.alloc(5 * 1024 * 1024)]);
  expectError(() => s.svc.add('a', {riderId: 'R1', type: 'PAN Card'}, {document: doc(big, 'big.jpg')}), 400, /5 MB/);
  expectError(() => s.svc.add('a', {riderId: 'R1', type: 'PAN Card'}, {document: doc(jpeg(), 'ok.jpg'), selfie: doc(big, 'big.png')}), 400, /5 MB/);
  assert.equal(s.svc.list().length, 0);
});

test('the same document cannot be uploaded twice for one rider, but another rider can have it', () => {
  const s = setup();
  s.svc.add('a', {riderId: 'R1', type: 'RC Book'}, {document: doc(jpeg(7), 'rc.jpg')});
  expectError(() => s.svc.add('a', {riderId: 'R1', type: 'RC Book'}, {document: doc(jpeg(7), 'rc copy.jpg')}), 409, /already uploaded/);
  s.svc.add('a', {riderId: 'R2', type: 'RC Book'}, {document: doc(jpeg(7), 'rc.jpg')});
  s.svc.add('a', {riderId: 'R1', type: 'Insurance Document'}, {document: doc(jpeg(7), 'rc.jpg')});
  assert.equal(s.svc.list().length, 3);
});

test('a repeated submission with the same submissionId returns the first record, not a second one', () => {
  const s = setup();
  const first = s.svc.add('a', {riderId: 'R1', type: 'PAN Card', submissionId: 'sub-abcdef12'}, {document: doc(pdf(9), 'pan.pdf')});
  const again = s.svc.add('a', {riderId: 'R1', type: 'PAN Card', submissionId: 'sub-abcdef12'}, {document: doc(pdf(9), 'pan.pdf')});
  assert.equal(again.duplicate, true);
  assert.equal(again.item.id, first.item.id);
  assert.equal(s.svc.list().length, 1);
});

test('a file name cannot climb out of the upload folder', () => {
  const s = setup();
  const {item} = s.svc.add('a', {riderId: 'R1', type: 'Other Documents'}, {document: doc(jpeg(), '../../etc/passwd.jpg')});
  assert.equal(item.name, 'passwd.jpg');
  assert.ok(s.svc.fileOf('a', item.id).path.startsWith(path.join(s.dir, 'admin-documents')));
});

test('replacing the document keeps the selfie and removes the old file only after saving', () => {
  const s = setup();
  const {item} = s.svc.add('a', {riderId: 'R1', type: 'PAN Card'}, {document: doc(pdf(1), 'old.pdf'), selfie: doc(png(3), 'me.png')});
  const oldFile = s.svc.fileOf('a', item.id).path;
  const updated = s.svc.replace('b', item.id, {}, {document: doc(jpeg(5), 'new.jpg')});
  assert.equal(updated.name, 'new.jpg');
  assert.equal(updated.type, 'PAN Card');
  assert.equal(updated.selfie.name, 'me.png', 'selfie is kept');
  assert.equal(fs.existsSync(oldFile), false, 'old document file removed');
  assert.equal(s.log.at(-1).action, 'rider_document_replaced');
  assert.deepEqual(fs.readFileSync(s.svc.fileOf('b', item.id).path), jpeg(5));
});

test('replacing only the selfie or only the document type keeps the document file', () => {
  const s = setup();
  const {item} = s.svc.add('a', {riderId: 'R1', type: 'PAN Card'}, {document: doc(pdf(1), 'pan.pdf')});
  const withSelfie = s.svc.replace('a', item.id, {}, {selfie: doc(jpeg(2), 'me.jpg')});
  assert.equal(withSelfie.name, 'pan.pdf');
  assert.equal(withSelfie.selfie.name, 'me.jpg');
  const retyped = s.svc.replace('a', item.id, {type: 'Driving Licence'}, {});
  assert.equal(retyped.type, 'Driving Licence');
  assert.equal(retyped.name, 'pan.pdf');
  expectError(() => s.svc.replace('a', item.id, {type: 'PAN'}, {}), 400, /document type/);
});

test('a replacement that would duplicate another record of the rider is refused; an empty replace is refused', () => {
  const s = setup();
  s.svc.add('a', {riderId: 'R1', type: 'RC Book'}, {document: doc(jpeg(8), 'rc.jpg')});
  const {item} = s.svc.add('a', {riderId: 'R1', type: 'Insurance Document'}, {document: doc(jpeg(9), 'ins.jpg')});
  // Same content as the RC record of this rider -> duplicate; different content -> allowed.
  expectError(() => s.svc.replace('a', item.id, {type: 'RC Book'}, {document: doc(jpeg(8), 'copy.jpg')}), 409, /already uploaded/);
  assert.equal(s.svc.replace('a', item.id, {type: 'RC Book'}, {document: doc(jpeg(10), 'other.jpg')}).type, 'RC Book');
  expectError(() => s.svc.replace('a', item.id, {}, {}), 400, /Choose a new file/);
  expectError(() => s.svc.replace('a', 'missing', {}, {document: doc(jpeg(), 'x.jpg')}), 404);
});

test('deleting removes the record, the document file and the selfie; unknown documents give 404', () => {
  const s = setup();
  const {item} = s.svc.add('a', {riderId: 'R1', type: 'RC Book'}, {document: doc(jpeg(), 'rc.jpg'), selfie: doc(png(), 'me.png')});
  const file = s.svc.fileOf('a', item.id).path;
  const selfieFile = s.svc.fileOf('a', item.id, 'selfie').path;
  s.svc.remove('a', item.id);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(selfieFile), false);
  assert.equal(s.svc.list().length, 0);
  expectError(() => s.svc.fileOf('a', item.id), 404);
  expectError(() => s.svc.remove('a', item.id), 404);
  assert.equal(s.log.at(-1).action, 'rider_document_deleted');
});

test('an earlier database keeps every record and gets the new columns without losing data', () => {
  const db = new DatabaseSync(':memory:');
  // The table as the earlier version created it.
  db.exec(`CREATE TABLE admin_rider_documents(id TEXT PRIMARY KEY, rider_id TEXT NOT NULL, rider_name TEXT NOT NULL DEFAULT '',
    doc_type TEXT NOT NULL, original_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, stored_name TEXT NOT NULL,
    uploaded_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
  db.prepare("INSERT INTO admin_rider_documents VALUES('old-1','R9','Old Rider','PAN','pan.pdf','application/pdf',300,'old-1.pdf','a','2026-01-02T00:00:00.000Z')").run();
  const s = setup(db);
  const list = s.svc.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'PAN', 'legacy type is shown as saved');
  assert.equal(list[0].selfie, null);
  const {item} = s.svc.add('a', {riderId: 'R9', type: 'PAN Card'}, {document: doc(pdf(6), 'new.pdf')});
  assert.equal(s.svc.list().length, 2);
  assert.ok(item.id);
});
