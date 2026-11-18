// Admin sign-in, forgot-password and account listing rules. Uses Node's built-in SQLite and test runner,
// so it runs without installing anything:  node --test test/admin-auth.test.mjs   (from the backend folder)
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAuth} from '../auth.js';
import {createPasswordResetService, RESET_REQUEST_MESSAGE} from '../password-reset.js';
import {adminAccountRows, formatAdminReport} from '../admin-accounts.js';

const silent = {error() {}, warn() {}, log() {}};
const BASE = 'http://192.168.1.20:8080';

async function setup() {
  const db = new DatabaseSync(':memory:');
  const auth = createAuth(db);
  const sent = [];
  const audits = [];
  const service = createPasswordResetService({
    auth,
    log: silent,
    audit: (who, action) => audits.push({who, action}),
    sendMail: async mail => { sent.push(mail); },
  });
  const bala = await auth.createAccount({role: 'admin', loginId: 'balajinaik5069@gmail.com',
    email: 'balajinaik5069@gmail.com', name: 'M. Balajinaik', password: 'Temp-Pass1', mustChange: true});
  const koppela = await auth.createAccount({role: 'admin', loginId: 'koppelagayathri@gmail.com',
    email: 'koppelagayathri@gmail.com', name: 'Koppela Gayathri', password: 'Secret123', mustChange: false});
  const vendor = await auth.createAccount({role: 'vendor', loginId: 'VN-000001', email: 'vendor@gmail.com',
    name: 'Vendor One', password: 'Vendor123', mustChange: false});
  await auth.createAccount({role: 'admin', loginId: 'retired@gmail.com', email: 'retired@gmail.com',
    name: 'Retired', password: 'Retired123', mustChange: false});
  db.prepare("UPDATE accounts SET status='disabled' WHERE login_id='retired@gmail.com'").run();
  return {db, auth, service, sent, audits, bala, koppela, vendor};
}

