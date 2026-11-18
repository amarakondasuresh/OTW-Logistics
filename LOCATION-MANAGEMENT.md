# Franchise & Vendor Location Management

## What it does
- Franchise and vendor partners add locations on **My Locations** (Location Name, City/Town, District, Area, PIN Code; all required, PIN must be 6 digits and not start with 0). An optional **Location URL** (Google Maps link) can be added; it must be a web link (http/https) and shows as an "Open map" link in both portals.
- Each location gets a Location ID and status **Pending Approval**. The partner sees the status update live.
- Admin Portal > **Hub Management** > **Submitted Locations** lists every submission with Approve, Reject, Edit, Direction (Google Maps) and Delete.
- Admin can change or clear the Location URL in Edit.
- Approve makes the location **Active** and adds its hub to Hub Management > **Hub List** in the same step. The admin does not enter it again. The partner's portal shows it Active without re-submitting.
- Add Location asks for a **State** (chosen from the 36 States and Union Territories). If the partner's accepted application has a State, it is filled in automatically. Locations submitted before the State field existed have no State: Approve asks for one, so the admin adds it in Edit first.
- **My Locations (partner)** shows Location ID, Location Name, City / Town, District, Area, PIN Code, Location URL, Application Status (Pending, Approved, Rejected, with the rejection reason) and Actions.
  - **View** is available for every location.
  - **Edit** and **Delete** are available while a location is Pending or Rejected. Editing a Rejected location sends it back to Pending Approval and clears the reason.
  - **Approved** locations are read-only for the partner. Changes go through the Admin Portal.

## Where the data lives
- Table `partner_locations` in the existing SQLite database (created automatically on first start).
- Approved locations are stored in the `hubs` table as normal hubs. Each hub keeps its source Location ID in `source_location_id`, which is unique, so one location makes exactly one hub.
- Partners see only their own rows. Only admin sessions can approve, reject, edit or delete.
- Repeated clicks and retries do not create duplicates (per-form submission key).

## API
| Method | Path | Who |
|---|---|---|
| GET | /api/portal/locations | vendor or franchise (own only; also returns `defaultState`) |
| POST | /api/portal/locations | vendor or franchise |
| PATCH | /api/portal/locations/:id | vendor or franchise (own, not Approved) |
| DELETE | /api/portal/locations/:id | vendor or franchise (own, not Approved) |
| GET | /api/admin/locations | admin |
| PATCH | /api/admin/locations/:id | admin (edit) |
| POST | /api/admin/locations/:id/approve | admin (creates the hub; returns `hubCreated`) |
| POST | /api/admin/locations/:id/reject | admin (optional `reason`) |
| DELETE | /api/admin/locations/:id | admin |

## Files
- backend/locations.js (rules and routes), backend/server.js (registration)
- backend/test/locations.test.mjs and backend/test/location-hub-approval.test.mjs (both in `npm test`)
- backend/hubs.js (hub creation/sync from locations), backend/india-states.js (State list)
- vendor-portal/partner-locations.js and franchise-portal/partner-locations.js (identical)
- dashboard/location-management.js, dashboard/hub-management.js (panel mount)

## Setup
1. Replace the project folder with this one (keep your backend/.env and payments.sqlite).
2. `cd backend && npm install && npm test`
3. `npm start`, then sign in to the Admin Portal and open Hub Management.

## Testing done
- 16 backend tests for validation, duplicates, status flow, roles and routes.
- Browser workflow (vendor submits, admin approves, edits, opens Directions, rejects, deletes; vendor sees each change) passed against the real location routes on SQLite. Sign-in and unrelated endpoints were stubbed for that run.
- Not yet run: the full server with the real login and mail setup, and Google Maps itself (needs internet).

## Notes
- Locations submitted before this version (stored in the old per-partner data) are kept but no longer shown.
### Approval to Hub List (field mapping)
| Location | Hub |
|---|---|
| Location Name | Hub Name |
| Area | Hub Location |
| City / Town | City |
| District | District |
| State | State |
| PIN Code | Hub Pincode |
| Location URL | Hub URL |
| Verified applicant name / mobile (accepted application) | Hub In-Charge / Phone Number |
| (active) | Hub Status = Active |

Everything else (address, email, manager, opening date, contact number) stays blank.

- A hub with the same Hub Name already in Hub List blocks approval with a clear message. Nothing is overwritten; rename the location or the existing hub, then approve again.
- Edit on an approved location also updates its hub. Editing the hub's name directly in Hub List is allowed, but the next location edit will overwrite it.
- Delete on an approved location sets its hub to **Inactive**; the hub is kept. A hub that came from a location cannot be deleted from Hub List.
- Reject is only for pending locations; the reason is shown to the partner.

### Tests
- Browser tests (not shipped; run outside the project) covered the full workflow: franchise and vendor submit, admin approves and rejects, partners see the new statuses, plus duplicate and double-click handling, failed saves, search, refresh, edit, delete and the Hub List.
- `backend/test/location-hub-approval.test.mjs` (26 tests): approval creates one hub with the mapped fields, repeated approval never duplicates, failed approval is rolled back, reject/edit/delete sync, State validation, existing 100 hubs unchanged, upgrade of an older database.
