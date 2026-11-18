// Run with:  node --test --no-warnings test/partner-emails.test.mjs   (from the backend folder)
// Wording and safety of the emails sent to Franchise / Vendor applicants.
import test from 'node:test';
import assert from 'node:assert/strict';
import {submittedEmail, approvedEmail, rejectedEmail, newPasswordEmail} from '../partner-emails.js';

const app = {
  appId: 'FP-000007', type: 'Franchise', name: 'Lakshmi Prasanna', mobile: '9123456780', whatsapp: '9123456780',
  email: 'lakshmi@example.com', state: 'Andhra Pradesh', district: 'Krishna', city: 'Vijayawada', locality: 'Benz Circle',
  pincode: '520010', submittedAt: '2026-11-15T06:30:00Z',
};
const login = {portalUrl: 'https://otw.example.in/franchise/', loginId: 'FP-000007', password: 'abcd-EFGH-2345'};

test('submitted: application ID, type, date and the details the applicant gave', () => {
  const m = submittedEmail(app, {supportEmail: 'help@otw.in'});
  assert.equal(m.subject, 'Application received: FP-000007 (Franchise)');
  for (const part of ['Dear Lakshmi Prasanna', 'franchise partner', '15 November 2026', 'FP-000007', 'Benz Circle, Vijayawada, Krishna, Andhra Pradesh', '520010', 'help@otw.in'])
    assert.ok(m.text.includes(part), part);
  assert.ok(!m.text.includes('WhatsApp number'), 'WhatsApp is not repeated when it equals the mobile number');
  assert.ok(m.html.includes('Application submitted') && m.html.includes('FP-000007'));
  const v = submittedEmail({...app, type: 'Vendor', appId: 'VN-000003'});
  assert.equal(v.subject, 'Application received: VN-000003 (Vendor)');
  assert.ok(v.text.includes('vendor partner'));
});

test('approved with a new login: portal, ID and temporary password; optional team message', () => {
  const m = approvedEmail(app, {login, note: 'Onboarding call on Monday', supportEmail: 'help@otw.in'});
  assert.equal(m.subject, 'Application approved: FP-000007 (Franchise)');
  for (const part of ['Congratulations', 'https://otw.example.in/franchise/', 'Franchise ID: FP-000007', 'Temporary password: abcd-EFGH-2345', 'choose your own password', 'Message from our team: Onboarding call on Monday'])
    assert.ok(m.text.includes(part), part);
  assert.ok(m.html.includes('abcd-EFGH-2345'));
});

test('approved again (login switched back on): no password in the email', () => {
  const m = approvedEmail(app, {login: {...login, password: ''}});
  assert.ok(m.text.includes('login works again'));
  assert.ok(!/Temporary password/.test(m.text));
  assert.ok(!m.text.includes('Message from our team'), 'no empty team message');
});

test('rejected: polite, with the reason only when one is given', () => {
  const withReason = rejectedEmail(app, {note: 'Area already covered by another franchise'});
  assert.equal(withReason.subject, 'Application update: FP-000007 (Franchise)');
  assert.ok(withReason.text.includes('unable to approve your application'));
  assert.ok(withReason.text.includes('Reason: Area already covered by another franchise'));
  assert.ok(withReason.text.includes('apply again'));
  assert.ok(!rejectedEmail(app).text.includes('Reason:'));
  assert.ok(!/temporary password/i.test(withReason.text));
});

test('new password from the admin', () => {
  const m = newPasswordEmail(app, {login});
  assert.ok(m.text.includes('new temporary password') && m.text.includes('abcd-EFGH-2345'));
});

test('anything typed by the applicant or admin is escaped in HTML and kept on one line in the subject', () => {
  const evil = {...app, name: '<script>alert(1)</script>', appId: 'FP-1\r\nBcc: x@evil.com', city: '"><img src=x onerror=alert(1)>'};
  for (const m of [submittedEmail(evil), approvedEmail(evil, {login, note: '<b>hi</b>'}), rejectedEmail(evil, {note: '<i>no</i>'})]) {
    assert.ok(!m.html.includes('<script>') && !m.html.includes('<img') && !m.html.includes('<b>hi') && !m.html.includes('<i>no'));
    assert.ok(m.html.includes('&lt;script&gt;'));
    assert.ok(!/[\r\n]/.test(m.subject), 'no line breaks in the subject');
  }
});
