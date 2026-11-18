// Run with:  node --test --no-warnings test/drive-sync.test.mjs   (from the backend folder)
// Google's API is replaced by a fake that answers the same URLs. The Excel files are the real fixtures, read by the
// same reader the browser and the server use, and saved by the same weekly-payments.js rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createWeeklyPaymentService} from '../weekly-payments.js';
import {createDriveSyncService, DriveSyncError} from '../drive-sync.js';

const require = createRequire(import.meta.url);
const PX = require('../../dashboard/payment-excel.js');
const grids = JSON.parse(fs.readFileSync(new URL('./fixtures/grids.json', import.meta.url), 'utf8'));

const FOLDER = 'FOLDER_abcdefghij12345';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ENV = {GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', DRIVE_TOKEN_SECRET: 'test-secret-0123456789'};
const ADMIN = 'admin@example.com', BASE = 'http://localhost:8080';
const REFRESH = 'REFRESH-TOKEN-SECRET-VALUE';

// A fake Google Drive. drive.contents maps a file id to a fixture name (optionally "name|bump" to change one amount).
function fakeGoogle() {
  const g = {files: [], contents: {}, calls: [], refreshCalls: 0, grantedRefresh: REFRESH, failRefresh: false, revoked: false};
  const json = o => ({ok: true, status: 200, json: async () => o, arrayBuffer: async () => new ArrayBuffer(0)});
  g.fetch = async (url, opts = {}) => {
    const u = String(url);
    g.calls.push(u);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(opts.body);
      if (p.get('grant_type') === 'authorization_code') return json({access_token: 'AT-first', refresh_token: REFRESH, expires_in: 3600});
      g.refreshCalls++;
      if (g.failRefresh || p.get('refresh_token') !== g.grantedRefresh) return {ok: false, status: 400, json: async () => ({error: 'invalid_grant'})};
      return json({access_token: 'AT-refreshed', expires_in: 3600});
    }
    if (u.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
    if (u.includes('/about?')) return json({user: {emailAddress: 'payments.drive@example.com'}});
    if (u.includes('alt=media')) {
      const id = u.match(/files\/([^?]+)/)[1];
      const bytes = Buffer.from(g.contents[id] || '');
      return {ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => Uint8Array.from(bytes).buffer};
    }
    if (u.includes('/files?')) return g.revoked ? {ok: false, status: 401, json: async () => ({})} : json({files: g.files});
    if (u.includes(`/files/${FOLDER}?`)) return json({id: FOLDER, name: 'On The Way Logistics – Payments', mimeType: 'application/vnd.google-apps.folder'});
    return {ok: false, status: 404, json: async () => ({})};
  };
  return g;
}

// Reads the Excel bytes the fake Drive returns. "name|bump" adds 1 to the first record's amount (a changed sheet).
const parseWorkbook = buf => {
  const [name, bump] = Buffer.from(buf).toString().split('|');
  const parsed = PX.parseSheets(grids[name]);
  if (parsed.ok && bump) parsed.records[0].amount = Number(parsed.records[0].amount) + 1;
  return parsed;
};

function setup(google, env = ENV) {
  const db = new DatabaseSync(':memory:');
  const weeklyPayments = createWeeklyPaymentService({db});
  let t = Date.parse('2026-11-05T10:00:00Z');
  const svc = createDriveSyncService({db, weeklyPayments, parseWorkbook, fetchImpl: google.fetch, now: () => new Date(t).toISOString(), env});
  return {db, weeklyPayments, svc, tick: ms => { t += ms; }};
}

async function connect(svc, adminEmail = ADMIN) {
  const url = svc.connectUrl({adminEmail, baseUrl: BASE});
  const state = new URL(url).searchParams.get('state');
  await svc.completeConnect({code: 'AUTH-CODE', state, adminEmail, baseUrl: BASE});
}

const xlsxFile = (id, name, modifiedTime, md5 = 'md5-' + modifiedTime) => ({id, name, mimeType: XLSX, modifiedTime, md5Checksum: md5});

test('the Google sign-in link asks only for read-only Drive access and carries a one-time state', () => {
  const {svc} = setup(fakeGoogle());
  const url = new URL(svc.connectUrl({adminEmail: ADMIN, baseUrl: BASE}));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('redirect_uri'), BASE + '/api/admin/drive/callback');
  assert.ok(url.searchParams.get('state').length >= 30);
});

