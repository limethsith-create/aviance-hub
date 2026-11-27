#!/bin/bash
# Assembles AVIANCE-run-this.sql — ten parts, in the order they must run.
# Sources: the migrations in the repo (M) for nine parts, and /home/claude/out for
# the one part that has no migration file (remove-calling.sql). Fix a part in its
# SOURCE, then run this; never edit AVIANCE-run-this.sql by hand.
set -e
cd "$(dirname "$0")"
M=${M:-/home/claude/r3-lead/supabase/migrations}
O=${O:-/home/claude/r3-lead/supabase/migrations}
OUT=${OUT:-/home/claude/paste/AVIANCE-run-this.sql}
part () { printf '\n\n-- ═══════════════════════════════════════════════════════════════════════\n--  %s\n-- ═══════════════════════════════════════════════════════════════════════\n\n' "$1" >> "$OUT"; }
cat 00-header.sql > "$OUT"
part "PART 1 — a lost booking gives its half hour back"
cat "$M/20261209_lost_booking_releases_its_slot_for_real.sql" >> "$OUT"
part "PART 2 — a recount never moves a locked month"
cat "$M/20261209_recount_never_moves_a_locked_month.sql" >> "$OUT"
part "PART 3 — prospect grants, and closes the cross-client prospect leak"
cat "$M/20261207_prospect_access.sql" >> "$OUT"
part "PART 4 — the portal's Campaign tab: a client reads their own campaign"
cat 02-client-read.sql >> "$OUT"
part "PART 5 — calendar connect"
cat "$M/20261207_calendar_connect.sql" >> "$OUT"
part "PART 6 — the month-end engine"
cat "$M/20261209_month_end_engine.sql" >> "$OUT"
part "PART 7 — refunds: paid, how, and what the client can see"
cat "$M/20261209_refunds_paid.sql" >> "$OUT"
part "PART 8 — the outreach sync schedule (reads your own gateway key; never prints it)"
cat "$M/20261207_outreach_sync.sql" >> "$OUT"
part "PART 9 — the commitment board's views"
cat "$M/20261209_commitment.sql" >> "$OUT"
part "PART 10 — remove the caller role"
cat "$O/20261207_remove_calling.sql" >> "$OUT"
part "WHAT HAPPENED — one row per part; this table is what the editor shows you"
cat 99-check.sql >> "$OUT"
wc -l "$OUT"
