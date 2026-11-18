import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanInput, typeOf, normalizeMobile, isValidEmail, isValidPin, isValidDateOfBirth, isValidYears, categoryForYears,
  validatePublicApplication, recordFields, REMOVED_FIELDS, APPLICATION_FIELDS, REQUIRED,
} from '../partner-application.js';

const franchiseForm = {
  fullName: '  Ravi Kumar ',
  dateOfBirth: '1990-05-14',
  gmail: 'ravi@example.com',
  contactNumber: '+91 98765 43210',
  whatsappNumber: '+91 98765 43211',
  state: 'Andhra Pradesh',
  district: 'Anantapuramu',
  cityOrVillage: 'Hindupur',
  locationArea: 'Hindupur Bus Stand',
  pincode: '515201',
  address: '12 Main Road, near bus stand',
  yearsOfExperience: '5',
  additionalMessage: 'Interested in two-wheeler delivery',
};

const vendorForm = {
  fullName: 'Lakshmi Devi',
  dateOfBirth: '1984-11-02',
  gmail: 'swift@example.com',
  contactNumber: '9876543210',
  whatsappNumber: '9876543212',
  state: 'Andhra Pradesh',
  district: 'Tirupati',
  cityOrVillage: 'Renigunta',
  locationArea: 'Renigunta Industrial Area',
  pincode: '517520',
  address: 'Plot 4, Industrial Area',
  yearsOfExperience: '10',
};

test('removed vendor fields are never accepted or stored', () => {
  assert.deepEqual([...REMOVED_FIELDS], ['gstNumber', 'panNumber', 'serviceType']);
  for (const field of REMOVED_FIELDS) assert.equal(APPLICATION_FIELDS.includes(field), false, field);

  const cleaned = cleanInput({ ...vendorForm, gstNumber: '36AABCU9603R1ZX', panNumber: 'ABCDE1234F', serviceType: 'Warehousing' });
  for (const field of REMOVED_FIELDS) assert.equal(field in cleaned, false, field);
  assert.equal(cleaned.fullName, 'Lakshmi Devi');
});

test('answers are trimmed and kept under their field names', () => {
  const cleaned = cleanInput(franchiseForm);
  assert.equal(cleaned.fullName, 'Ravi Kumar');
  assert.equal(cleaned.dateOfBirth, '1990-05-14');
  assert.equal(cleaned.whatsappNumber, '+91 98765 43211');
  assert.equal(cleaned.locationArea, 'Hindupur Bus Stand');
  assert.equal(cleaned.pincode, '515201');
  assert.equal(cleaned.yearsOfExperience, '5');
});

test('unknown fields and nested objects are ignored', () => {
  const cleaned = cleanInput({ ...franchiseForm, hack: '<script>', nested: { a: 1 } });
  assert.equal('hack' in cleaned, false);
  assert.equal('nested' in cleaned, false);
});

test('type defaults to Franchise unless Vendor is given', () => {
  assert.equal(typeOf('vendor'), 'Vendor');
  assert.equal(typeOf('Vendor'), 'Vendor');
  assert.equal(typeOf('Franchise'), 'Franchise');
  assert.equal(typeOf(''), 'Franchise');
  assert.equal(typeOf(undefined), 'Franchise');
});

test('mobile numbers: 10 digits starting 6-9, country code and spaces allowed', () => {
  assert.equal(normalizeMobile('+91 98765 43210'), '9876543210');
  assert.equal(normalizeMobile('98765-43210'), '9876543210');
  assert.equal(normalizeMobile('9876543210'), '9876543210');
  assert.equal(normalizeMobile('1234567890'), '');
  assert.equal(normalizeMobile('98765'), '');
  assert.equal(normalizeMobile('abcdefghij'), '');
});

test('email check', () => {
  assert.equal(isValidEmail('ravi@example.com'), true);
  assert.equal(isValidEmail('ravi@example'), false);
  assert.equal(isValidEmail('ravi example.com'), false);
  assert.equal(isValidEmail(''), false);
});

test('years of experience accepts only whole numbers from 0 to 10', () => {
  for (const value of ['0', '1', '5', '10']) assert.deepEqual(validatePublicApplication(cleanInput({ ...franchiseForm, yearsOfExperience: value, applicantCategory: categoryForYears(value), salarySlipMonths: value === '0' ? '' : '3' }), 'Franchise'), []);
  for (const value of ['11', '1.5', '-1', 'abc', '01x', '100']) assert.ok(validatePublicApplication(cleanInput({ ...franchiseForm, yearsOfExperience: value }), 'Franchise').some(e => e.startsWith('Years of Experience must be')), value);
});

test('years of experience maps to applicant category: 0 is Fresher, 1 to 10 is Experienced', () => {
  assert.equal(categoryForYears('0'), 'Fresher');
  for (let n = 1; n <= 10; n++) assert.equal(categoryForYears(String(n)), 'Experienced', String(n));
  for (const value of ['', '11', '-1', '1.5', 'abc', undefined]) assert.equal(categoryForYears(value), '', String(value));
  assert.equal(isValidYears('0'), true);
  assert.equal(isValidYears('10'), true);
  assert.equal(isValidYears('11'), false);
});

test('applicant category that does not match the years is rejected', () => {
  const wrongFresher = validatePublicApplication(cleanInput({ ...franchiseForm, yearsOfExperience: '4', applicantCategory: 'Fresher' }), 'Franchise');
  assert.ok(wrongFresher.includes('Applicant Category must match Years of Experience.'));
  const wrongExp = validatePublicApplication(cleanInput({ ...franchiseForm, yearsOfExperience: '0', applicantCategory: 'Experienced' }), 'Franchise');
  assert.ok(wrongExp.includes('Applicant Category must match Years of Experience.'));
});

