# Payments – Rider-wise Import, Orders and Amounts

Applies to Admin Portal → Payments → Weekly Payments – Excel Automatic.

## What the Excel sheet is read for
Header names are matched (not column positions): Rider ID, Rider Name, Week, Days, Total Orders, LM Orders,
Prime Orders, Club Orders, SDD Orders, Amount (and optional rate / category-amount columns).

- Total Orders is read from its own column. It is no longer copied from LM Orders.
- Amount is the Total Amount and is saved exactly as written in the sheet (₹5,970 stays ₹5,970.00).
- Zero values are shown as 0. Blank or missing values are shown as — .

## Category amounts
- LM Amount = LM Orders × ₹10 (1 → ₹10, 5 → ₹50, 372 → ₹3,720, 0 → ₹0.00).
- Prime / Club / SDD Amount: an explicit amount column in the sheet is used if present. Otherwise
  orders × the rider's rate from the sheet. A plain "Rate" column (for example ₹18 or ₹19) is treated as
  the Prime rate. A cell such as "₹18.5 Pri / ₹12.25 Club" sets both Prime and Club rates.
- With no rate and no amount column, the category shows — . No rate is invented.

## Storage and duplicates
- Saved in the existing weekly_payments table, one row per Rider ID + week. Rates and category amounts
  are stored with it (new columns are added automatically on start-up; existing rows are kept).
- Importing the same file again inserts nothing. A corrected figure updates only that rider's row.

## Rider details
Clicking a rider's name or Rider ID opens that rider's week: Rider ID, name, week, days, all order counts,
rates, category amounts, the Excel Total Amount, source file, sheet/row and import time.

## Validation
`cd backend && node --test --no-warnings test/weekly-payments.test.mjs` (29 tests).
The new tests cover LM × ₹10, Total Orders, Excel amounts ₹5,970 / ₹6,482, ₹18 and ₹19 rider rates,
zero rows, refresh (re-reading the database), and re-import without duplicates.
