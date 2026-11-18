# Rider edit and master-directory update

## Admin Riders page
- The Active Riders `Edit` action now opens the full profile editor: Rider ID, rider name, 10-digit mobile number, 6-digit hub pincode, hub location, selfie/screenshot, and Aadhaar.
- Existing saved documents are retained when no replacement file is selected. New/replacement files are validated and stored privately by the backend (5 MB limit).
- Saving updates the existing registration while preserving its approval status and payment history. If a legacy active rider has no registration record yet, the editor creates the registration with both documents and records the admin approval.
- Only admins may update registration details.

## Excel master directory
- `Rider_Master_Directory.xlsx` was read and 64 rows with complete, unambiguous rider names were added to `backend/data/rider-master-directory.json`.
- 17 rows with clipped/ellipsis names were excluded to avoid matching the wrong person.
- Only the 26 valid 10-digit phone numbers present in the workbook are used. Rows with a missing phone number preserve the existing phone number.
- The directory is served only through the authenticated admin endpoint `/api/rider-master-directory?portal=admin`; phone numbers are not embedded in the public dashboard JavaScript.
- When an admin opens Riders, existing rider records are matched by normalized exact rider name. Rider ID and available phone number are updated. Payment/work records matched by rider name have their rider ID reference updated; payment amounts and history are not changed.
- The sync is safe to repeat. Names with multiple matches or conflicting Rider IDs are skipped rather than guessed.

## Apply
1. Back up the current backend database and `backend/uploads` folder.
2. Replace the project with this ZIP.
3. Restart the backend using `START-WINDOWS.bat`.
4. Sign in to the Admin Portal and open Riders. The master directory sync runs there.
5. Open an Active Rider and use Edit to update hub details or replace documents.

## Validation
- JavaScript syntax checked for dashboard and backend files.
- Rider-registration tests: 31 passed, 0 failed.


## Safety correction in this package
- Removed the one-time browser startup operation that cleared `db.riders`.
- Existing rider records are preserved when the Admin dashboard starts.
- Back up existing browser data, the backend database and uploads before deployment.
