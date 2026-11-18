// Run with:  node --test --no-warnings test/admin-notifications.test.mjs   (from the backend folder)
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {
  createAdminNotifications, adminApplicationEmail, displayStatus, EMAIL_SUBJECT, istDate, istTime,
} from '../admin-notifications.js';

const A1 = 'acc-admin-1';
const A2 = 'acc-admin-2';

function setup({recipients = ['admin@example.com'], failTimes = 0, maxAttempts} = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE partner_applications(id TEXT PRIMARY KEY, app_id TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
    name TEXT NOT NULL, mobile TEXT, email TEXT, status TEXT NOT NULL DEFAULT 'New', submitted_at TEXT NOT NULL);`);
  const sent = [];
  let failures = failTimes;
  const fail = (n) => { failures = n; };
  const audit = [];
  let clock = Date.parse('2026-11-18T05:00:00Z');
  const service = createAdminNotifications({
    db,
    transport: {
      sendMail: async (m) => {
        if (failures > 0) {
          failures--;
          throw new Error('Invalid login for ops@example.com with password abc');
        }
        sent.push(m);
      },
    },
    recipients: () => recipients,
    audit: (actor, action, details) => audit.push({actor, action, details}),
    log: {error() {}},
    now: () => new Date(clock),
    ...(maxAttempts ? {maxAttempts} : {}),
  });
  const addApp = (id, appId, type, name, status = 'New') => {
    db.prepare('INSERT INTO partner_applications VALUES(?,?,?,?,?,?,?,?)').run(
      id, appId, type, name, '9876543210', 'applicant@example.com', status, '2026-11-18T04:30:00.000Z',
    );
  };
  const advance = (minutes) => { clock += minutes * 60_000; };
  return {db, service, sent, audit, addApp, advance, fail};
}

test('one notification per application: a repeated create changes nothing', () => {
  const s = setup();
  s.addApp('app-1', 'FP-000001', 'Franchise', 'Ravi Kumar');
  const first = s.service.create({applicationId: 'app-1', dashboardBase: 'https://site.test'});
  const second = s.service.create({applicationId: 'app-1', dashboardBase: 'https://site.test'});
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM admin_notifications').get().n, 1);
});

test('a notification cannot exist without its saved application', () => {
  const s = setup();
  assert.throws(() => s.service.create({applicationId: 'missing'}), /not saved/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM admin_notifications').get().n, 0);
});

test('unread count, mark read / unread and delete are kept separately for each admin', () => {
  const s = setup();
  s.addApp('app-1', 'VN-000001', 'Vendor', 'Lakshmi Devi');
  s.addApp('app-2', 'FP-000001', 'Franchise', 'Ravi Kumar');
  const n1 = s.service.create({applicationId: 'app-1'}).id;
  s.service.create({applicationId: 'app-2'});
  assert.equal(s.service.unreadCount(A1), 2);
  assert.equal(s.service.unreadCount(A2), 2, 'a new notification is unread for every admin');

  assert.equal(s.service.setRead(A1, n1, true), true);
  assert.equal(s.service.unreadCount(A1), 1);
  assert.equal(s.service.unreadCount(A2), 2, 'reading for admin 1 does not read it for admin 2');

  s.service.setRead(A1, n1, false);
  assert.equal(s.service.unreadCount(A1), 2, 'mark as unread brings it back');

  s.service.remove(A2, n1);
  assert.equal(s.service.unreadCount(A2), 1);
  assert.equal(s.service.list(A2).items.some((i) => i.id === n1), false, 'deleted for admin 2 only');
  assert.equal(s.service.list(A1).items.some((i) => i.id === n1), true, 'still listed for admin 1');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM partner_applications').get().n, 2, 'application kept');
});

test('filters: type and status (New = unread, Pending / Approved / Rejected = application status)', () => {
  const s = setup();
  s.addApp('a', 'VN-000001', 'Vendor', 'V one', 'New');
  s.addApp('b', 'VN-000002', 'Vendor', 'V two', 'Accepted');
  s.addApp('c', 'FP-000001', 'Franchise', 'F one', 'Rejected');
  s.addApp('d', 'FP-000002', 'Franchise', 'F two', 'Under Review');
  for (const id of ['a', 'b', 'c', 'd']) s.service.create({applicationId: id});
  s.service.setRead(A1, s.service.list(A1).items.find((i) => i.appId === 'VN-000002').id, true);

  const names = (opts) => s.service.list(A1, opts).items.map((i) => i.name).sort();
  assert.deepEqual(names({type: 'Vendor'}), ['V one', 'V two']);
  assert.deepEqual(names({type: 'Franchise'}), ['F one', 'F two']);
  assert.deepEqual(names({status: 'Pending'}), ['F two', 'V one']);
  assert.deepEqual(names({status: 'Approved'}), ['V two']);
  assert.deepEqual(names({status: 'Rejected'}), ['F one']);
  assert.deepEqual(names({status: 'New'}), ['F one', 'F two', 'V one'], 'V two was marked read');
  assert.deepEqual(names({type: 'Franchise', status: 'New'}), ['F one', 'F two']);
});

test('the list shows the fields the admin needs, with IST date and time', () => {
  const s = setup();
  s.addApp('app-1', 'FP-000007', 'Franchise', 'Ravi Kumar');
  s.service.create({applicationId: 'app-1'});
  const [item] = s.service.list(A1).items;
  assert.equal(item.appId, 'FP-000007');
  assert.equal(item.type, 'Franchise');
  assert.equal(item.name, 'Ravi Kumar');
  assert.equal(item.mobile, '9876543210');
  assert.equal(item.email, 'applicant@example.com');
  assert.equal(item.status, 'Pending');
  assert.equal(item.unread, true);
  // 04:30 UTC is 10:00 IST on the same day
  assert.equal(item.submissionDate, istDate('2026-11-18T04:30:00.000Z'));
  assert.equal(item.submissionTime, istTime('2026-11-18T04:30:00.000Z'));
  assert.match(item.submissionTime, /10:00/);
});

test('status mapping: undecided applications show as Pending, Accepted as Approved', () => {
  assert.equal(displayStatus('New'), 'Pending');
  assert.equal(displayStatus('Contacted'), 'Pending');
  assert.equal(displayStatus('Under Review'), 'Pending');
  assert.equal(displayStatus('Documents Pending'), 'Pending');
  assert.equal(displayStatus('Accepted'), 'Approved');
  assert.equal(displayStatus('Rejected'), 'Rejected');
});

test('the admin email has the agreed subject and every required field, and escapes applicant text', () => {
  const msg = adminApplicationEmail(
    {app_id: 'VN-000003', type: 'Vendor', name: 'Lakshmi <script>x</script>', mobile: '9876543210',
      submitted_at: '2026-11-18T04:30:00.000Z'},
    {dashboardUrl: 'https://site.test/dashboard/?notification=n1', status: 'Pending'},
  );
  assert.equal(msg.subject, 'New Vendor / Franchise Application Received – On The Way Logistics');
  assert.equal(msg.subject, EMAIL_SUBJECT);
  for (const line of ['Application ID: VN-000003', 'Applicant Name: Lakshmi <script>x</script>',
    'Application Type: Vendor', 'Mobile Number: 9876543210', 'Application Status: Pending',
    'https://site.test/dashboard/?notification=n1']) assert.ok(msg.text.includes(line), line);
  assert.match(msg.text, /Submission Date and Time: .*10:00.* IST/);
  assert.equal(msg.html.includes('<script>'), false, 'applicant HTML is escaped');
  assert.ok(msg.html.includes('&lt;script&gt;'));
});

test('a new notification sends one email; the record shows it as sent', async () => {
  const s = setup();
  s.addApp('app-1', 'FP-000001', 'Franchise', 'Ravi Kumar');
  const {id} = s.service.create({applicationId: 'app-1', dashboardBase: 'https://site.test'});
  const result = await s.service.sendEmail(id, {actor: 'system'});
  assert.equal(result.sent, true);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].to, 'admin@example.com');
  assert.equal(s.sent[0].subject, EMAIL_SUBJECT);
  assert.match(s.sent[0].text, /notification=/);
  const status = s.service.emailStatusOf(id);
  assert.equal(status.status, 'sent');
  assert.equal(status.attempts, 1);
  // a second call does not send again
  await s.service.sendEmail(id);
  assert.equal(s.sent.length, 1);
  assert.ok(s.audit.some((a) => a.action === 'admin_notification_email_sent'));
});

test('a failed email keeps the application and notification, records the reason, and is retried later', async () => {
  const s = setup({failTimes: 1});
  s.addApp('app-1', 'VN-000009', 'Vendor', 'Vendor Nine');
  const {id} = s.service.create({applicationId: 'app-1'});
  const first = await s.service.sendEmail(id);
  assert.equal(first.sent, false);
  assert.equal(s.service.list(A1).items.length, 1, 'notification still listed');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM partner_applications').get().n, 1, 'application kept');
  const failed = s.service.emailStatusOf(id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.ok(failed.error.length > 0 && failed.error.length <= 300, 'reason kept and capped');

  // not yet due: nothing is sent
  assert.equal(await s.service.processDue(), 0);
  s.advance(3); // the first retry waits 2 minutes
  assert.equal(await s.service.processDue(), 1);
  assert.equal(s.sent.length, 1);
  assert.equal(s.service.emailStatusOf(id).status, 'sent');
});

test('retries stop at the attempt limit and the admin can still resend by hand', async () => {
  const s = setup({failTimes: 99, maxAttempts: 2});
  s.addApp('app-1', 'FP-000002', 'Franchise', 'F Two');
  const {id} = s.service.create({applicationId: 'app-1'});
  await s.service.sendEmail(id); // attempt 1 fails
  s.advance(5);
  await s.service.processDue(); // attempt 2 fails
  assert.equal(s.service.emailStatusOf(id).attempts, 2);
  s.advance(600);
  assert.equal(await s.service.processDue(), 0, 'no more automatic attempts');
  // the admin resends by hand once the mail server works again
  s.fail(0);
  const manual = await s.service.sendEmail(id, {actor: 'admin@example.com'});
  assert.equal(manual.sent, true);
  assert.equal(s.service.emailStatusOf(id).status, 'sent');
  assert.equal(s.sent.length, 1);
});

test('no admin address configured: the email is marked failed with a clear reason', async () => {
  const s = setup({recipients: []});
  s.addApp('app-1', 'FP-000003', 'Franchise', 'F Three');
  const {id} = s.service.create({applicationId: 'app-1'});
  const result = await s.service.sendEmail(id);
  assert.equal(result.sent, false);
  assert.match(s.service.emailStatusOf(id).error, /ADMIN_EMAIL/);
  assert.equal(s.sent.length, 0);
});

test('recipients are de-duplicated and invalid addresses are ignored', async () => {
  const s = setup({recipients: ['a@example.com', 'a@example.com', 'not an email', ' b@example.com ']});
  s.addApp('app-1', 'FP-000004', 'Franchise', 'F Four');
  const {id} = s.service.create({applicationId: 'app-1'});
  await s.service.sendEmail(id);
  assert.equal(s.sent[0].to, 'a@example.com, b@example.com');
});
