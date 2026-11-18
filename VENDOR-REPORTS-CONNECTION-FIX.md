# Vendor Portal – Orders and Reports connected (fix)

## Why Reports showed 0
The Vendor Portal Orders page reads the saved weekly payment rows from the server (`/api/portal/weekly-payments`).
The Reports page was calculating from the partner's older manual `orderRecords` list, which is empty for vendors who
only receive Excel imports, and from the vendor's own manually-added rider list. Neither was the Excel data, so every
card stayed at 0.

## What changed
- `backend/partner-reports.js` (new): builds the Reports figures on the server from the same rows the Orders page
  shows (`listForVendor`), plus the vendor's approved riders (`rider_registrations`, Vendor source, APPROVED, owned by
  this vendor). Rows are counted once per rider and week. Total Orders is the Excel value, never recalculated.
- `backend/server.js`: `/api/portal/weekly-payments` returns `report` for vendors, alongside the same `records`.
  Franchise responses are unchanged.
- `vendor-portal/app.js`: Reports is drawn from that one response. Orders and Reports are repainted together on
  Refresh, on the one-minute refresh, and on a new payment notification.
- `vendor-portal/index.html` and `style.css`: labels only, an SDD column and SDD bar added; layout and colours unchanged.
- The 15-day "Daily order trend" was replaced by a per-period trend, because Excel rows are weekly/15-day, not daily.

## Mapping
Total Orders → Weekly Total Orders and All-Time Total Orders · Prime Orders → Primary · Club Orders → Club ·
LM Orders → Large · SDD Orders → SDD (order mix and 15-day table).

## Tests
`cd backend && node --test --no-warnings test/partner-reports.test.mjs` (10 tests). The full backend suite, run
without the `npm install` dependencies, passes: 268 of 268.
