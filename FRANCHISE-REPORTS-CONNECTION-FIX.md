# Franchise Portal – Orders and Reports connected (fix)

## Why Franchise Reports showed 0
Franchise Orders reads the saved weekly payment rows from the server. Franchise Reports was still calculating from the
partner's old manual `orderRecords` list and the franchise's own manual rider list, so it never saw the Excel data.

## What changed
- `backend/partner-reports.js`: one report builder for both partner types. Vendors use the Vendor registrations and
  franchises use the Franchise registrations (owner account, APPROVED status). Rows are the same rows the Orders page
  shows, matched by Rider ID and counted once per rider-week.
- New `week` option: `/api/portal/weekly-payments?week=<start..end>` returns the chosen weekly period. Without it, the
  newest weekly cycle is shown. Periods available are listed in `report.weeks`.
- `backend/server.js`: the weekly-payments endpoint returns `report` for vendors and franchises. Records are unchanged.
- Franchise Portal and Vendor Portal Reports: the cards read from that report. A Week selector sits beside the Weekly
  Order Summary and uses the same Week labels as Orders. SDD appears in the weekly bars and the 15-day table.
- The 15-day daily trend is replaced by a per-period trend (Excel data is weekly and 15-day, not daily).

## Tests
`cd backend && node --test --no-warnings test/partner-reports.test.mjs` covers franchise isolation, Rider ID matching,
the Kandi Nithin week (24/08/2026 – 30/08/2026), week selection, and vendor/franchise separation. The full backend suite
passes without the npm dependencies installed.