// Pulls the link token out of the email the service sent.
const tokenFrom = mail => mail.text.match(/#reset=([A-Za-z0-9_-]+)/)[1];

// ---------- sign-in matching ----------

test('an admin is found by registered email, ignoring capitals and stray spaces', async () => {
  const {auth, bala} = await setup();
  const found = auth.findCandidates('admin', '  BalajiNaik5069@Gmail.com ');
  assert.deepEqual(found.map(a => a.id), [bala.id]);
  assert.equal(await auth.verifyPassword('Temp-Pass1', found[0].password_hash), true);
});

test('an admin stored with mixed-case login ID from an older version still signs in', async () => {
  const {db, auth} = await setup();
  const legacy = await auth.createAccount({role: 'admin', loginId: 'x@gmail.com', email: 'x@gmail.com', name: 'Legacy', password: 'Legacy123', mustChange: false});
  db.prepare("UPDATE accounts SET login_id='Legacy.Admin@Gmail.com', email='' WHERE id=?").run(legacy.id);
  assert.deepEqual(auth.findCandidates('admin', 'legacy.admin@gmail.com').map(a => a.id), [legacy.id]);
});

test('admin sign-in never matches vendor or franchise accounts, and partners never match admin emails', async () => {
  const {auth, vendor} = await setup();
  assert.deepEqual(auth.findCandidates('admin', 'vendor@gmail.com'), []);
  assert.deepEqual(auth.findCandidates('vendor', 'balajinaik5069@gmail.com'), []);
  assert.deepEqual(auth.findCandidates('vendor', 'VN-000001').map(a => a.id), [vendor.id]);
});

// ---------- forgot password ----------

test('a reset link is emailed to the admin registered address and the answer never changes', async () => {
  const {service, sent} = await setup();
  const out = service.requestReset({email: 'balajinaik5069@gmail.com', baseUrl: BASE});
  assert.equal(out.message, RESET_REQUEST_MESSAGE);
  await out.done;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'balajinaik5069@gmail.com');
  assert.ok(sent[0].text.includes(`${BASE}/dashboard/#reset=`), 'link must point at the dashboard, token after #');
  assert.ok(!/\?reset=|\/reset\//.test(sent[0].text), 'token must not be in the query string or path');
});

test('unknown, vendor, disabled and malformed emails get the same answer and no email', async () => {
  const {service, sent} = await setup();
  const answers = ['nobody@gmail.com', 'vendor@gmail.com', 'retired@gmail.com', 'not-an-email', '', '   '].map(email => {
    const out = service.requestReset({email, baseUrl: BASE});
    return out;
  });
  for (const out of answers) { await out.done; assert.equal(out.message, RESET_REQUEST_MESSAGE); }
  assert.equal(sent.length, 0);
});

test('the email text never contains a password, a password hash or the mail credentials', async () => {
  const {service, sent, db} = await setup();
  const out = service.requestReset({email: 'koppelagayathri@gmail.com', baseUrl: BASE});
  await out.done;
  const body = sent[0].text;
  assert.ok(!body.includes('Secret123'));
  assert.ok(!body.includes('scrypt$'));
  const hashes = db.prepare('SELECT password_hash FROM accounts').all().map(r => r.password_hash);
  for (const h of hashes) assert.ok(!body.includes(h.slice(0, 20)));
  // The admin's own address may contain 'gmail'; the credential setting names must never appear.
  assert.ok(!/APP_PASSWORD|SMTP_PASS|GMAIL_APP/i.test(body));
});

test('a valid link sets the new password once, signs out other devices and stops the old password', async () => {
  const {service, sent, auth, db, koppela, audits} = await setup();
  db.prepare('INSERT INTO sessions(token_hash,account_id,role,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)')
    .run('other-device-session', koppela.id, 'admin', new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString(), new Date().toISOString());
  const req = service.requestReset({email: 'koppelagayathri@gmail.com', baseUrl: BASE});
  await req.done;
  const token = tokenFrom(sent[0]);

  const first = await service.completeReset({token, newPassword: 'Brand-New9'});
  assert.deepEqual(first, {ok: true});
  const again = await service.completeReset({token, newPassword: 'Another1x'});
  assert.equal(again.ok, false, 'a link must not work twice');

  const after = db.prepare('SELECT * FROM accounts WHERE id=?').get(koppela.id);
  assert.equal(await auth.verifyPassword('Secret123', after.password_hash), false, 'old password must stop working');
  assert.equal(await auth.verifyPassword('Brand-New9', after.password_hash), true, 'new password must work');
  assert.equal(after.must_change_password, 0, 'the admin chose this password, so no forced change');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id=?').get(koppela.id).n, 0, 'other sessions must be ended');
  assert.ok(audits.some(a => a.action === 'password_reset'));
});

test('a weak new password is refused without using up the link', async () => {
  const {service, sent} = await setup();
  const req = service.requestReset({email: 'koppelagayathri@gmail.com', baseUrl: BASE});
  await req.done;
  const token = tokenFrom(sent[0]);
  const weak = await service.completeReset({token, newPassword: 'short'});
  assert.equal(weak.ok, false);
  assert.match(weak.error, /8 characters/);
  const good = await service.completeReset({token, newPassword: 'Good-Pass2'});
  assert.deepEqual(good, {ok: true});
});

test('an expired link is refused', async () => {
  const {service, sent, db} = await setup();
  const req = service.requestReset({email: 'koppelagayathri@gmail.com', baseUrl: BASE});
  await req.done;
  const token = tokenFrom(sent[0]);
  db.prepare('UPDATE password_resets SET expires_at=?').run(new Date(Date.now() - 1000).toISOString());
  const out = await service.completeReset({token, newPassword: 'Good-Pass2'});
  assert.equal(out.ok, false);
});

test('only the newest link works: asking again makes the earlier link stop working', async () => {
  const {service, sent} = await setup();
  const one = service.requestReset({email: 'koppelagayathri@gmail.com', baseUrl: BASE});
  await one.done;
  const firstToken = tokenFrom(sent[0]);
  const two = service.requestReset({email: 'koppelagayathri@gmail.com', baseUrl: BASE});
  await two.done;
  const secondToken = tokenFrom(sent[1]);
  assert.equal((await service.completeReset({token: firstToken, newPassword: 'Good-Pass2'})).ok, false);
  assert.equal((await service.completeReset({token: secondToken, newPassword: 'Good-Pass2'})).ok, true);
});

test('an admin can ask for at most five links an hour; further requests are silently ignored', async () => {
  const {service, sent} = await setup();
  for (let i = 0; i < 7; i++) {
    const out = service.requestReset({email: 'koppelagayathri@gmail.com', baseUrl: BASE});
    assert.equal(out.message, RESET_REQUEST_MESSAGE);
    await out.done;
  }
  assert.equal(sent.length, 5);
});

test('tokens are stored only as hashes; the raw token is not in the database', async () => {
  const {service, sent, db} = await setup();
  const req = service.requestReset({email: 'koppelagayathri@gmail.com', baseUrl: BASE});
  await req.done;
  const token = tokenFrom(sent[0]);
  const rows = db.prepare('SELECT * FROM password_resets').all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].token_hash.length, 64);
  assert.ok(!JSON.stringify(rows).includes(token));
});