test('nothing can connect until the site owner sets the Google keys and the token secret', () => {
  assert.throws(() => setup(fakeGoogle(), {}).svc.connectUrl({adminEmail: ADMIN, baseUrl: BASE}),
    err => err instanceof DriveSyncError && err.status === 503 && /GOOGLE_CLIENT_ID/.test(err.message));
  assert.throws(() => setup(fakeGoogle(), {...ENV, DRIVE_TOKEN_SECRET: 'short'}).svc.connectUrl({adminEmail: ADMIN, baseUrl: BASE}),
    err => err.status === 503 && /DRIVE_TOKEN_SECRET/.test(err.message));
  assert.equal(setup(fakeGoogle(), {}).svc.status().configured, false);
});

test('a callback with a wrong, reused or other admin\'s state is refused', async () => {
  const google = fakeGoogle();
  const {svc} = setup(google);
  const stateFor = () => new URL(svc.connectUrl({adminEmail: ADMIN, baseUrl: BASE})).searchParams.get('state');
  await assert.rejects(svc.completeConnect({code: 'x', state: 'forged', adminEmail: ADMIN, baseUrl: BASE}), {status: 400});
  await assert.rejects(svc.completeConnect({code: 'x', state: stateFor(), adminEmail: 'someone.else@example.com', baseUrl: BASE}), {status: 400});
  const state = stateFor();
  await svc.completeConnect({code: 'x', state, adminEmail: ADMIN, baseUrl: BASE});
  await assert.rejects(svc.completeConnect({code: 'x', state, adminEmail: ADMIN, baseUrl: BASE}), {status: 400}, 'state is one use only');
});

test('the refresh token is stored encrypted and never appears in the status the browser receives', async () => {
  const google = fakeGoogle();
  const {db, svc} = setup(google);
  await connect(svc);
  const stored = db.prepare('SELECT refresh_token_enc FROM drive_settings WHERE id = 1').get().refresh_token_enc;
  assert.ok(stored && !stored.includes(REFRESH));
  const st = svc.status();
  assert.equal(st.connected, true);
  assert.equal(st.account, 'payments.drive@example.com');
  assert.ok(!JSON.stringify(st).includes(REFRESH));
});

test('a folder must be a real Drive folder, and its ID is checked before it is used', async () => {
  const google = fakeGoogle();
  const {svc} = setup(google);
  await connect(svc);
  await assert.rejects(svc.chooseFolder({folderId: 'bad id; drop', actor: ADMIN}), {status: 400});
  const folder = await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  assert.equal(folder.id, FOLDER);
  assert.equal(svc.status().folder.id, FOLDER);
});

test('first sync imports the Excel file through the same rules as a manual upload', async () => {
  const google = fakeGoogle();
  const {svc, weeklyPayments} = setup(google);
  google.files = [xlsxFile('F1', 'weekly-19oct.xlsx', '2026-10-26T10:00:00Z')];
  google.contents.F1 = 'weekly-19oct-25oct';
  await connect(svc);
  await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  const out = await svc.sync({trigger: 'manual', actor: ADMIN});
  assert.equal(out.status, 'synced');
  assert.equal(out.inserted, 5);
  assert.equal(weeklyPayments.list().records.length, 5);
  const st = svc.status();
  assert.equal(st.lastStatus, 'synced');
  assert.equal(st.files[0].status, 'synced');
  assert.equal(st.files[0].inserted, 5);
});

test('an unchanged file is not downloaded or imported again', async () => {
  const google = fakeGoogle();
  const {svc, weeklyPayments} = setup(google);
  google.files = [xlsxFile('F1', 'weekly-19oct.xlsx', '2026-10-26T10:00:00Z')];
  google.contents.F1 = 'weekly-19oct-25oct';
  await connect(svc);
  await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  await svc.sync({actor: ADMIN});
  const downloadsBefore = google.calls.filter(u => u.includes('alt=media')).length;
  const out = await svc.sync({actor: ADMIN});
  assert.equal(out.files[0].status, 'unchanged');
  assert.equal(out.synced, 0);
  assert.equal(google.calls.filter(u => u.includes('alt=media')).length, downloadsBefore);
  assert.equal(weeklyPayments.list().records.length, 5);
});

