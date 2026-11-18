# Support tickets: separated by portal

## What changed
- Every partner request (My Support Requests list, detail, photo, follow-up) is limited on the server to the
  signed-in account AND its portal type. The portal type comes from the account's role in the session, never
  from the browser. A Vendor never sees a Franchise ticket, and the reverse.
- A request sent from the Vendor or Franchise portal must come from a signed-in account of that portal.
  Without one it is refused with a sign-in message, instead of being saved where no partner can see it.
- A ticket cannot be saved under an account of the other portal.
- Tickets no longer show in the portal after sign-out; the next sign-in on the same page loads only that account's tickets.
- Admin: all Vendor, Franchise and Email tickets, with Portal Type and a Vendor/Franchise filter. Admin replies and status
  changes appear only in the ticket owner's portal.

## Data
- No columns were removed or rewritten. Existing tickets, IDs, photos, dates and replies are unchanged.
- One index was added: support_tickets(account_id, portal_type, submitted_at).
- Tickets sent before sign-in was enforced have no account, so no partner can see them. They remain in the Admin Portal.

## Tests
- backend/test/support-tickets.test.mjs covers portal isolation, mismatched rows, cross-portal attribution, unsigned tickets,
  and reopening an existing database.
