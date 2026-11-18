# Rider Registration & Payments Excel Automation Fix

This update changes the Admin weekly-payments import flow.

## What changed

- Weekly Payments now matches against the server-side `rider_registrations` table. Only riders with `application_status = APPROVED` are eligible for automatic matching or Admin mapping; PENDING applications remain provisional.
- Matching checks Rider ID and normalized rider name. If the Excel ID is stale but the normalized name uniquely identifies one live registration, the registered ID is used and a correction is reported.
- Name normalization ignores casing, spacing, punctuation and bracket style, but preserves meaningful text inside brackets (for example, different hub names are not silently merged).
- Unmatched or ambiguous riders receive a separate provisional profile in `weekly_payment_provisional_riders` and their weekly payment rows are saved under a stable internal provisional key. This does not create an approved Rider Registration, grant portal access, or invent personal details.
- Each provisional weekly row remains in Pending Rider Verification.
- One Map action saves an Admin-confirmed mapping for that Excel rider identity and resolves all of that rider's pending weekly periods, not just the selected week. The server independently checks APPROVED status, so an unapproved rider cannot be mapped through a direct API request.
- Mapping transfers the saved provisional payment rows to the permanent registered Rider ID, removes the provisional weekly keys, and persists for future imports.
- Weekly Payments rows show a Pending Verification marker when they are still provisional.
- The existing daily-layout import continues to populate available daily payment and Daily Work rows. Weekly aggregate-only sheets do not generate invented daily details. When a provisional daily rider is mapped, local daily payment and work rows linked to that provisional profile are updated to the selected registered ID.

## Database additions

- `weekly_payment_rider_mappings`: persistent Admin-confirmed Excel-to-registration mappings.
- `weekly_payment_provisional_riders`: provisional profiles awaiting Admin verification.

Both tables are created automatically by the weekly-payment service on server startup. Existing registration and payment tables are retained.

## Validation

Backend test suite: **244 passed, 0 failed**. A regression test confirms that PENDING registrations cannot be used until approved.

Run from `backend/`:

```bash
npm test
```

## Important

A provisional profile is not an approved rider registration. Complete the real Rider Registration workflow and approval before granting Vendor or Franchise portal access.


## Admin workflow after this update

1. In Admin Portal, open **Rider Registration** and locate the rider. Complete the registration review and set the application status to **APPROVED**.
2. Restart the backend by closing the old server window and launching `START-WINDOWS.bat` from File Explorer, or run `npm start` from `backend/`. Keep the server window open.
3. Refresh the Admin Portal page (Ctrl+F5).
4. Open **Payments** and find **Pending Rider Verification**. Click **Refresh** if the section was already open.
5. Select the newly approved rider from the dropdown and click **Map**. One mapping resolves all pending weeks for that Excel rider identity.

If the rider is still PENDING, they will not appear in the mapping dropdown. Payment rows remain saved as pending; they are not deleted or assigned to an unapproved profile.

**Windows note:** Do not use the VS Code Code Runner play button to execute a `.bat` file when its path contains spaces. Double-click `START-WINDOWS.bat` in File Explorer, or use the VS Code terminal: `.\START-WINDOWS.bat` from the project folder.
