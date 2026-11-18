# Payments Table Back / Next Navigation

## What changed
- Added Back and Next controls immediately below the Weekly Payments table.
- The table displays 25 records per page.
- Back is disabled on the first page; Next is disabled on the last page.
- Page navigation only changes the visible slice of already-loaded records. It does not delete, overwrite, or re-import payment records.
- The current search text and selected cycle remain applied while navigating.
- Changing the search text or cycle returns the view to page 1.
- The visible record range and current page number are shown beside the controls.
- Controls wrap and remain usable on narrow/mobile screens.

## Files changed
- `dashboard/app.js`
- `dashboard/styles.css`

## Validation
- `node --check dashboard/app.js` passed.
- Backend test suite: 218 passed, 0 failed.

## Install
1. Back up the existing project and database.
2. Extract this ZIP.
3. Replace the project files with the files in this ZIP.
4. Restart the backend/server and refresh the Admin Payments page.
5. Use Back / Next below the Weekly Payments table.