test('complete franchise form passes validation', () => {
  assert.deepEqual(validatePublicApplication(cleanInput(franchiseForm), 'Franchise'), []);
});

test('franchise form lists every missing required field', () => {
  const errors = validatePublicApplication(cleanInput({ fullName: 'Ravi' }), 'Franchise');
  const text = errors.join('\n');
  for (const label of ['Date of Birth', 'Email Address', 'Mobile Number', 'WhatsApp Number', 'State',
    'District', 'Village / City Name', 'Location / Area Name', 'PIN Code', 'Full Address',
    'Years of Experience']) {
    assert.ok(text.includes(label), `missing error for ${label}`);
  }
  assert.equal(text.includes('Full Name is required'), false);
});

test('franchise form no longer asks for investment capacity or preferred location', () => {
  const errors = validatePublicApplication(cleanInput(franchiseForm), 'Franchise');
  assert.deepEqual(errors, []);
  assert.equal(REQUIRED.Franchise.includes('investmentCapacity'), false);
  assert.equal(REQUIRED.Franchise.includes('preferredLocation'), false);
});

test('franchise WhatsApp number, PIN, date of birth and years are checked', () => {
  const errors = validatePublicApplication(cleanInput({
    ...franchiseForm, whatsappNumber: '12345', pincode: '012345', dateOfBirth: '2999-01-01', yearsOfExperience: '99',
  }), 'Franchise');
  assert.ok(errors.some(e => e.startsWith('WhatsApp Number must be')));
  assert.ok(errors.some(e => e.startsWith('PIN Code must be')));
  assert.ok(errors.some(e => e.startsWith('Date of Birth is not')));
  assert.ok(errors.some(e => e.startsWith('Years of Experience must be')));
  assert.ok(validatePublicApplication(cleanInput({ ...franchiseForm, yearsOfExperience: '11' }), 'Franchise').some(e => e.startsWith('Years of Experience must be')));
});

test('date of birth must be a real past date in YYYY-MM-DD', () => {
  const today = new Date(Date.UTC(2026, 10, 4));
  assert.equal(isValidDateOfBirth('1990-05-14', today), true);
  assert.equal(isValidDateOfBirth('2026-11-04', today), true);
  assert.equal(isValidDateOfBirth('2026-11-05', today), false);
  assert.equal(isValidDateOfBirth('1990-02-30', today), false);
  assert.equal(isValidDateOfBirth('14/05/1990', today), false);
  assert.equal(isValidDateOfBirth('', today), false);
});

test('PIN codes: six digits, first digit 1-9', () => {
  assert.equal(isValidPin('515201'), true);
  assert.equal(isValidPin('051520'), false);
  assert.equal(isValidPin('51520'), false);
  assert.equal(isValidPin('5152011'), false);
  assert.equal(isValidPin('51520a'), false);
});

test('complete vendor form passes; GST/PAN/service type are not required and not stored', () => {
  const input = cleanInput(vendorForm);
  assert.deepEqual(validatePublicApplication(input, 'Vendor'), []);
  const fields = recordFields(input, 'Vendor');
  assert.equal(fields.name, 'Lakshmi Devi');
  assert.equal(fields.contact, 'Lakshmi Devi');
  assert.equal(fields.mobile, '9876543210');
  assert.equal(fields.whatsapp, '9876543212');
  assert.equal(fields.email, 'swift@example.com');
  assert.equal(fields.city, 'Renigunta');
  assert.equal(fields.locality, 'Renigunta Industrial Area');
  assert.equal(fields.pincode, '517520');
  assert.equal(fields.yearsOfExperience, '10');
  assert.equal(fields.address, 'Plot 4, Industrial Area');
});

test('vendor validation requires the same territory fields and checks mobile, PIN and years', () => {
  const errors = validatePublicApplication(cleanInput({ ...vendorForm, fullName: '', contactNumber: '12345', pincode: '12' }), 'Vendor');
  assert.ok(errors.some(e => e.startsWith('Full Name is required')));
  assert.ok(errors.some(e => e.startsWith('Mobile Number must be')));
  assert.ok(errors.some(e => e.startsWith('PIN Code must be')));
  const missing = validatePublicApplication(cleanInput({ fullName: 'Lakshmi' }), 'Vendor');
  for (const label of ['Date of Birth', 'Location / Area Name', 'PIN Code', 'Full Address', 'Years of Experience']) {
    assert.ok(missing.some(e => e.startsWith(label)), label);
  }
});

test('franchise record keeps the applicant name, WhatsApp, area, PIN and experience', () => {
  const fields = recordFields(cleanInput(franchiseForm), 'Franchise');
  assert.equal(fields.name, 'Ravi Kumar');
  assert.equal(fields.contact, 'Ravi Kumar');
  assert.equal(fields.mobile, '9876543210');
  assert.equal(fields.whatsapp, '9876543211');
  assert.equal(fields.locality, 'Hindupur Bus Stand');
  assert.equal(fields.pincode, '515201');
  assert.equal(fields.yearsOfExperience, '5');
  assert.equal(fields.address, '12 Main Road, near bus stand');
  assert.equal(fields.remarks, 'Interested in two-wheeler delivery');
  assert.equal(fields.state, 'Andhra Pradesh');
});
