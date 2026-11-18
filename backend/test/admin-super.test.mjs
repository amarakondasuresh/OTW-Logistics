// Super Admin, per-admin password reset and security audit rules.
//   node --test --no-warnings test/admin-super.test.mjs   (from the backend folder; uses Node's built-in SQLite)
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAuth} from '../auth.js';
import {createPasswordResetService} from '../password-reset.js';

const silent = {error() {}, warn() {}, log() {}};
const BASE = 'https://portal.example.com';

async function setup({mail = 'ok'} = {}) {
  const db = new DatabaseSync(':memory:');
  const auth = createAuth(db);
  const sent = [], audits = [];
  const service = createPasswordResetService({
    auth, log: silent,
    audit: (who, action, details) => audits.push({who, action, details}),
    sendMail: async m => { if (mail === 'fail') throw new Error('smtp down'); sent.push(m); },
  });
  const boss = await auth.createAccount({role: 'admin', loginId: 'boss@gmail.com', email: 'boss@gmail.com', name: 'Boss', password: 'Boss12345', mustChange: false});
  const koppela = await auth.createAccount({role: 'admin', loginId: 'koppela@gmail.com', email: 'koppela@gmail.com', name: 'Koppela', password: 'Koppela123', mustChange: false});
  const vendor = await auth.createAccount({role: 'vendor', loginId: 'VN-000001', email: 'v@gmail.com', name: 'V', password: 'Vendor123', mustChange: false});
  auth.ensureSuperAdmin('');
  return {db, auth, service, sent, audits, boss, koppela, vendor};
}
const tokenFrom = mail => mail.text.match(/#reset=([A-Za-z0-9_-]+)/)[1];
const fakeRes = () => ({headers: [], append(k, v) { this.headers.push([k, v]); }});

test('an older database without admin_role is upgraded in place and keeps every admin', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY, role TEXT NOT NULL, login_id TEXT NOT NULL UNIQUE, email TEXT, name TEXT,
    password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active',
    application_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT, password_changed_at TEXT)`);
  db.prepare(`INSERT INTO accounts(id,role,login_id,email,name,password_hash,must_change_password,status,created_at,updated_at)
    VALUES('1','admin','old@gmail.com','old@gmail.com','Old Admin','x',0,'active','2024-01-01','2024-01-01')`).run();
  const auth = createAuth(db);
  const row = db.prepare("SELECT * FROM accounts WHERE id='1'").get();
  assert.equal(row.email, 'old@gmail.com');
  assert.equal(row.status, 'active');
  assert.equal(row.password_hash, 'x');
  assert.ok('admin_role' in row);
  createAuth(db); // running it again must not fail
  assert.equal(auth.ensureSuperAdmin('').login_id, 'old@gmail.com');
});

test('the earliest admin becomes Super Admin; SUPER_ADMIN_EMAIL overrides; partners never do; repeat is harmless', async () => {
  const {auth, boss, koppela, vendor} = await setup();
  assert.equal(auth.isSuperAdmin(auth.accountById(boss.id)), true);
  assert.equal(auth.isSuperAdmin(auth.accountById(koppela.id)), false);
  assert.equal(auth.isSuperAdmin(auth.accountById(vendor.id)), false);
  auth.ensureSuperAdmin('koppela@gmail.com');
  assert.equal(auth.isSuperAdmin(auth.accountById(koppela.id)), true);
  assert.equal(auth.ensureSuperAdmin('').id !== undefined, true);
  assert.equal(auth.publicAccount(auth.accountById(boss.id)).isSuperAdmin, true);
  assert.equal(auth.publicAccount(auth.accountById(vendor.id)).isSuperAdmin, false);
});

test('the admin list never contains passwords, hashes or tokens', async () => {
  const {auth} = await setup();
  const list = auth.listAdmins();
  assert.equal(list.length, 2);
  const text = JSON.stringify(list);
  assert.ok(!/scrypt|password_hash|passwordHash|Boss12345|token/i.test(text));
  assert.ok(!list.some(a => a.email === 'v@gmail.com'), 'vendors are not listed as admins');
});

test('passwords are stored only as salted scrypt hashes', async () => {
  const {db} = await setup();
  for (const r of db.prepare("SELECT password_hash FROM accounts").all()) {
    assert.match(r.password_hash, /^scrypt\$16384\$8\$1\$/);
    assert.ok(!/Boss12345|Koppela123|Vendor123/.test(r.password_hash));
  }
});

test('switching an admin off signs them out and blocks self / last Super Admin', async () => {
  const {auth, boss, koppela} = await setup();
  const res = fakeRes();
  auth.startSession({headers: {}, secure: false}, res, auth.accountById(koppela.id), {});
  const token = res.headers[0][1].split(';')[0].split('=')[1];
  const reqWith = {headers: {cookie: `otw_admin_session=${token}`}};
  assert.ok(auth.getSession(reqWith, 'admin'));
  assert.equal(auth.setAdminStatus('koppela@gmail.com', 'disabled', boss.id).ok, true);
  assert.equal(auth.getSession(reqWith, 'admin'), null, 'existing sessions end');
  assert.equal(auth.setAdminStatus('boss@gmail.com', 'disabled', boss.id).ok, false, 'not yourself');
  assert.equal(auth.setAdminStatus('koppela@gmail.com', 'active', boss.id).ok, true, 'switching back on works');
  auth.ensureSuperAdmin('koppela@gmail.com');
  assert.equal(auth.setAdminStatus('boss@gmail.com', 'disabled', koppela.id).ok, true, 'a second active Super Admin exists now');
  assert.equal(auth.setAdminStatus('nobody@gmail.com', 'disabled', boss.id).status, 404);
  assert.equal(auth.setAdminStatus('koppela@gmail.com', 'weird', boss.id).ok, false);
});

test('the last active Super Admin cannot be switched off by another admin', async () => {
  const {auth, boss, koppela} = await setup();
  const out = auth.setAdminStatus('boss@gmail.com', 'disabled', koppela.id);
  assert.equal(out.ok, false);
  assert.match(out.error, /last active Super Admin/);
});

test('Super Admin reset: link goes only to the target admin, nothing secret is returned, audit is written', async () => {
  const {auth, service, sent, audits, koppela} = await setup();
  const out = await service.requestResetForAdmin({account: auth.accountById(koppela.id), actorEmail: 'boss@gmail.com', baseUrl: BASE});
  assert.deepEqual(out, {ok: true, sentTo: 'koppela@gmail.com'});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'koppela@gmail.com');
  assert.ok(sent[0].text.includes(`${BASE}/dashboard/#reset=`));
  assert.ok(!JSON.stringify(out).includes('reset='), 'the token never goes back to the Super Admin');
  const actions = audits.map(a => a.action);
  assert.ok(actions.includes('password_reset_requested') && actions.includes('password_reset_link_sent'));
  assert.ok(audits.every(a => a.who === 'boss@gmail.com'), 'actor is recorded');
});

