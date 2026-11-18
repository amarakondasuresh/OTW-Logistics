// Real-file check: the daily settlement Excel fixture goes through the existing Excel reader, then the per-day rows
// (as the browser sends them) through the versioned import. Run from the backend folder:
//   node --test --no-warnings test/payment-imports-fixture.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createPaymentImportService} from '../payment-imports.js';

const require = createRequire(import.meta.url);
const PX = require('../../dashboard/payment-excel.js');
const grids = JSON.parse(fs.readFileSync(new URL('./fixtures/grids.json', import.meta.url), 'utf8'));

// Excel serial day number -> YYYY-MM-DD
const serialToISO = n => new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);

// Per-day rows exactly as the browser builds them from the sheet.
function perDayRows() {
  const out = [];
  for (const rec of PX.parseSheets(grids['daily-settlement-two-weeks']).records) {
    for (const day of rec.original.days) {
      out.push({riderId: day['Rider ID'], name: day['Rider Name'], date: serialToISO(day['Order Date']),
        lm: day['Total LM Orders'], primary: day['Total Primary Orders'], club: day['Total Club Orders'], amount: day['Payout Amount']});
    }
  }
  return out;
}

function registrations() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY, role TEXT, login_id TEXT, status TEXT);
    CREATE TABLE rider_registrations(id TEXT PRIMARY KEY, application_id TEXT, rider_id TEXT, rider_key TEXT, rider_name TEXT,
      registration_source TEXT, owner_account_id TEXT, owner_login_id TEXT, application_status TEXT);
    INSERT INTO accounts VALUES ('F1','franchise','FP-000001','active'), ('F2','franchise','FP-000002','active');
    INSERT INTO rider_registrations VALUES
      ('r1','RM-1','OTW-101','OTW-101','Appari Ravi Kumar','Franchise','F1','FP-000001','APPROVED'),
      ('r2','RM-2','OTW-102','OTW-102','Shaik Ahmad Sharief','Franchise','F2','FP-000002','APPROVED'),
      ('r3','RM-3','OTW-107','OTW-107','Mohammed Fazzaley Khaza','Admin',NULL,NULL,'APPROVED');`);
  return db;
}

test('the real daily settlement file imports one row per rider per day and routes each rider to its own franchise', () => {
  const rows = perDayRows();
  assert.equal(rows.length, 20, 'every data row of the sheet (21 lines minus the header) is a row');
  const service = createPaymentImportService({db: registrations()});
  const out = service.importRows({fileName: 'daily-settlement-two-weeks.xlsx', fileHash: 'fixture-1', records: rows});
  assert.equal(out.version.rows, 20);
  assert.equal(out.version.matched, rows.filter(r => r.riderId !== 'OTW-107').length);
  assert.equal(out.version.noPartner, rows.filter(r => r.riderId === 'OTW-107').length);
  assert.equal(out.version.review, 0);
  const f1 = service.rowsOf({ownerAccountId: 'F1'}).rows;
  const f2 = service.rowsOf({ownerAccountId: 'F2'}).rows;
  assert.ok(f1.length > 0 && f2.length > 0);
  assert.ok(f1.every(r => r.riderId === 'OTW-101'), 'franchise F1 sees only its own rider');
  assert.ok(f2.every(r => r.riderId === 'OTW-102'), 'franchise F2 sees only its own rider');
});

test('a day from the real file keeps its exact order counts and payout', () => {
  const service = createPaymentImportService({db: registrations()});
  service.importRows({fileName: 'daily.xlsx', fileHash: 'fixture-2', records: perDayRows()});
  const first = service.rowsOf({ownerAccountId: 'F1'}).rows.find(r => r.date === '2026-10-22');
  assert.equal(first.lm, 24);
  assert.equal(first.primary, 20);
  assert.equal(first.club, 4);
  assert.equal(first.amount, 419);
});

test('importing the same real file again changes nothing', () => {
  const service = createPaymentImportService({db: registrations()});
  service.importRows({fileName: 'daily.xlsx', fileHash: 'fixture-3', records: perDayRows()});
  const again = service.importRows({fileName: 'daily.xlsx', fileHash: 'fixture-3', records: perDayRows()});
  assert.equal(again.alreadyImported, true);
  assert.equal(service.listVersions().versions.length, 1);
});
