// Run with:  node --test --no-warnings test/admin-edit.test.mjs   (from the backend folder)
// Super Admin > Admin Accounts: change an admin's name and registered email (also the sign-in ID), and add admins.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAuth} from '../auth.js';

async function setup() {
  const db = new DatabaseSync(':memory:');
  const auth = createAuth(db);
  const boss = await auth.createAccount({role: 'admin', loginId: 'boss@gmail.com', email: 'boss@gmail.com', name: 'Boss', password: 'Boss12345', mustChange: false});
  const a3 = await auth.createAccount({role: 'admin', loginId: 'admin3@onthewaylogistics.in', email: 'admin3@onthewaylogistics.in', name: 'Admin 3', password: 'Temp-1234-abcd', mustChange: true});
  const vendor = await auth.createAccount({role: 'vendor', loginId: 'VN-000001', email: 'shop@gmail.com', name: 'Shop', password: 'Vendor123', mustChange: false});
  auth.ensureSuperAdmin('');
  return {db, auth, boss, a3, vendor};
}

test('a placeholder admin gets a real name and email; they sign in with the new email and the same password', async () => {
  const s = await setup();
  const out = s.auth.updateAdminDetails('admin3@onthewaylogistics.in', {name: '  Ravi   Kumar ', email: ' Ravi.Kumar@Gmail.com '});
  assert.equal(out.ok, true);
  assert.deepEqual(out.changes, ['name', 'email']);
  assert.equal(out.previousEmail, 'admin3@onthewaylogistics.in');
  assert.equal(out.account.name, 'Ravi Kumar');
  assert.equal(out.account.email, 'ravi.kumar@gmail.com');
  assert.equal(out.account.login_id, 'ravi.kumar@gmail.com');
  const [found] = s.auth.findCandidates('admin', 'RAVI.KUMAR@gmail.com');
  assert.equal(found.id, s.a3.id);
  assert.equal(await s.auth.verifyPassword('Temp-1234-abcd', found.password_hash), true, 'password unchanged');
  assert.equal(found.must_change_password, 1, 'a temporary password still has to be changed');
  assert.equal(s.auth.findCandidates('admin', 'admin3@onthewaylogistics.in').length, 0, 'the old email no longer signs in');
  assert.equal(s.auth.adminByLoginId('ravi.kumar@gmail.com').id, s.a3.id);
});

test('changing the email ends reset links sent to the old address; a name-only change keeps them', async () => {
  const s = await setup();
  const t1 = s.auth.createPasswordReset(s.a3.id);
  s.auth.updateAdminDetails('admin3@onthewaylogistics.in', {name: 'Admin Three'});
  const t2 = s.auth.createPasswordReset(s.a3.id); // a newer link replaces t1 anyway
  assert.equal(s.auth.updateAdminDetails('admin3@onthewaylogistics.in', {email: 'three@gmail.com'}).ok, true);
  assert.equal(s.auth.consumePasswordReset(t2), null);
  assert.equal(s.auth.consumePasswordReset(t1), null);
});

test('emails must be valid and unique; names are required; unknown admins and partners are refused', async () => {
  const s = await setup();
  const bad = s.auth.updateAdminDetails('admin3@onthewaylogistics.in', {email: 'not-an-email'});
  assert.deepEqual([bad.ok, bad.status, bad.field], [false, 400, 'email']);
  const taken = s.auth.updateAdminDetails('admin3@onthewaylogistics.in', {email: 'BOSS@gmail.com'});
  assert.deepEqual([taken.ok, taken.status, taken.field], [false, 409, 'email']);
  const noName = s.auth.updateAdminDetails('admin3@onthewaylogistics.in', {name: '   '});
  assert.deepEqual([noName.ok, noName.field], [false, 'name']);
  assert.equal(s.auth.updateAdminDetails('ghost@gmail.com', {name: 'X'}).status, 404);
  assert.equal(s.auth.updateAdminDetails('VN-000001', {name: 'X'}).status, 404, 'partners are not admins');
  // a partner sharing the email is fine: partners sign in with their own ID and portal
  assert.equal(s.auth.updateAdminDetails('admin3@onthewaylogistics.in', {email: 'shop@gmail.com'}).ok, true);
  // saving the same values changes nothing
  const same = s.auth.updateAdminDetails('shop@gmail.com', {name: 'Admin 3', email: 'shop@gmail.com'});
  assert.deepEqual(same.changes, []);
});

test('a new admin gets a temporary password that works once and must be changed; duplicates are refused', async () => {
  const s = await setup();
  const out = await s.auth.addAdmin({name: 'Sita Devi', email: 'Sita.Devi@gmail.com'});
  assert.equal(out.ok, true);
  assert.equal(out.account.role, 'admin');
  assert.equal(out.account.login_id, 'sita.devi@gmail.com');
  assert.equal(out.account.must_change_password, 1);
  assert.equal(out.account.admin_role ?? 'admin', 'admin', 'a new admin is not a Super Admin');
  assert.equal(await s.auth.verifyPassword(out.password, out.account.password_hash), true);
  const again = await s.auth.addAdmin({name: 'Sita Again', email: 'sita.devi@gmail.com'});
  assert.deepEqual([again.ok, again.status], [false, 409]);
  assert.equal((await s.auth.addAdmin({name: '', email: 'x@gmail.com'})).field, 'name');
  assert.equal(s.auth.listAdmins().length, 3);
});
