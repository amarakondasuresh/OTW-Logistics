# Payments – Excel Order (oldest at the top)

- Saved rows are listed oldest week first, for weekly and 15-day periods alike.
- Within a week, rows follow the Excel sheet exactly: sheet, then row from top to bottom. They are not sorted by
  rider name.
- The same order is kept in the database query, the Pending Rider Verification list, the Payments table after a page
  refresh, and search and pagination (filtering never reorders rows).
- The Excel reader does not reverse rows. Tests confirm rows come out top to bottom.
- Reports keeps its own rider-table sorting (chosen by the user); its period table is chronological.

Tests: cd backend && node --test --no-warnings test/weekly-payments.test.mjs (45 tests).