test('a changed sheet updates its existing rows instead of adding new ones', async () => {
  const google = fakeGoogle();
  const {svc, weeklyPayments} = setup(google);
  google.files = [xlsxFile('F1', 'weekly-19oct.xlsx', '2026-10-26T10:00:00Z')];
  google.contents.F1 = 'weekly-19oct-25oct';
  await connect(svc);
  await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  await svc.sync({actor: ADMIN});
  google.files = [xlsxFile('F1', 'weekly-19oct.xlsx', '2026-10-27T10:00:00Z')];
  google.contents.F1 = 'weekly-19oct-25oct|bump';
  const out = await svc.sync({actor: ADMIN});
  assert.equal(out.updated, 1);
  assert.equal(out.inserted, 0);
  assert.equal(weeklyPayments.list().records.length, 5);
});

test('a broken file is reported as failed and saved payment data is left exactly as it was', async () => {
  const google = fakeGoogle();
  const {svc, weeklyPayments} = setup(google);
  google.files = [xlsxFile('F1', 'weekly-19oct.xlsx', '2026-10-26T10:00:00Z'), xlsxFile('F2', 'notes.xlsx', '2026-10-27T10:00:00Z')];
  google.contents = {F1: 'weekly-19oct-25oct', F2: 'unreadable'};
  await connect(svc);
  await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  const out = await svc.sync({actor: ADMIN});
  assert.equal(out.status, 'failed');
  assert.equal(out.failed, 1);
  const bad = svc.status().files.find(f => f.fileId === 'F2');
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /No payment table/);
  assert.equal(svc.status().lastStatus, 'failed');
  assert.equal(weeklyPayments.list().records.length, 5, 'the good file is kept and the bad one added nothing');
});

test('after the file is fixed, the next sync picks it up', async () => {
  const google = fakeGoogle();
  const {svc, weeklyPayments} = setup(google);
  google.files = [xlsxFile('F2', 'notes.xlsx', '2026-10-27T10:00:00Z')];
  google.contents = {F2: 'unreadable'};
  await connect(svc);
  await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  await svc.sync({actor: ADMIN});
  google.files = [xlsxFile('F2', 'notes.xlsx', '2026-10-28T10:00:00Z')];
  google.contents = {F2: 'weekly-26oct-01nov'};
  const out = await svc.sync({actor: ADMIN});
  assert.equal(out.status, 'synced');
  assert.equal(weeklyPayments.list().records.length, 4);
});

test('an empty folder is reported as a failed sync with a clear message', async () => {
  const google = fakeGoogle();
  const {svc} = setup(google);
  await connect(svc);
  await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  const out = await svc.sync({actor: ADMIN});
  assert.equal(out.status, 'failed');
  assert.match(out.error, /No Excel/);
});

test('syncing before connecting or choosing a folder is refused', async () => {
  const google = fakeGoogle();
  const {svc} = setup(google);
  await assert.rejects(svc.sync({actor: ADMIN}), {status: 409});
  await connect(svc);
  await assert.rejects(svc.sync({actor: ADMIN}), {status: 409});
});

test('a revoked Google sign-in is reported and asks the admin to connect again', async () => {
  const google = fakeGoogle();
  const {svc} = setup(google);
  await connect(svc);
  await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  google.revoked = true;
  await assert.rejects(svc.sync({actor: ADMIN}), err => err.status === 401 && /Connect Google Drive again/.test(err.message));
  assert.equal(svc.status().lastStatus, 'failed');
});

test('a second Sync Now while one is running shares the same run', async () => {
  const google = fakeGoogle();
  const {svc} = setup(google);
  google.files = [xlsxFile('F1', 'weekly-19oct.xlsx', '2026-10-26T10:00:00Z')];
  google.contents.F1 = 'weekly-19oct-25oct';
  await connect(svc);
  await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  const [a, b] = await Promise.all([svc.sync({actor: ADMIN}), svc.sync({actor: ADMIN})]);
  assert.equal(a, b);
  assert.equal(google.calls.filter(u => u.includes('/files?') && u.includes('mimeType')).length, 1);
});

test('disconnect removes the stored token and folder, and revokes the Google access', async () => {
  const google = fakeGoogle();
  const {db, svc} = setup(google);
  await connect(svc);
  await svc.chooseFolder({folderId: FOLDER, actor: ADMIN});
  await svc.disconnect({actor: ADMIN});
  const s = db.prepare('SELECT refresh_token_enc, folder_id FROM drive_settings WHERE id = 1').get();
  assert.equal(s.refresh_token_enc, '');
  assert.equal(s.folder_id, '');
  assert.equal(svc.status().connected, false);
  assert.ok(google.calls.some(u => u.startsWith('https://oauth2.googleapis.com/revoke')));
});