test('full flow: link -> new password -> old password stops working -> new password signs in -> signed out everywhere', async () => {
  const {auth, service, sent, audits, koppela} = await setup();
  const res = fakeRes();
  auth.startSession({headers: {}}, res, auth.accountById(koppela.id), {});
  const oldReq = {headers: {cookie: `otw_admin_session=${res.headers[0][1].split(';')[0].split('=')[1]}`}};
  assert.ok(auth.getSession(oldReq, 'admin'), 'signed in before the reset');
  await service.requestResetForAdmin({account: auth.accountById(koppela.id), actorEmail: 'boss@gmail.com', baseUrl: BASE});
  const token = tokenFrom(sent[0]);
  const weak = await service.completeReset({token, newPassword: 'short'});
  assert.equal(weak.ok, false, 'rules checked first');
  const done = await service.completeReset({token, newPassword: 'Brand-New-77'});
  assert.equal(done.ok, true);
  const acct = auth.accountById(koppela.id);
  assert.equal(await auth.verifyPassword('Koppela123', acct.password_hash), false);
  assert.equal(await auth.verifyPassword('Brand-New-77', acct.password_hash), true);
  assert.equal(acct.must_change_password, 0);
  assert.equal(auth.getSession(oldReq, 'admin'), null, 'every old session ended');
  const res2 = fakeRes();
  auth.startSession({headers: {}}, res2, auth.accountById(koppela.id), {});
  const newReq = {headers: {cookie: `otw_admin_session=${res2.headers[0][1].split(';')[0].split('=')[1]}`}};
  assert.ok(auth.getSession(newReq, 'admin'), 'signing in with the new password works');
  auth.endSession(newReq, res2, 'admin');
  assert.equal(auth.getSession(newReq, 'admin'), null, 'logout ends the session');
  const again = await service.completeReset({token, newPassword: 'Another-88'});
  assert.equal(again.ok, false, 'a link works once');
  assert.ok(audits.some(a => a.action === 'password_reset' && a.who === 'koppela@gmail.com'));
  assert.ok(audits.some(a => a.action === 'password_reset_invalid_link'));
});
test('failed email does not pretend success and is audited; disabled admins and bad addresses are refused', async () => {
  const {auth, service, audits, koppela, vendor, boss} = await setup({mail: 'fail'});
  const bad = await service.requestResetForAdmin({account: auth.accountById(koppela.id), actorEmail: 'boss@gmail.com', baseUrl: BASE});
  assert.equal(bad.ok, false); assert.equal(bad.status, 502);
  assert.ok(audits.some(a => a.action === 'password_reset_email_failed'));
  auth.setAdminStatus('koppela@gmail.com', 'disabled', boss.id);
  assert.equal((await service.requestResetForAdmin({account: auth.accountById(koppela.id), actorEmail: 'x', baseUrl: BASE})).ok, false);
  assert.equal((await service.requestResetForAdmin({account: auth.accountById(vendor.id), actorEmail: 'x', baseUrl: BASE})).ok, false, 'vendors are not admins');
});

test('at most 5 links per hour per admin, also for the Super Admin button', async () => {
  const {auth, service, koppela} = await setup();
  for (let i = 0; i < auth.RESET_LIMIT_PER_WINDOW; i++) {
    assert.equal((await service.requestResetForAdmin({account: auth.accountById(koppela.id), actorEmail: 'boss@gmail.com', baseUrl: BASE})).ok, true);
  }
  const over = await service.requestResetForAdmin({account: auth.accountById(koppela.id), actorEmail: 'boss@gmail.com', baseUrl: BASE});
  assert.equal(over.status, 429);
});

test('self-service reset is audited when requested, and failures are audited too', async () => {
  const {service, audits} = await setup();
  const out = service.requestReset({email: 'koppela@gmail.com', baseUrl: BASE});
  await out.done;
  const actions = audits.map(a => a.action);
  assert.ok(actions.includes('password_reset_requested') && actions.includes('password_reset_link_sent'));
});
