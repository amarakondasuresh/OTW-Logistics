// Run with:  node --test --no-warnings test/partner-ban.test.mjs   (from the backend folder)
// Admin > Client > Ban: a banned vendor / franchise is signed out at once and cannot sign in until the ban ends or an
// admin unbans them. The application itself is not changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAuth} from '../auth.js';

async function setup() {
  const db = new DatabaseSync(':memory:');
  const auth = createAuth(db);
  const app = {id: 'app-1', appId: 'VN-000001', type: 'Vendor', name: 'Suresh', email: 's@gmail.com', status: 'Accepted'};
  const {account} = await auth.ensurePartnerAccount(app);
  const admin = await auth.createAccount({role: 'admin', loginId: 'boss@gmail.com', email: 'boss@gmail.com', name: 'Boss', password: 'Boss12345', mustChange: false});
  return {db, auth, app, account, admin};
}
// A signed-in browser: the cookie from startSession, sent back on the next request.
function signIn(auth, account) {
  const headers = [];
  auth.startSession({headers: {}, protocol: 'http', secure: false}, {append: (k, v) => headers.push(v)}, account);
  const cookie = headers.map(h => h.split(';')[0]).join('; ');
  return {headers: {cookie}, protocol: 'http'};
}

test('a ban until further notice signs the partner out everywhere and blocks new sessions', async () => {
  const s = await setup();
  const browser = signIn(s.auth, s.account);
  assert.ok(s.auth.getSession(browser, 'vendor'), 'signed in before the ban');
  const out = s.auth.banPartner('app-1', {reason: '  Repeated  late deliveries ', actor: 'boss@gmail.com'});
  assert.equal(out.ok, true);
  assert.deepEqual([out.ban.until, out.ban.reason, out.ban.by], ['', 'Repeated late deliveries', 'boss@gmail.com']);
  assert.equal(s.auth.getSession(browser, 'vendor'), null, 'the open session stops working');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id=?').get(s.account.id).n, 0);
  const again = signIn(s.auth, s.auth.accountById(s.account.id));
  assert.equal(s.auth.getSession(again, 'vendor'), null, 'a session cannot be used while banned');
  assert.ok(s.auth.publicAccount(s.auth.accountById(s.account.id)).ban);
  assert.equal(s.auth.accountById(s.account.id).status, 'active', 'the login itself stays active (only banned)');
});

test('a timed ban ends by itself; unban ends it at once', async () => {
  const s = await setup();
  const until = new Date(Date.now() + 7 * 86400000).toISOString();
  assert.equal(s.auth.banPartner('app-1', {until}).ban.until, until);
  s.db.prepare('UPDATE accounts SET banned_until=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), s.account.id);
  assert.equal(s.auth.banInfo(s.auth.accountById(s.account.id)), null, 'expired');
  const browser = signIn(s.auth, s.auth.accountById(s.account.id));
  assert.ok(s.auth.getSession(browser, 'vendor'), 'can sign in again after the ban ends');
  s.auth.banPartner('app-1', {});
  assert.ok(s.auth.banInfo(s.auth.accountById(s.account.id)));
  s.auth.unbanPartner('app-1');
  assert.equal(s.auth.banInfo(s.auth.accountById(s.account.id)), null);
  assert.equal(s.auth.publicAccount(s.auth.accountById(s.account.id)).ban, null);
});

test('the end must be a valid future date within 5 years; there must be a login to ban', async () => {
  const s = await setup();
  for (const until of ['tomorrow-ish', new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 6 * 366 * 86400000).toISOString()]) {
    const r = s.auth.banPartner('app-1', {until});
    assert.equal(r.ok, false, until);
  }
  assert.equal(s.auth.banInfo(s.auth.accountById(s.account.id)), null, 'nothing was banned by the refused requests');
  assert.equal(s.auth.banPartner('no-such-application', {}).ok, false);
});

test('admins are never affected by partner bans', async () => {
  const s = await setup();
  s.db.prepare("UPDATE accounts SET banned_at=? WHERE id=?").run(new Date().toISOString(), s.admin.id);
  assert.equal(s.auth.banInfo(s.auth.accountById(s.admin.id)), null);
  assert.ok(s.auth.getSession(signIn(s.auth, s.admin), 'admin'));
});
