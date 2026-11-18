# Admin Payments and Reports – One Data Source

## Source of truth
Admin Portal → Payments saves each rider's weekly row in the `weekly_payments` table (one row per Rider ID + week).
Reports now reads those same rows through `GET /api/admin/reports`. An Excel import in Payments therefore updates
Reports with no second upload. Reports loads fresh data each time it opens (no caching).

The older partner-portal `orderRecords` are no longer used for Reports. They are kept as they were, and the partner
portals still show them.

## Reports rules
- One row per rider per saved week. Weeks are never combined. Each rider-week is counted once.
- 15-day and 365-day periods: a record belongs to the period that contains its week START date.
- Order ID is a GENERATED reference: ORD-<Rider ID>-<week start yyyymmdd>. Excel carries no order numbers, so the
  reference is not a transaction ID. Rider ID is not shown as a column; it is used internally for matching.
- Total Orders is the Excel value, never raised. Total Amount is the Excel Amount, exactly as saved.
- A missing category amount is shown as — (not 0). A real 0 is shown as ₹0.00 / 0.
- Filters: start/end date, month, year, rider name/ID, order ID, hub location. They apply to cards, the period
  table, the rider table, the chart, Excel export and PDF export together.

## Limits
- Hub location comes from the partner rider lists. Riders without a hub are counted in the quality note.
- The Admin Riders list (used to fill Rider IDs for Excel rows that have no ID column) is stored in the browser.

## Tests
`cd backend && node --test --no-warnings test/reports.test.mjs` (11 tests, including an integration test that
imports the fixture into the Payments tables and checks Reports matches Payments).
