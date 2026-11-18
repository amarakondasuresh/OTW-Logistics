# ONTHEWAY LOGISTICS Payment Backend

This backend is the secure integration layer for the Payments → AutoPay page.

## Test mode first
1. Create a Razorpay account and use **Test/Sandbox** API credentials.
2. Create one Razorpay Subscription Plan for each frequency you want to offer and put the plan IDs in `.env`.
3. Copy `.env.example` to `.env` and fill only the server-side credentials.
4. Install Node.js 20+.
5. Run `npm install` then `npm start`.
6. Open `http://localhost:8080/`.
7. For webhooks, deploy the backend to a public **HTTPS** URL; Razorpay webhooks cannot use a private localhost URL for production delivery.
8. In Razorpay Dashboard, configure the webhook URL as `/api/razorpay/webhook` and use the same webhook secret as `RAZORPAY_WEBHOOK_SECRET`.

## Security
- API secrets remain in `.env` on the server; never put them in `index.html` or `app.js`.
- Webhook signatures are checked with HMAC SHA-256 before updating transaction state.
- The frontend never marks a gateway payment successful by itself.
- No UPI PIN, CVV or raw card credentials are stored.
- The four authorized admin emails are enforced by the backend API as an additional layer; production authentication should be moved to a real server-side session/identity provider before public launch.
- Use HTTPS, secure server sessions, database backups and a secrets manager for production.

## Important
The supplied website remains usable as a browser/localStorage admin demo. Until this backend is deployed and configured, AutoPay records are **authorization requests/configuration only**; no real money is moved. Live payments must not be enabled until Razorpay onboarding/KYC, HTTPS, webhook verification and end-to-end sandbox testing are complete.


## Shared Franchise/Vendor Applications
The public website posts new applications to `POST /api/partner-applications`. The admin dashboard loads them from `GET /api/partner-applications` after opening **Partner Applications**. The API stores applications in the same SQLite database file as the backend (`payments.sqlite`). Keep the backend running while testing both pages.

For local testing, start the backend from this folder with `npm install` and `npm start` (port 8080 by default). The public site uses `http://localhost:8080`; change `PARTNER_API_BASE` in the dashboard `app.js` and the URL in the public website submit handler if your deployed backend has a different address. Set `ALLOWED_ORIGIN` to your deployed website origin before production use.

## Payment imports (Admin Portal → Payments)
- Each Excel file that is imported is saved as a numbered version (`payment_import_versions`) with all its rows (`payment_import_rows`). Earlier versions are kept and can be read with `GET /api/admin/payment-imports` (list) and `GET /api/admin/payment-imports/rows?version=<id>&status=<matched|review|unmatched|no_partner>` (rows).
- The latest successful version is the active data source. A failed import changes nothing. The same file (same SHA-256 hash) is never imported twice.
- Rider matching (see `payment-imports.js`): the Rider ID and name are compared with the rider registrations and the partner that registered each rider. Matched rows are shared only with that vendor or franchise. A matching ID with a different name is flagged for review. A name match with a different ID is not assigned. Riders registered by the Admin, rejected riders, and riders of inactive partners are not shared.
- Each partner's Orders page is rebuilt from the active version inside the same database transaction. Orders entered by the partner are kept.
- 365-day Monday-to-Sunday cycles: `payment-cycles.js`.

