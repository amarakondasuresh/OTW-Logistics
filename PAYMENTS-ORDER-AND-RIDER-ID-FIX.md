# Payments – Oldest-first Order and Verified Rider IDs

## Order
Weekly Payments lists the oldest week at the top and the latest at the bottom, compared as real dates.
Undated rows go last. S.NO is sequential after sorting. Reports use the same saved rows.

## Rider IDs
The server checks every imported row against Rider Registration (live, non-rejected applications):
- Rider ID and name both match a registration: saved under that registration's ID.
- Rider ID is not registered, but the name matches exactly one registration: saved under that registration's ID.
  The correction is listed in the import report.
- Rider ID is registered to a different name, the name matches several registrations, or the rider is not
  registered: held for Admin review and NOT saved. No ID is invented.
- If no row can be verified, nothing is saved and the reason is shown.

Earlier rows saved under a different ID are kept (nothing is deleted). When a new import covers the same rider and
week under the verified ID, the older row is listed as a conflict to review.

## Tests
`cd backend && node --test --no-warnings test/weekly-payments.test.mjs` (36 tests).
