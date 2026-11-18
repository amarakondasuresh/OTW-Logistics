# Payments Amount Source Fix

## Behavior
- Weekly payment `amount` is read only from the selected amount cell in the uploaded XLSX row.
- A blank, missing, unavailable, or invalid amount is normalized to numeric `0` and displayed as `₹0.00`.
- No payment amount is inferred from order counts, rates, or formula text. Cached XLSX cell values are read as supplied by the workbook; if a formula cell has no cached result, its amount is `₹0`.
- LM / Prime / Club / SDD amount columns are populated only from explicit source fields; absent fields are `₹0`.
- Every saved weekly payment requires a verified Rider ID. The unique period key is combined with that Rider ID. Ambiguous or unmatched IDs are not imported.
- Re-importing a changed workbook updates the same Rider ID + payment period record; re-importing an identical file hash does not create duplicates.
- Weekly Payments table, totals, rider week detail summary, and rider latest-payment values use the saved XLSX period amount.

## Updating data
Upload the changed XLSX again in Admin → Payments, or use the configured Google Drive sync if enabled. The application does not watch an arbitrary local PC file in the background; it updates after upload or sync.

## Validation
Run from `backend/`:
```bash
npm test
```
All 218 backend tests pass after this change.
