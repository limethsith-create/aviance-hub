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

## Round 2, not applied — three files waiting on the owner (2026-11-26)

These three were written against the live database but **not applied**: this
session could not apply SQL. Each file explains itself at the top. In order of
how much they cost while they are not applied:

| Migration | What it fixes | Urgency |
| --- | --- | --- |
| `20261209_lost_booking_releases_its_slot_for_real.sql` | `discovery_bookings_one_per_slot` still excludes only `'cancelled'`, so a **lost** booking's half hour is offered on the website and then refused with a raw duplicate-key error. Proven live, inside a rolled-back transaction. | **Apply this one.** It is costing real bookings now. |
| `20261209_recount_never_moves_a_locked_month.sql` | `recount_month` reads `locked_at` at the top and writes the count at the bottom with no guard, so a verdict landing as a month is locked can leave a locked month whose count contradicts its own refund. One extra `and locked_at is null`. | Apply before the first month is locked with real money in it. |
| `20261209_chat_search_index_OPTIONAL.sql` | The Channels search is a sequential scan of every message (measured: 63 rows, 1.4 ms today). A trigram index when that number is in the tens of thousands. | Not yet. Measure first. |

## Round 3 — the paste file was run before the owner runs it (2026-11-27)

Nothing below is applied yet. Nine files in this folder, with one file outside the
repo (`remove-calling.sql`), are assembled by `/home/claude/paste/build.sh` into
`AVIANCE-run-this.sql`, in this order:

| Part | Migration |
| --- | --- |
| 1 | `20261209_lost_booking_releases_its_slot_for_real.sql` |
| 2 | `20261209_recount_never_moves_a_locked_month.sql` |
| 3 | `20261207_prospect_access.sql` |
| 4 | (paste folder) the three client-read policies; the same three are in `20261207_outreach_sync.sql` |
| 5 | `20261207_calendar_connect.sql` |
| 6 | `20261209_month_end_engine.sql` |
| 7 | `20261209_refunds_paid.sql` |
| 8 | `20261207_outreach_sync.sql` |
| 9 | `20261209_commitment.sql` |
| 10 | (outside the repo) `remove-calling.sql` |

The live `public` schema was rebuilt on a local Postgres from the live catalogue
and the assembled file was run on it twice, as one request, the way the SQL
editor sends it. Both runs were clean. What that found is fixed in the five files
above that changed in round 3, each marked `ROUND 3` where it changed, and pinned
in `tests/paste-sql.test.mjs`.

Three rules that came out of it, for whoever writes the next migration:

- **Every new view says `with (security_invoker = true)`.** Without it a view runs
  past row security, and this project grants every new view to every signed-in
  user, clients included. `create or replace view` with no `with (...)` clause
  also takes the setting OFF a view that had it.
- **A `security definer` function granted to `authenticated` is callable by a
  client.** It checks who is asking in its first line or it is not granted.
- **The paste file is one transaction.** One failing statement and none of it is
  applied. A migration that cannot be run twice breaks every other part with it.
