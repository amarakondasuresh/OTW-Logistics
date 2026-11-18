# Rider ID – Documents – Payments Linking

## What changed

- The Riders page `View` action now opens a consolidated rider profile.
- The profile resolves the rider registration and its securely stored selfie/screenshot and Aadhaar documents by normalized Rider ID.
- The profile lists weekly payment history from the admin weekly-payments API, filtered by exact normalized Rider ID.
- The profile lists daily/manual payment rows from the local admin data, filtered by exact normalized Rider ID.
- The profile includes shortcuts to the Documents and Payments modules, pre-filtered to that Rider ID.
- The Documents module now shows the secure registration selfie and Aadhaar preview actions for the matching Rider ID, alongside other document uploads.
- Weekly payment row details now include an Open Rider Profile action.

## Data safety

- No payment amounts or historical rows are deleted or recalculated by these UI changes.
- No document files are moved or made public. Registration documents continue to use the authenticated admin-only file endpoint.
- Records are associated by Rider ID, not by a loose rider-name match. Rows without a Rider ID remain unlinked rather than being attributed to the wrong person.

## Install

1. Back up the existing project folder and backend database/uploads directory.
2. Extract this ZIP and replace the project files.
3. Keep the existing `.env`, database and `backend/uploads` files.
4. Restart `START-WINDOWS.bat` and refresh the Admin Portal with Ctrl+F5.
5. Open Riders and click View to see the linked profile.
