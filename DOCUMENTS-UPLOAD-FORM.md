# Admin Portal > Documents: Upload Rider Document form

## The form
- Rider: searchable list of registered riders, shown as "Name (Rider ID)". Riders that exist only from a payment
  import (no registration) are not listed.
- Document Type: Aadhaar / ID Proof, PAN Card, Driving Licence, Bank Passbook, RC Book, Insurance Document, Other Documents.
- Choose File (required): JPG, JPEG, PNG, WEBP or PDF, up to 5 MB. Checked when chosen and again on the server by content.
- Rider Selfie / Screenshot (optional): JPG, JPEG, PNG or WEBP, up to 5 MB, previewed when chosen. Stored as a separate
  file linked to the same Rider ID.
- Upload / Cancel. A repeated click or a retry after a network error does not create a second record.

## Table
Uploaded documents show Rider Name, Rider ID, Document Type, File Name, Rider Selfie / Screenshot, Upload Date, with
View, Download, Replace and Delete. The search box filters the table and the rider list.

## Rules
- The same document (identical file) cannot be uploaded twice for one rider and type; other riders may have it.
- Replace changes the file, the selfie or the type. Anything not changed is kept. The old file is removed only after the
  new record is saved.
- Records saved by the earlier version keep their old type names (PAN, RC, Address Proof, Other) and remain listed.
- Database: additive migration only (new columns and an index). No rows are deleted or rewritten.
- Files are stored in backend/uploads/admin-documents/ with owner-only permissions, and are opened only through an admin session.

## Tests
- backend/test/admin-documents.test.mjs (14 tests): types, storage, selfie, validation, duplicates, idempotent submit,
  replace, delete, and an older database opened with the new code.
- The HTTP routes are in backend/admin-document-routes.js.