test('a link can never reset a non-admin account', async () => {
  const {service, auth, db, vendor} = await setup();
  const token = auth.createPasswordReset(vendor.id);
  assert.equal(auth.consumePasswordReset(token), null);
  assert.equal((await service.completeReset({token, newPassword: 'Good-Pass2'})).ok, false);
});

test('two admins sharing one registered email receive no link (ambiguous, so nothing is sent)', async () => {
  const {db, auth, service, sent} = await setup();
  await auth.createAccount({role: 'admin', loginId: 'dup@gmail.com', email: 'dup@gmail.com', name: 'Dup 1', password: 'Dup-Pass1', mustChange: false});
  db.prepare("INSERT INTO accounts(id,role,login_id,email,name,password_hash,must_change_password,status,created_at,updated_at) VALUES('dup2','admin','dup2@gmail.com','dup@gmail.com','Dup 2','x',0,'active',?,?)")
    .run(new Date().toISOString(), new Date().toISOString());
  const out = service.requestReset({email: 'dup@gmail.com', baseUrl: BASE});
  await out.done;
  assert.equal(sent.length, 0);
});

// ---------- account listing ----------

test('the account listing shows admins, emails and status, and never a password or hash', async () => {
  const {db} = await setup();
  const rows = adminAccountRows(db);
  assert.deepEqual(rows.map(r => r.email), ['balajinaik5069@gmail.com', 'koppelagayathri@gmail.com', 'retired@gmail.com']);
  assert.equal(rows.find(r => r.email === 'retired@gmail.com').status, 'disabled');
  assert.equal(rows.find(r => r.email === 'balajinaik5069@gmail.com').passwordChosenByAdmin, false);
  assert.equal(rows.find(r => r.email === 'koppelagayathri@gmail.com').passwordChosenByAdmin, true);
  assert.ok(rows.every(r => !('password_hash' in r) && !('password' in r)));

  const report = formatAdminReport(rows, {mailReady: true, mailFrom: 'onthewaynpr@gmail.com'});
  assert.ok(!report.includes('scrypt$'));
  assert.ok(!report.includes('Temp-Pass1') && !report.includes('Secret123'));
  assert.match(report, /Forgot-password emails: ready \(sent from onthewaynpr@gmail\.com\)/);
});

test('the listing flags any admin email that is not a Gmail address', async () => {
  const {db} = await setup();
  await (await import('../auth.js')).createAuth(db).createAccount({role: 'admin', loginId: 'admin3@onthewaylogistics.in',
    email: 'admin3@onthewaylogistics.in', name: 'Admin 3', password: 'Admin3-pw1', mustChange: true});
  const report = formatAdminReport(adminAccountRows(db), {mailReady: false});
  assert.match(report, /admin3@onthewaylogistics\.in {3}<-- not a Gmail address/);
  assert.match(report, /Forgot-password emails: NOT ready/);
});
