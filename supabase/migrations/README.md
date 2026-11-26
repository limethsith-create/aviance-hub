# Aviance OS's own database

These are applied to the `aviance-hub` Supabase project (`zjbxnkpktbghhudjbxhk`).
Pull the SQL with `supabase db pull` — Supabase holds the applied versions.

## Finance (2026-11-22) — the first part of Aviance OS that stood on its own

| Migration | What it adds |
| --- | --- |
| `20261122094429_finance_core` | `plan_prices`, `clients`, `client_months`, `qualified_calls`, `invoices`, `refunds` + RLS |
| `20261122094502_finance_month_clock` | `open_next_month`, `recount_month`, `lock_month`, and the `v_month_standing` / `v_exposure` / `v_money` views |
| `20261122094622_finance_invoicing` | `raise_invoice`, `v_invoice_work` |

### The rules, as agreed

- **A qualified call** is a prospect who matches the profile agreed at kickoff
  AND who actually turned up. The database enforces it: `qualified_calls.counts`
  is a generated column, `happened AND matched_icp AND dispute_status <> 'upheld'`.
- **Plans**, three only: Starter 5 calls / $1,500 a month, Growth 10 / $3,000,
  Scale 15 / $4,500. The 3-month term is 20% off: $1,200 / $2,400 / $3,600 a
  month, billed up front as $3,600 / $7,200 / $10,800. No setup fee.
- **The $300 Pilot is retired**, and its credit with it. These first migrations
  still created a `pilot` price row, the `pilot_credit` columns and the credit
  step inside `raise_invoice`; they are history and are not edited. Nothing in
  the browser sells, prices, credits or names the Pilot: a legacy `pilot` plan
  code is refused in words and shown as "Retired plan" (finance.js
  `fnPlanRetired`). Clearing what is left in the database is the job of a later migration, never an edit here.
- **Miss month one** → refund is double the fee. **Miss any month after** → that
  month in full. `lock_month` works it out and raises the refund row.
- **A locked month never moves.** `lock_month` and `raise_invoice` are both
  safe to call twice; neither will refund or bill twice.
- **No cap on clients.** `v_exposure` reports what we would owe if every open
  month missed today, but nothing blocks a sale.

### Money

Whole US dollars, stored as `integer`. Reads need an approved profile; writes
to `invoices` and `refunds` need `is_admin()`.
