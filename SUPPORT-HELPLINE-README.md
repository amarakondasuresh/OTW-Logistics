# Helpline / Support: how it works

The Admin Portal's **Support** page is the central place for every complaint: from the Vendor and Franchise
portals, from the public form, and from customer emails sent to the support Gmail.

## Ticket status and email status are separate

- **Ticket status** (you change it): New, Pending, In Progress, Resolved, Rejected, Closed.
- **Email status** (the system sets it): Pending (queued), Sending, Sent, Retrying, Failed.

"Sent" is set only when the mail server accepts the message for every recipient. A rejected or unreachable
recipient is never shown as Sent. Retrying means an automatic retry is scheduled (after 1, 5, 15, 60 and 120
minutes). Failed means all automatic attempts were used. The error text is kept and shown under "View error".
An admin can press **Retry Email** on a Failed email, and the result is shown straight away.

Each email is one row in `support_email_jobs`, with a unique key per ticket. A duplicate is never queued, a job
is claimed by one sender only, and a job left "Sending" after a crash is put back to Retrying.

## Emails

- New request: subject `New Support Ticket – ON THE WAY LOGISTICS – [Ticket ID]`, sent to `SUPPORT_EMAIL`
  with a copy to the admin address, with the customer's photo attached.
- Admin reply: sent from the support account to the customer's address, with the ticket number in the subject.
  The Message-ID is saved, so the customer's reply can be matched back to the ticket.
- Partner follow-up and incoming customer email: the admin address is notified.

Outgoing mail uses Gmail SMTP: smtp.gmail.com, port 587, STARTTLS.

## Incoming customer email

Gmail SMTP cannot receive mail, so incoming mail is read with the Gmail API (OAuth). The poller checks unread
support mail every minute. For each message:

1. If it was already processed (stored by Gmail message id), it is not processed again.
2. If it quotes a ticket number, or replies to one of our emails, and comes from that ticket's customer address,
   it is added to that ticket's conversation and the ticket is reopened if it was finished.
3. Otherwise a new ticket is created with the sender's name and address.
4. A message from someone other than the ticket's customer is opened as a new ticket, not added to that ticket.
5. The message is marked read only after it is saved.

Quoted text is removed from the stored message, and attachments are not imported.

## Setup

1. Support Gmail sending: in `backend/.env`, set `GMAIL_USER=supportontheway@gmail.com` and
   `GMAIL_APP_PASSWORD` to an App Password created for that account (Google Account > Security > 2-Step
   Verification > App passwords). The current `.env` still sends from `ontheway5579@gmail.com`; change both
   lines together.
2. Incoming support mail: in Google Cloud Console, enable the Gmail API and create an OAuth client (Web
   application) with redirect URI `http://localhost:8765/oauth2callback`. Put its ID and secret in
   `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET`, then run `node gmail-authorize.js`, sign in as
   the support account, and copy the printed `GMAIL_OAUTH_REFRESH_TOKEN` into `.env`.
3. Optional: `ADMIN_EMAIL` for the admin copy (otherwise every active admin's email is used), and `PUBLIC_URL`
   so emails link to the Admin Portal.
4. Restart the server. The Support page shows whether incoming email is connected, and "Check inbox now" tests it.

## Testing

Run `npm test` in `backend/`. The support tests cover the ticket rules, the email status rules and retries,
and incoming mail threading and duplicate protection (38 checks, using Node's built-in SQLite; skipped on Node
older than 22.5).

## Not verified here

These parts were written and tested against stand-ins only. They need a live check with the real accounts:

- Sending through the real Gmail SMTP server, and the message arriving in an inbox.
- The OAuth connection and reading real incoming mail through the Gmail API.
- The admin Support page and partner panel in a browser.
- A full server start with `npm install`.

The live checks in the request (Tests 1 to 8) must be run by the owner with the real accounts. Until they pass,
do not treat email as working.

## Version 3 changes (read this first)

- **Sending now uses the Gmail API (OAuth 2.0)** when `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET` and
  `GMAIL_OAUTH_REFRESH_TOKEN` are set. Mail is then sent as the authorised support account. SMTP with
  `GMAIL_APP_PASSWORD` is used only while the Gmail API is not connected.
- **Re-authorise.** The refresh token must carry two permissions: `gmail.send` and `gmail.modify`. A token made
  with the earlier version has only `gmail.modify`, so run `node gmail-authorize.js` again and grant both.
- **Email not sent.** The cause was that `GMAIL_APP_PASSWORD` still held the template text
  (`replace_with_16_character_gmail_app_password`), so no mail could be sent. The server now says this in the
  startup log and in the error on each failed email. Connect the Gmail API, or put a real App Password in place.
- **Customer confirmation.** Each new request, from the portal, the public form or an incoming email, sends the
  customer `We received your support request – ON THE WAY LOGISTICS – [Ticket ID]`.
- **Attempt log.** Every send attempt is stored with its time, outcome and error text. The admin page shows it
  under "Attempt log" for each email.
- **New customer email.** A ticket where the customer has written since the last admin reply shows a
  "New customer email" badge.
- **ADMIN_EMAIL** may list several addresses, separated by commas.
- `.env`: only the missing Gmail OAuth and ADMIN_EMAIL keys were appended with empty values. Existing lines are
  unchanged. Secrets are not stored in the project.
