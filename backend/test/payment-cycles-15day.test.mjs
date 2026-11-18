// Run with:  node --test --no-warnings test/payment-cycles-15day.test.mjs   (from the backend folder)
// A 15-day payment period (for example 1-15 Sep) is stored next to the weekly records of the same rider, never over them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createWeeklyPaymentService} from '../weekly-payments.js';

const require = createRequire(import.meta.url);
const PX = require('../../dashboard/payment-excel.js');

const sheet = rows => [{name: 'Payments', rowOffset: 0, grid: [
  ['WEEK', 'RIDER ID', 'RIDER NAME', 'DAYS', 'LM ORDERS', 'PRIME ORDERS', 'CLUB ORDERS', 'SDD ORDERS', 'WEEKLY AMOUNT'], ...rows]}];

test('a range longer than a week is a 15-day cycle with its own key; a 7-day range stays weekly', () => {
  assert.equal(PX.cycleOf('2026-09-01', '2026-09-15'), '15-day');
  assert.equal(PX.cycleOf('2026-09-01', '2026-09-07'), 'weekly');
  assert.equal(PX.keyOf('2026-09-01', '2026-09-15'), 'f:2026-09-01');
  assert.equal(PX.keyOf('2026-09-01', '2026-09-07'), 'd:2026-09-01');
});

test('a sheet with a 15-day range and a weekly range for the same rider keeps both periods apart', () => {
  const res = PX.parseSheets(sheet([
    ['01/09/2026 - 15/09/2026', 'R001', 'Ravi', 15, 300, 200, 100, 0, 5500],
    ['01/09/2026 - 07/09/2026', 'R001', 'Ravi', 7, 140, 90, 50, 0, 2500],
  ]));
  assert.equal(res.ok, true, res.error);
  const keys = res.records.map(r => r.weekKey).sort();
  assert.deepEqual(keys, ['d:2026-09-01', 'f:2026-09-01']);
});

test('saving: weekly and 15-day records of one rider are two rows; the cycle is reported on each', () => {
  const db = new DatabaseSync(':memory:');
  const svc = createWeeklyPaymentService({db});
  const res = PX.parseSheets(sheet([
    ['01/09/2026 - 15/09/2026', 'R001', 'Ravi', 15, 300, 200, 100, 0, 5500],
    ['01/09/2026 - 07/09/2026', 'R001', 'Ravi', 7, 140, 90, 50, 0, 2500],
  ]));
  const out = svc.importRecords({fileName: 'sep.xlsx', fileHash: 'h1', records: res.records});
  assert.equal(out.inserted, 2);
  const {records} = svc.list();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => r.cycle).sort(), ['15-day', 'weekly']);
  // importing the same sheet again changes nothing, and does not merge the two periods
  const again = svc.importRecords({fileName: 'sep.xlsx', fileHash: 'h1', records: res.records});
  assert.equal(again.inserted + again.updated, 0);
  assert.equal(svc.list().records.length, 2);
});
