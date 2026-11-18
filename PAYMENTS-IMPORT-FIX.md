# ON THE WAY LOGISTICS – Payments Import Fix

This update repairs the Admin Portal weekly Payments Excel reader for the uploaded `On going sheet(AutoRecovered).xlsx` layout.

## Changes

- Detects repeated weekly table headers in one worksheet and imports each weekly block separately.
- Uses each block's date-range title as the source of truth when Excel date cells were auto-converted to incorrect dates.
- Handles the malformed `11/-10-2026` title in the supplied workbook as `11-10-2026`.
- Counts valid daily entries, including a valid `0/0` entry, as an entered day.
- Parses daily `LM/Primary` values into LM, Prime and Club counts; derives Total Orders from the first number in the daily cells.
- Reads the saved `Payment Completed` amount from the workbook, including cached formula results.
- When the workbook formula explicitly calculates category pay (for example `Primary * 18 + Club * 6`), stores those category amounts separately.
- Adds database columns for Total Orders and category amounts, with an automatic SQLite migration that preserves existing payment rows.
- Maps Rider IDs only when a unique exact-name match exists in the Admin Riders list. It does not invent IDs for unmatched riders.
- Displays missing amount components as an em dash instead of `N/A`; a genuine zero remains `0`.
- Preserves duplicate protection and updates corrected imports instead of duplicating rider/week rows.

## Verification against the uploaded workbook

For Appari Ravi Kumar, 31/08/2026–06/09/2026:

- Days: 7
- Total Orders / LM: 150
- Prime: 144
- Club: 6
- Prime Amount: ₹2,592 (from the workbook formula)
- Club Amount: ₹36 (from the workbook formula)
- Total Amount: ₹2,628 (cached Excel formula result)

The supplied workbook contains 10 weekly blocks (24/08/2026–01/11/2026) and 163 readable rider/week records. It does not contain the full January–December 2026 year; the import will show the weeks actually present in each uploaded file and will support further weekly blocks as they are added.

The workbook does not provide an LM amount or SDD amount formula/rate for all rows. Those fields are left blank (shown as —), not fabricated. The workbook also has no Rider ID column. Unique exact-name matches are filled from the Admin Riders list; unmatched names need a Rider ID in Excel or a matching rider record in Admin > Riders.

## Apply the update

1. Back up `backend/payments.sqlite` and `backend/uploads/` before replacing the project.
2. Extract this ZIP and replace the existing project files with the included files.
3. Start the backend normally using `START-WINDOWS.bat` (Windows) or `start-mac-linux.sh` (Mac/Linux).
4. Sign in to Admin Portal > Payments and import the Excel workbook again. The database migration runs automatically when the backend starts.
5. Check the import summary and compare the Appari Ravi Kumar row above.

## Tests

`cd backend && npm test`

All 218 backend tests passed during this update, including a new regression test using the supplied workbook.
