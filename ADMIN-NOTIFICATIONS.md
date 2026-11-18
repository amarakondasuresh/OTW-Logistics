# Admin notifications for Franchise / Vendor applications

## What changed
- `backend/admin-notifications.js` (new): one notification per saved application, per-admin read / unread / delete,
  admin email with delivery log, retries and resend.
- `backend/server.js`: submission saves the application and its notification in one transaction; duplicate-submit
  protection (submission key); real-time stream `GET /api/admin/notifications/stream`; notification routes;
  retry worker. Admin entries from the dashboard (JSON) are separated from public submissions (multipart), so an
  admin testing the public form in the same browser is notified like any visitor.
- `dashboard/notifications.js` (new), `dashboard/index.html`, `dashboard/app.js`, `dashboard/styles.css`:
  Notifications page, nav and bell badges, popup, sound toggle, live updates, email-link deep link.
- `website/partner-forms.js`: sends one submission key per form.
- `backend/test/admin-notifications.test.mjs` (new), `backend/package.json` (test script), `.env.example`, `backend/README.md`.

Nothing that existed before was removed. Existing statuses (New, Contacted, Under Review, Documents Pending,
Accepted, Rejected) are kept; the dashboard shows undecided ones as Pending and Accepted as Approved.

## Setup
Set `ADMIN_EMAIL` in `backend/.env` (comma-separated for several admins). Leave it empty to use every active
admin's email. Email sending uses the existing `GMAIL_USER` / `GMAIL_APP_PASSWORD` (or SMTP) settings.
Set `PUBLIC_URL` so the link in the admin email opens the live dashboard.

## Manual test checklist
1. Open the Vendor or Franchise form, fill every required field, press Submit Application once.
2. The application appears in Partner Applications with a new VN- or FP- ID.
3. An admin who is signed in sees a popup "New Vendor/Franchise Application Received!", hears the sound (after one
   click on the page), and the bell and Notifications badges increase, without a refresh.
4. The admin email arrives with subject "New Vendor / Franchise Application Received – On The Way Logistics".
5. Notifications > View Application shows the full form and marks the notification read.
6. Mark as Unread / Mark as Read / Delete work; deleting keeps the application.
7. Sign out, sign in again: unread notifications are still listed and counted.
8. Press Submit twice quickly: only one application and one notification are created.
9. If email fails (wrong app password), the application and notification are still saved; the row shows
   "Failed" with the reason, and Resend works once the setting is fixed.

Automated tests: `cd backend && npm test` (or `node --test --no-warnings test/admin-notifications.test.mjs`).
