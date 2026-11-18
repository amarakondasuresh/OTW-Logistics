# OTW Logistics – Payments and Reports Connection

The Admin Payments and Reports sections use one saved data source.

## How it works
1. Open Admin Panel → Payments.
2. Import the weekly Excel workbook and complete any Rider Verification/mapping shown by Payments.
3. The import is saved in the backend SQLite `weekly_payments` table.
4. Open Admin Panel → Reports. The report endpoint reads the same `weekly_payments` rows; no second upload is required.
5. Reopen or refresh Reports after an import to load the latest saved data.

## Report coverage
- 15-day reporting periods (1–15 and 16–month end).
- 365-day/year reporting with monthly buckets.
- Rider, date, month, year and hub filters.
- Prime, Club, LM and SDD counts, plus saved Excel amount totals.

## Verification
Run from the `backend` directory:

```bash
node --test --no-warnings test/reports.test.mjs
```

The report suite includes an integration test that imports data through the Payments service and verifies that Reports returns those saved records. In the supplied project, all 11 report tests pass. The full backend test suite currently has 8 failures in the weekly-payment rider-verification tests; those are separate from the Payments-to-Reports integration test and should be addressed separately.

## Payment status and the week reports (added)
- Every saved rider-week has a payment status: **Pending**, **Processing**, **Paid** or **Failed**. New rows start as Pending.
- The Admin sets the status on Reports → Rider report details (the Payment Status column). Only the status changes; the amount, Rider ID, week and import history are left as saved. No row is deleted.
- An Excel re-import never changes a status. It only updates the amounts and figures of a rider-week it finds again.
- Reports cards show Total Riders, Total Orders, Total Payment Amount, Total Paid, Total Pending, Processing and Failed.
- A fixed section shows the Previous Week and Current Week (Monday to Sunday cycles around today), the current Month, and the last 365 days. A stacked chart compares the previous and current week by status. These blocks ignore the filters above them.
- A record longer than seven days (a 15-day cycle) is never placed in a week, so two weeks never share data.

Tests: `node --test --no-warnings test/payments-reports-sync.test.mjs` (10 tests, included in `npm test`).

## Franchise and vendor order reports (removed)
- The Franchise orders and Vendor orders sections, their order-detail tables and their endpoints
  (`/api/admin/franchise-orders-report`, `/api/admin/vendor-orders-report`) were removed from the Admin Reports page.
- The saved data is untouched: Franchise and Vendor Portal Orders pages still read the same records.
