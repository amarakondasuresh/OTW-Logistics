// Run with:  node --test test/hub-excel.test.mjs   (from the backend folder)
// Tests the browser-side Excel/CSV helpers in ../dashboard/hub-excel.js (they are plain functions, no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const HubExcel = require('../../dashboard/hub-excel.js');

test('CSV: quoted cells, doubled quotes, line breaks inside quotes and CRLF line endings', () => {
  const grid = HubExcel.parseCsvGrid('Hub Name,Address\r\n"AMP, Main","12 ""Old"" Road\nBlock B"\r\nX,Y');
  assert.deepEqual(grid, [['Hub Name', 'Address'], ['AMP, Main', '12 "Old" Road\nBlock B'], ['X', 'Y']]);
});

test('CSV: semicolon and tab separators are detected; a byte-order mark is ignored', () => {
  assert.deepEqual(HubExcel.parseCsvGrid('\uFEFFHub Name;State\nA;B'), [['Hub Name', 'State'], ['A', 'B']]);
  assert.deepEqual(HubExcel.parseCsvGrid('Hub Name\tState\nA\tB'), [['Hub Name', 'State'], ['A', 'B']]);
});

test('header: column names are matched without caring about spaces, dashes or capitals', () => {
  assert.equal(HubExcel.headerKey('Hub In-Charge Full Name'), 'hiName');
  assert.equal(HubExcel.headerKey('HI NAME'), 'hiName');
  assert.equal(HubExcel.headerKey('Phone Number'), 'phone');
  assert.equal(HubExcel.headerKey('Hub Contact Number'), 'contactNumber');
  assert.equal(HubExcel.headerKey('Hub Email ID'), 'email');
  assert.equal(HubExcel.headerKey('Hub Opening Date'), 'openingDate');
  assert.equal(HubExcel.headerKey('Hub URL'), 'url');
  assert.equal(HubExcel.headerKey('Hub Code'), 'code');
  assert.equal(HubExcel.headerKey('POD'), 'pod');
  assert.equal(HubExcel.headerKey('Vehicle No'), null);
});

test('a sheet with a title above the header row still imports every hub row', () => {
  const grid = [
    ['ON THE WAY LOGISTICS - HUB MASTER'],
    [],
    ['Hub Code', 'Hub Name', 'City', 'State', 'HI Name', 'Phone Number', 'POD', 'Region', 'Vehicle'],
    ['AMP_BlackBridge', 'AMP_BlackBridge', 'Amalapuram', 'Andhra Pradesh', 'Vipparthi Prema Kiran', '9014377900', 'POD_AP/TS', 'East', 'KA-1'],
    [],
    ['', '', '', '', '', '', '', '', ''],
    ['AKP_Anakapalle_TH', 'AKP_Anakapalle_TH', 'Anakapalli', 'Andhra Pradesh', 'Surisetti Syam Kiran', '7799068212', 'POD_AP/TS', 'East', 'KA-2'],
  ];
  const result = HubExcel.hubRowsFromGrid(grid, 'Master');
  assert.equal(result.found, true);
  assert.equal(result.headerRow, 3);
  assert.equal(result.rows.length, 2);
  assert.equal(result.blank, 2);
  assert.deepEqual(result.ignored, ['Vehicle'], 'unknown columns are reported, not imported');
  const first = result.rows[0];
  assert.equal(first.code, 'AMP_BlackBridge', 'Hub Code is kept for existing data');
  assert.equal(first.name, 'AMP_BlackBridge');
  assert.equal(first.hiName, 'Vipparthi Prema Kiran', 'HI Name maps to the in-charge name');
  assert.equal(first.phone, '9014377900');
  assert.equal(first.pod, 'POD_AP/TS');
  assert.equal(first.region, 'East');
  assert.equal(first.sheet, 'Master');
  assert.equal(first.rowNumber, 4, 'row number as it appears in the file');
  assert.equal(first.contactNumber, '', 'columns missing from the file are blank, not left out');
});

test('a sheet with no hub header is skipped and named; other sheets still import', () => {
  const result = HubExcel.hubRowsFromSheets([
    {name: 'Notes', grid: [['just some text'], ['more text']]},
    {name: 'Hubs', grid: [['Hub Name', 'State'], ['Gunter Hub', 'Telangana']]},
  ]);
  assert.deepEqual(result.skippedSheets, ['Notes']);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sheet, 'Hubs');
});

test('duplicate column names are reported and only the first one is used', () => {
  const r = HubExcel.hubRowsFromGrid([['Hub Name', 'State', 'Phone', 'Phone Number'], ['A', 'B', '9876543210', '1']]);
  assert.deepEqual(r.duplicated, ['Phone Number']);
  assert.equal(r.rows[0].phone, '9876543210');
});

test('dates: Excel day numbers and JavaScript Date cells become yyyy-mm-dd', () => {
  // 45366 is 2024-03-15 in Excel's day numbering
  assert.equal(HubExcel.excelSerialToIso(45366), '2024-03-15');
  const grid = [['Hub Name', 'State', 'Hub Opening Date'], ['A', 'B', 45366], ['C', 'D', new Date(Date.UTC(2025, 5, 1))]];
  const r = HubExcel.hubRowsFromGrid(grid);
  assert.equal(r.rows[0].openingDate, '2024-03-15');
  assert.equal(r.rows[1].openingDate, '2025-06-01');
});

test('numbers and empty cells come through as text; pincodes keep their digits', () => {
  const grid = [['Hub Name', 'State', 'Hub Pincode', 'Phone Number'], ['A', 'B', 522002, 9876543210], ['C', 'D', null, undefined]];
  const r = HubExcel.hubRowsFromGrid(grid);
  assert.equal(r.rows[0].pincode, '522002');
  assert.equal(r.rows[0].phone, '9876543210');
  assert.equal(r.rows[1].pincode, '');
});

test('a file with no hub header reports that nothing was found', () => {
  assert.equal(HubExcel.hubRowsFromGrid([['Random', 'Table']]).found, false);
  assert.equal(HubExcel.hubRowsFromGrid([]).found, false);
});
