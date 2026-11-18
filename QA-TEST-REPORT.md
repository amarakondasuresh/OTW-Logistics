# QA test report and fixes (15 Nov 2026)

The whole project was tested end to end in a real browser (Chrome) against a fresh database, from a website
application through admin approval, partner sign-in, rider registration, Excel payment import, partner Orders /
Reports / Notifications, admin Reports and exports, Hubs, Documents, Settings and the Rider Performance page.
All 292 backend tests pass (`cd backend && npm test`).

## Bugs found and fixed

| # | Where | Problem | Fix |
|---|-------|---------|-----|
| 1 | Whole site | The server allowed only 120 requests per minute per IP for **everything**, including images, CSS and scripts. Clicking through a few admin pages made the next page load blank ("Too many requests"); a shared office connection hit it constantly. | The general limit now applies to the API only (300/min). Sign-in, applications, support and screenshot reading keep their own stricter limits. |
| 2 | Admin > Payments > Import Excel | Every weekly sheet import crashed at the end (`parsed is not defined`), so the import summary never appeared. | Fixed the variable scope. |
| 3 | Admin > Payments | The summary counted unverified rows as "Successfully imported" (e.g. "5 records, 5 imported, 2 pending"). | Only verified rows count as imported; pending rows are listed separately. |
| 4 | Vendor / Franchise Reports and Dashboard | Weekly sheets without a "Total Orders" column showed **0 orders** to partners while Admin Reports showed numbers. | Such sheets now store Total Orders = LM, the same rule the daily and date-column sheets already used. Partner Reports use the Admin Reports rule for older rows, so both sides agree. |
| 5 | Vendor / Franchise Notifications | Partners were never notified after a weekly payment import (only the older daily import notified). | Each partner whose approved riders got new or changed rows is notified (import, Admin mapping, or approval of a pending rider). |
| 6 | Admin Dashboard | "Today's deliveries 204 / completed 172 / pending 32 / failed 12 / 92%" and the bar chart were hard-coded numbers. | Replaced with real figures from saved payments: latest week's orders, Prime / Club split, payments pending, orders per week (last 7 periods) and amount paid. |
| 7 | Admin > Riders / Dashboard | Approved riders from the database never appeared in the Riders list (it existed only in each admin's browser), so a new browser showed "No riders found" and Total Riders 0. | Approved registrations are synced into the list for every admin; a matching provisional Excel profile is converted instead of duplicated. |
| 8 | Admin > Riders | Search by phone number did not work (a second function with the same name silently replaced the rider search). | Renamed the Documents helper. |
| 9 | Admin > Documents | "Upload" kept only the **file name** in the browser; the file itself was discarded and could never be opened. | Files are now stored privately on the server (`backend/uploads/admin-documents/`), visible to every admin, with View / Download / Delete and audit-log entries. Older name-only entries are marked "please upload again". |
| 10 | Admin > Hub | The Excel import (preview + confirm) existed but no button opened it. | "📥 Import Excel" button restored next to "+ Add New Hub". |
| 11 | Admin > Payments | Google Drive sync (described in the README, with code and tests) was never connected to the server or shown in the admin panel. | Routes, the scheduled check and a "Google Drive Sync" card are now active. Without Google keys in `backend/.env` the card explains what to add. |
| 12 | Rider Applications (Admin, Vendor, Franchise) | The screenshot auto-fill (Rider ID / name read from the delivery-app screenshot) only existed on an older partner page that can no longer be opened. | Choosing the screenshot in **Add New Member** now fills Rider ID and Rider Name (read on this server, highlighted for checking, never overwrites typed values). |
| 13 | Admin panel offline | Excel import / export, charts and PDF export loaded their libraries from a CDN; without internet they stopped working. | The same library versions are bundled in `dashboard/lib/` (CDN kept as fallback). |
| 14 | Tests | 4 tests failed after the code was reformatted; 3 "must not contain" checks had silently stopped checking anything; 2 test files were not part of `npm test`; the two sample weekly Excel files were missing the required SDD Orders column. | Tests made format-independent, all test files included, sample files regenerated. New tests for documents, notifications and totals. |
| 15 | Admin > Settings | Said everything was "stored in this browser for this demo website". | Describes what is on the server and what stays in the browser; the reset only clears browser data. |

## Second round (same day): new feature and further fixes

**New: Admin Portal > Hub In-charge.** Add, edit, activate / deactivate Hub In-charges (HI ID, name, phone, email,
assigned hub); see the riders linked to each one; **Link**, **Transfer** (with reason), **Unlink** (with reason) and
**History** for every rider. Only approved riders can be linked; "Activate & Link" switches on the rider account first.
An inactive Hub In-charge keeps its riders but cannot receive new ones. Nothing is deleted: every change keeps who,
when and why. Orders and payments stay with the Rider ID. The list of approved riders not yet linked is shown too.
(Routes: `backend/hub-incharge-routes.js`; screen: `dashboard/hub-incharges.js`.)

| # | Where | Problem | Fix |
|---|-------|---------|-----|
| 16 | Admin Dashboard | After marking a payment Paid on Reports, the Dashboard kept showing the old Paid / Pending amounts. | The Dashboard reloads payment rows when they are older than 10 seconds or were just changed, and redraws only when something changed. |
| 17 | Website, Vendor and Franchise portals, Rider Performance | No tab icon was set, so every page logged a "not found" error for `favicon.ico`. | The company logo is now the tab icon on every page. |
| 18 | README | Said there is exactly one Super Admin; `SUPER_ADMIN_EMAIL` actually adds one (the earliest admin stays Super Admin). | Wording corrected. |

Also checked in this round and working as designed: Reject / Undo / re-approve of partner applications (login switched
off and back on with the partner's own password), partner password reset, vendors rejecting their own riders
(franchise is read-only), payment status from Reports, report filters, Admin Accounts switch off / on, partner
notifications badge, Orders search / filter / refresh, partner password change, location removal, rider profile and
edit, and the website and Vendor Portal at phone width. Tests: 293 pass.

## Third round: admin Forgot password

Tested with a stand-in mail server: when email works, the reset link flow was already correct (link arrives, opens the
new-password form, works once, unknown emails get the same answer). What failed in practice:

| # | Problem | Fix |
|---|---------|-----|
| 19 | With email not set up (as in your `.env`), Forgot password was a dead end: "ask the site owner". | The request now goes to the **Super Admin**: orange counter on Settings, a pop-up after sign-in, and a highlighted row in **Settings → Admin Accounts**. The Super Admin clicks **Temporary password**: shown once with a copy button; the admin must choose a new password at the next sign-in, other devices are signed out, older reset links stop working. Audited; not for your own account. |
| 20 | With a wrong Gmail App Password (or no internet), the page said "link sent" but nothing arrived; the error only appeared in the server window. | The server signs in to the mail server to check the settings (at start-up, then cached). If it fails, Forgot password uses the Super Admin route and the server window and Admin Accounts say exactly what is wrong (e.g. "must be a 16-character Google App Password, not the normal Gmail password"). |
| 21 | Reset form kept an old error message while retyping. | Cleared as you type. |

The sign-in page answer stays the same for every email address, so it does not reveal who is an admin.
Tests: 298 pass (new: `admin-password-help.test.mjs`).

## Fourth round: admin names and emails

| # | Request | Change |
|---|---------|--------|
| 22 | Set real names and emails for the first-start placeholders *Admin 3* / *Admin 4* (`admin3@` / `admin4@onthewaylogistics.in`). | **Settings → Admin Accounts → Edit** (Super Admin): change any admin's full name and registered email (also the sign-in ID). Email must be valid and not used by another account; the password stays the same; reset links sent to the old address stop working. Non-Gmail addresses get a "check this is correct" note. |
| 23 | Add more admins without the server command line. | **+ Add admin**: name + email; a temporary password is shown once and must be changed at first sign-in. A new admin is a normal admin, not a Super Admin. |

Tested: placeholders renamed, old emails stop signing in, the original temporary password works with the new email, a fresh
temporary password works, a new admin can sign in, duplicate emails and empty names are refused, editing your own name
updates the top bar. Tests: 302 pass (new: `admin-edit.test.mjs`).

## Fifth round: emails to applicants

| # | Request | Change |
|---|---------|--------|
| 24 | Email Vendor / Franchise applicants when the application is submitted, rejected and approved. | **Submitted** (website applications): application ID and their details; the confirmation page says it is on its way. **Approved**: portal address, ID and temporary password in one email (re-approval: "your login works again", no password). **Rejected**: polite email with the reason if typed. Plain text + simple branded HTML, replies go to `SUPPORT_EMAIL`. Also: partner **Reset password** now emails the new password with the right wording (it used to say "accepted"). |
| 25 | Admin control and visibility. | Approve / Reject window: **Email the applicant** tick box (on by default; the note is included). Result shown in the confirmation message. **View form** shows each application's email history (sent / not sent and why). Undo never emails. A slow or broken mail server can no longer hold up a decision (connection time limits). |

Tested with a stand-in mail server: every email arrives at the applicant's address with the right subject and content, the
password in the approval email matches the one shown to the admin, a partner can sign in with the emailed password,
unticking the box sends nothing, and applicant-typed text cannot inject HTML. Without email settings (your current
`.env`) nothing is sent and the history says why. Tests: 308 pass (new: `partner-emails.test.mjs`).

## Sixth round: riders under each vendor / franchise

| # | Request | Change |
|---|---------|--------|
| 26 | When the admin searches for a vendor or franchise, show all the riders under it. | **Client** search (name, VN / FP ID, phone, city, district...) now also lists **Riders of matching Vendors / Franchises**: one group per partner with every rider it registered (approved / pending / rejected counts), mobile, hub, status, registration date, and payment weeks, orders and amount from the imported Excel. Each partner row has **🛵 Riders (N)** (same list in a window) and **⬇ Export riders** (Excel). **View** opens the rider's registration. Riders never mix between partners; admin-registered riders are not listed under a partner. |

Tested: search by name, ID and city (two partners), no match and empty search hide the list, the Riders button,
the Excel export columns, and opening a rider. Tests: 312 pass (new: `partner-riders.test.mjs`).

## Seventh round: ban vendor / franchise logins

| # | Request | Change |
|---|---------|--------|
| 27 | A Ban button for every vendor / franchise to limit their login. | **🚫 Ban** on every Client row with a portal login (and in View form): 1 / 3 / 7 / 30 days, until a date, or until unbanned, with an optional reason. The partner is signed out at once; signing in shows the suspension with the end date and reason (only after the correct password). The application status, riders, orders and payments are unchanged. **✓ Unban** restores access with their own password; timed bans end by themselves. Row badge **🚫 Banned**, ban details and history in View form, the riders list shows "login banned", audit log entries. |

Tested: an open vendor session ends right after the ban, the sign-in message (7-day, until unbanned, until a date), a past
end date is refused, unban works, the application stays Approved. Tests: 316 pass (new: `partner-ban.test.mjs`).

## Eighth round: admin cannot sign in

The sign-in itself works (tested with your database: a temporary password signs in and asks for a new password; wrong
details say "Incorrect ID or password"). In your database M. Balajinaik and Admin 3 already chose their own passwords on
14 Nov, so their lines in `FIRST-ADMIN-PASSWORDS.txt` no longer work.

| # | Problem | Fix |
|---|---------|-----|
| 28 | If another copy of the server was still running (e.g. from an older extracted folder), a new start printed "running on http://localhost:8080" and then stopped silently. The browser kept using the **other** copy and its database, so correct passwords were refused. | The window now says **NOT STARTED: port 8080 is already in use** and what to do. A normal start shows the **Database:** path in use. |
| 29 | Getting back in needed the command line. | **RESET-ADMIN-PASSWORD.bat** (double-click): lists the admins in this folder's database, asks for the email, shows a new temporary password once. Works while the server runs. |
| 30 | The full project ZIPs also contained the database, `.env` and `FIRST-ADMIN-PASSWORDS.txt` you uploaded on 14 Nov. Unzipping one over your folder with "Replace" put the database back to that day's state. | Updates now come as ZIPs with only the changed files (no database). `.gitignore` also excludes `ADMIN-TEMPORARY-LOGIN-CREDENTIALS.txt`, logs and ZIPs. |

Tests: 316 pass.

## Ninth round: sender address and Zepto logo

| # | Request | Change |
|---|---------|--------|
| 31 | Send applicant emails from ontheway5579@gmail.com. | `GMAIL_USER=ontheway5579@gmail.com` in `backend/.env` (and `.env.example`). Tested with a stand-in mail server: "Application received" and "Application approved" come from "ON THE WAY LOGISTICS" (ontheway5579@gmail.com); replies go to `SUPPORT_EMAIL` (onthewaynpr@gmail.com). Real sending starts once that account's App Password is in `GMAIL_APP_PASSWORD`. The approval email's portal link uses `PUBLIC_URL` (otherwise localhost). |
| 32 | Zepto logo in the home page scrolling strip. | Added after AJIO in both halves of the loop (same speed: 47 s for 7 logos). Logo file supplied by you, cropped and resized only: `website/assets/partners/zepto.png`. |

## Tenth round: old copy still answering (Version 10)

| # | Problem | Fix |
|---|---------|-----|
| 33 | After unzipping a new version, the browser still showed the **original** admin panel (no Riders / Ban buttons, old search text). The original server was still running on port 8080; START-WINDOWS.bat opened the browser anyway, so the old copy answered. | START-WINDOWS.bat now checks the port first (`backend/check-port.js`). If this server's older copy (node.exe) holds it, it asks **Stop the other copy and start this version? [Y/N]** and stops it; if another program holds it, it says which one and does not start. The browser opens only after the check passes. The admin panel menu and the server window show **Version 10 · 15 Nov 2026**. |

Tests: 321 pass (new: `check-port.test.mjs`; the Windows stop step was also run with simulated Windows commands).

## Eleventh round: partner-added riders on the admin Riders page (Version 11)

| # | Request | Change |
|---|---------|--------|
| 34 | Riders that Vendors / Franchises add should be shown to admins. | They were saved and listed only under **Client > Client Members** (the Riders page and Dashboard count only approved riders, so it looked as if nothing arrived). Now the **Riders** page starts with **Waiting for approval (N)**: Rider ID, name, mobile, hub, selfie, Aadhaar, **Added by** (Vendor / Franchise ID and name), date, View / Approve / Reject. The Riders menu shows the count; a pop-up announces each new partner rider (checked every 30 s); the Dashboard's Total Riders tile says "N new waiting for approval". Approving moves the rider into the Riders list at once, with "Added by Vendor · VN-…". |

Tested in Chrome: a vendor and a franchise each added a rider in their portal; both appeared in Waiting for approval with the right partner; a third rider added while the admin had the page open raised the pop-up and the count; Approve moved it into the list. Note: the portals' unused "Rider Management / Add Rider" page has no menu link and is not used.

## Twelfth round: support email in the portals (Version 12)

| # | Request | Change |
|---|---------|--------|
| 35 | Use supportontheway@gmail.com as the support email in the Vendor and Franchise portals. | `SUPPORT_EMAIL=supportontheway@gmail.com` (`.env`, `.env.example`, server default). Both portals' **Settings > Helpline / Support** now show it as a clickable address read from the server (new `GET /api/support-info`), so the address shown always matches where messages go. Tested: both portals show it; a support message from each arrived at supportontheway@gmail.com (sent from ontheway5579@gmail.com, Reply-To the partner). It is also the reply address of emails to applicants. |

## Needs your settings (works once configured)

- **Email** (applicant emails, support form, emailed reset links): `GMAIL_APP_PASSWORD` in `backend/.env` is still the placeholder; put in the App Password of ontheway5579@gmail.com. Also set `PUBLIC_URL` so links in emails open on phones and for applicants.
  Until it is filled in, Forgot password goes to the Super Admin (Temporary password), the support form says email is not
  configured, and partner login details are shared by Copy / WhatsApp.
- **Google Drive sync**: fill `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `DRIVE_TOKEN_SECRET` (see `.env.example`).
- **Razorpay AutoPay**: test keys in `.env` are placeholders; AutoPay is not shown on the current Payments page.

## Not changed (please decide)

- **Hub In-charge sign-in**: Hub In-charges are managed by admins but do not have their own portal or login yet.
- **Rider Performance page** counts Total Orders as LM + Prime + Club + SDD (its tests require this), while Reports use LM
  as the total. In all your sheets LM already equals Prime + Club, so this page shows about double. Tell us which rule is right.
- **Daily Work** starts with 5 entries for 02 Oct 2026 in a new browser. They may be demo data or real; they were left as they are.
- Opening Admin > Riders applies the bundled rider master directory, which can change a registered Rider ID to the one in
  that directory when the names match (existing behaviour, documented in RIDER-EDIT-AND-MASTER-DIRECTORY-FIX.md).

## Updating

1. Close the server window. Back up `backend/payments.sqlite`, `backend/.env` and the `backend/uploads/` folder.
2. Open the update ZIP (it holds only changed files), copy its contents into your project folder and choose **Replace**.
   Do not unzip a full project package over a folder that is in use: it contains a database copy.
3. Start with `START-WINDOWS.bat` as usual. No new packages are needed.
