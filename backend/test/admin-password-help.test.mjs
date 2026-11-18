// Run with:  node --test --no-warnings test/admin-password-help.test.mjs   (from the backend folder)
// Forgot password when reset emails cannot be sent: the request goes to the Super Admin, who can issue a temporary
// password that must be changed at the next sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAuth} from '../auth.js';
import {createPasswordHelpService, HELP_REQUEST_MESSAGE} from '../admin-password-help.js';

async function setup() {
  const db = new DatabaseSync(':memory:');
  const auth = createAuth(db);
  const audits = [];
  let clock = Date.parse('2026-11-15T06:00:00Z');
  const now = () => new Date(clock).toISOString();
  const help = createPasswordHelpService({db, auth, audit: (who, action, details) => audits.push({who, action, details}), now});
  const boss = await auth.createAccount({role: 'admin', loginId: 'boss@gmail.com', email: 'boss@gmail.com', name: 'Boss', password: 'Boss12345', mustChange: false});
  const koppela = await auth.createAccount({role: 'admin', loginId: 'koppela@gmail.com', email: 'koppela@gmail.com', name: 'Koppela', password: 'Koppela123', mustChange: false});
  const vendor = await auth.createAccount({role: 'vendor', loginId: 'VN-000001', email: 'v@gmail.com', name: 'V', password: 'Vendor123', mustChange: false});
  auth.ensureSuperAdmin('');
  return {db, auth, help, audits, boss, koppela, vendor, tick: ms => { clock += ms; }};
}

test('the answer is the same for admins, unknown emails, partners and bad input; only admins are recorded', async () => {
  const s = await setup();
  for (const email of ['Koppela@Gmail.com ', 'nobody@gmail.com', 'v@gmail.com', 'not-an-email', '']) {
    const out = s.help.requestHelp({email});
    assert.deepEqual(out, {ok: true, mode: 'super_admin', message: HELP_REQUEST_MESSAGE});
  }
  assert.deepEqual([...s.help.openRequests().keys()], ['koppela@gmail.com']);
  assert.equal(s.audits.filter(a => a.action === 'password_help_requested').length, 1);
});

test('a switched-off admin is not recorded; repeated requests keep one entry with a count', async () => {
  const s = await setup();
  s.db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(s.koppela.id);
  s.help.requestHelp({email: 'koppela@gmail.com'});
  assert.equal(s.help.openRequests().size, 0);
  s.db.prepare("UPDATE accounts SET status='active' WHERE id=?").run(s.koppela.id);
  s.help.requestHelp({email: 'koppela@gmail.com'});
  s.tick(60000);
  s.help.requestHelp({email: 'koppela@gmail.com'});
  assert.equal(s.help.openRequests().get('koppela@gmail.com').times, 2);
});

test('a request ends when the admin signs in or the password is changed, and after 7 days', async () => {
  const s = await setup();
  s.help.requestHelp({email: 'koppela@gmail.com'});
  s.tick(1000);
  s.db.prepare('UPDATE accounts SET last_login_at=? WHERE id=?').run(new Date(Date.parse('2026-11-15T06:00:01Z')).toISOString(), s.koppela.id);
  assert.equal(s.help.openRequests().size, 0, 'signed in after asking');
  s.tick(1000);
  s.help.requestHelp({email: 'koppela@gmail.com'});
  assert.equal(s.help.openRequests().size, 1);
  s.tick(8 * 86400000);
  assert.equal(s.help.openRequests().size, 0, 'older than 7 days');
});

test('the Super Admin issues a temporary password: it works, must be changed, signs out devices and ends reset links', async () => {
  const s = await setup();
  s.help.requestHelp({email: 'koppela@gmail.com'});
  const link = s.auth.createPasswordReset(s.koppela.id);
  s.db.prepare("INSERT INTO sessions(token_hash,account_id,role,created_at,expires_at) VALUES('h1',?,'admin',?,?)").run(s.koppela.id, '2026-11-15T00:00:00Z', '2099-01-01T00:00:00Z');
  const out = await s.help.issueTemporaryPassword({loginId: 'koppela@gmail.com', actorAccountId: s.boss.id, actorEmail: 'boss@gmail.com'});
  assert.equal(out.ok, true);
  assert.match(out.password, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
  const acct = s.auth.accountById(s.koppela.id);
  assert.equal(await s.auth.verifyPassword(out.password, acct.password_hash), true);
  assert.equal(await s.auth.verifyPassword('Koppela123', acct.password_hash), false, 'old password stops working');
  assert.equal(acct.must_change_password, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id=?').get(s.koppela.id).n, 0);
  assert.equal(s.auth.consumePasswordReset(link), null, 'unused email link no longer works');
  assert.equal(s.help.openRequests().size, 0);
  const a = s.audits.find(x => x.action === 'temporary_password_issued');
  assert.deepEqual([a.who, a.details.target], ['boss@gmail.com', 'koppela@gmail.com']);
  assert.ok(!JSON.stringify(s.audits).includes(out.password), 'the password is never written to the audit log');
});

test('no temporary password for yourself, for a switched-off admin, for partners or unknown accounts', async () => {
  const s = await setup();
  const self = await s.help.issueTemporaryPassword({loginId: 'boss@gmail.com', actorAccountId: s.boss.id, actorEmail: 'boss@gmail.com'});
  assert.equal(self.ok, false); assert.match(self.error, /Change password/);
  s.db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(s.koppela.id);
  const off = await s.help.issueTemporaryPassword({loginId: 'koppela@gmail.com', actorAccountId: s.boss.id, actorEmail: 'b'});
  assert.equal(off.ok, false); assert.match(off.error, /Switch this admin on/);
  for (const loginId of ['vn-000001', 'ghost@gmail.com']) {
    const r = await s.help.issueTemporaryPassword({loginId, actorAccountId: s.boss.id, actorEmail: 'b'});
    assert.equal(r.status, 404);
  }
});