## Google Drive payment sync (Admin Portal → Payments)
- The admin connects one Google account once (**Connect Google Drive**), then chooses the folder that holds the payment Excel files. Read-only Drive access is requested.
- Every file in that folder is checked on the schedule set by `DRIVE_SYNC_MINUTES` (default 15), and **Sync Now** runs a check immediately. A file is re-read only when its Google modified time or checksum has changed.
- Drive files go through the same Excel reader and the same Weekly Payments save rules as a manual upload. A file that cannot be read is marked **Sync Failed** with the reason, and no payment rows change.
- Setup: create a Google Cloud OAuth client (Web application), enable the Google Drive API, add the redirect URI (`PUBLIC_URL` + `/api/admin/drive/callback`), then fill `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `DRIVE_TOKEN_SECRET` in `.env`. Run `npm install` once after updating, since `xlsx` was added.
- Google-native Sheets files are not read. Save the payment sheet as .xlsx or .xls in the folder.
- Routes (admin only): `GET /api/admin/drive`, `GET /api/admin/drive/connect`, `GET /api/admin/drive/callback`, `GET /api/admin/drive/folders`, `POST /api/admin/drive/folder`, `POST /api/admin/drive/sync`, `POST /api/admin/drive/disconnect`.
- Tests: `node --test --no-warnings test/drive-sync.test.mjs`

## Weekly and 15-day payment cycles
- A payment period is **weekly** when its dates span 7 days or fewer (1–7 Aug), and **15-day** when it spans more than a week (1–15 Sep).
- Each rider has separate records for each period. The rule is Rider ID + period: importing the same period again updates that record, and a different period always adds a new record. Earlier periods are never overwritten.
- The Payments table has a cycle filter (All / Weekly / 15-day). 15-day rows are marked with a badge.
- A 15-day period is recognised from its date range in the sheet (the WEEK / period column, or the title above the table). Daily settlement sheets are still grouped into weeks.


## Franchise / Vendor applicant document uploads

The public Franchise and Vendor forms now require an applicant category (Fresher or Experienced) and an Aadhaar Card file. Experienced applicants must select either 3 or 6 months and upload exactly that many individual salary-slip files. PDF, JPG and PNG files are accepted; each file is limited to 5 MB. The backend validates file signatures rather than trusting browser MIME types.

Applicant documents are stored outside the public website in `backend/uploads/partner-applications/`, encrypted at rest using AES-256-GCM, and can be downloaded only by a signed-in admin through the Partner Applications > View form screen. Download attempts are written to the admin audit log. The encryption key is generated at `backend/uploads/.partner-document-key` on first startup (or may be supplied as a base64-encoded 32-byte `PARTNER_DOCUMENT_ENCRYPTION_KEY` environment variable).

**Production hosting requirement:** configure a persistent private volume for `backend/uploads/` and keep it backed up together with `backend/payments.sqlite`. Do not put this folder under a public/static directory. Back up the encryption key securely; losing it makes previously uploaded documents permanently unreadable. Use HTTPS for the live website and admin portal.

## Admin notifications for new Franchise / Vendor applications

When a website visitor submits a Franchise or Vendor application, the server:

1. Saves the application and its unique ID (FP-000001 / VN-000001) in `partner_applications`. The save and the admin notification are one database transaction, so a notification never exists without its application.
2. Creates one row in `admin_notifications` for that application (the application ID is unique, so a repeated submit cannot create a second notification).
3. Pushes the notification to every open Admin Dashboard at once through `GET /api/admin/notifications/stream` (Server-Sent Events, signed-in admins only). Admins who are offline find the notification in the database when they sign in again.
4. Emails `ADMIN_EMAIL` (or every active admin's email when it is empty) with subject **New Vendor / Franchise Application Received – On The Way Logistics**. The email is sent after the answer goes back to the visitor and never blocks it.

Delivery is recorded per notification: `sent`, `failed` (with the reason) or `pending`. A failed email is retried automatically after 2, 4, 8, 16 and 32 minutes (five attempts in total); the admin can also press **Resend** in the Notifications page. A failed email never removes the application or the notification.

Each admin has their own read / unread / deleted state. Deleting a notification removes it only from that admin's list; the application stays in Partner Applications.

Duplicate protection: the public forms send a submission key created once per form. The server returns the already-saved application for a repeated key instead of creating another one.

Routes (all require a signed-in admin):
- `GET /api/admin/notifications?type=Vendor|Franchise&status=New|Pending|Approved|Rejected` (list and unread count)
- `GET /api/admin/notifications/stream` (real-time)
- `POST /api/admin/notifications/:id/read`, `/unread`, `/delete`, `/resend-email`

"New" means unread for this admin. "Pending" covers every undecided application (stored as New, Contacted, Under Review or Documents Pending). "Approved" is an accepted application.

Tests: `node --test --no-warnings test/admin-notifications.test.mjs`

