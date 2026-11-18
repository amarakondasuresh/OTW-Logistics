# Payments Excel Import – Root Cause and Fix

## Root cause
The import checks each rider against the Rider Registration database on the server (rider_registrations).
The Admin Riders list on the Payments side is stored in the browser (localStorage) and is separate. A rider who is
in Admin Riders but was never registered through Rider Registration is not in rider_registrations, so every row
failed and the whole file was rejected with "No rider row could be verified".

## What changed
- No file is rejected as a whole. Verified rows are saved; unverified rows go to Pending Rider Verification with the
  Excel Rider ID, rider name, week and the reason.
- Matching: exact Rider ID plus name; exact name after normalising case, spacing and brackets (for example
  "Appari Ravi Kumar (palakollu 1)" matches "Appari Ravi Kumar (Palakollu 1)"); a name that matches exactly one
  registration when the Excel ID is not registered (the correction is reported). Several matches or a conflicting
  ID are never accepted automatically.
- Admin can map a pending row to a registered rider. The choice is recorded in the audit log.
- Each import re-checks pending rows; a row that now verifies (for example after registration) is imported.
- The import message shows the real counts: Excel records, imported, pending, updated and unchanged rows.
- Reports use the same saved records, so pending rows are not in Reports until they are verified and saved.

## Tests
cd backend && node --test --no-warnings test/weekly-payments.test.mjs   (40 tests)
