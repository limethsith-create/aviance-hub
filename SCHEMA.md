# Aviance Hub — the one shared schema

Supabase project `zjbxnkpktbghhudjbxhk`. Every module in the hub reads and writes
these tables through the global `sb` client. Nothing in the hub calls another
server. There is no `machineFetch`, no `MACHINE_URL`, no email-distributor.

## How every module is written

- Plain browser JavaScript. No build step, no imports, no modules.
- Each file is loaded by a `<script src>` tag in index.html, in order.
- Globals: `sb` (Supabase client), `authUser`, `esc()`, `val()`, `errEl()`,
  `emptyState(icon,title,sub,btn,action)`, `toast(msg)`, `openModal(html)`,
  `closeModal()`, `render(viewName)`, `I` (icon map).
- Every data function returns `{ok, data, error}` and NEVER throws. Copy this
  plumbing from finance.js:

```js
function xxOk(data){ return {ok:true, data, error:''} }
function xxErr(e){ const m=(e&&(e.message||e.error_description||e.msg))||String(e||'Something went wrong.'); return {ok:false,data:null,error:m} }
function xxWrap(res, whenEmpty){ if(!res) return xxErr('No answer from the database.'); if(res.error) return xxErr(res.error); return xxOk(res.data==null?whenEmpty:res.data) }
async function xxRun(fn, whenEmpty){ try{ return xxWrap(await fn(), whenEmpty) }catch(e){ return xxErr(e) } }
```

- Prefix every global function in your file with your own short prefix so two
  files never collide.
- Error text shown to a person is a plain sentence, no jargon, no codes.
- Every screen must render correctly with ZERO rows in the database.
- Tests are node `.test.mjs` files in `tests/`, run with `node --test`.

## RLS

All tables: approved staff can read and write (`is_approved()`). The `dnc` table
is add-only for staff; only `is_admin()` can change or remove a row.
Client sign-in is not built yet, so client-facing tables are team-only for now.

## Money rules already built (finance.js — do not duplicate)

`plan_prices` is the source of truth for prices. A call counts only when it
matched the client's ICP, the prospect showed up, and no dispute was upheld
(`qualified_calls.counts` is a generated column). Month one short = 2x refund,
later months = 1x. Database functions: `open_next_month(client)`,
`recount_month(month)`, `lock_month(month)`, `raise_invoice(month, due_days)`.
Views: `v_month_standing`, `v_exposure`, `v_money`, `v_invoice_work`.

## Tables

One line per table. `id` is a uuid primary key with `default gen_random_uuid()`
and `created_at timestamptz not null default now()` unless said otherwise.
`*` marks NOT NULL. Check-constrained values are listed in brackets.

### Money (built — read only, through finance.js)
- **plan_prices** — plan* (pk: pilot|starter|growth|scale), label*, calls_promised*, monthly_fee*, three_month_fee*, is_recurring*, updated_at*
- **clients** — booking_id, company*, contact_name*, contact_email*, website, plan*, term*, calls_promised*, monthly_fee*, stage*, inputs_complete_on date, day1_on date, pilot_credit*, pilot_credit_used*, owner_id, ended_on date, end_reason, notes, updated_at*
- **client_months** — client_id*, month_no*, starts_on* date, ends_on* date, calls_promised*, calls_delivered*, verdict*, locked_at, refund_due*
- **qualified_calls** — client_id*, month_id, prospect_name, prospect_email, prospect_company, booked_for* timestamptz, matched_icp*, happened*, happened_at, dispute_status*, dispute_reason, counts (generated)
- **invoices** — client_id*, month_id, number*, gross_amount*, pilot_credit*, amount*, currency*, issued_on* date, due_on* date, status*, sent_at, paid_at, paid_via, notes
- **refunds** — client_id*, month_id, amount*, multiplier* numeric, reason*, status*, paid_at, paid_via, notes

### The journey
- **client_profiles** — client_id* (pk), sells_what, sells_to, icp* jsonb, never_email* jsonb, calendar_url, slots_per_week, sender_name, sender_title, time_zone, signed_off_at, updated_at*
- **client_stage_history** — id int8, client_id*, from_stage, to_stage*, at*, by_profile, note
- **client_events** — id int8, client_id, at*, area*, event*, detail* jsonb
- **handovers** — client_id*, reason, sent_at, contents* jsonb, data_delete_on date

### Meetings and the calendar
- **meetings** — client_id, booking_id, kind*, starts_at* timestamptz, minutes*, time_zone*, status*, meet_link, calendar_event_id, invited_at, reminded_24h_at, reminded_1h_at, held_at, notes
- **calendar_settings** — id int4 (single row, id=1), open_time* ('07:00'), close_time* ('21:00'), days* int4[] ({1,2,3,4,5}), slot_minutes* (30), min_notice_h*, days_ahead*, us_zone* ('America/New_York'), owner_zone* ('Asia/Colombo'), meeting_link, updated_at*
- **calendar_blocks** — starts_at* timestamptz, ends_at* timestamptz, reason

### Their people and the portal
- **client_people** — client_id*, full_name*, email, phone, role, is_primary*, timezone, notes
- **portal_invites** — client_id*, person_id, email*, token* (unique, random), portal_role* [viewer|manager], status* [pending|accepted|revoked|expired], expires_at* (now + 14 days), accepted_at, accepted_user
- **client_requests** — client_id*, person_id, kind* [question|change|complaint|dispute|pause|cancel|other], subject*, body, status* [open|in_progress|answered|closed], owner, closed_at

### Conversations
- **channels** — name*, purpose, kind* [internal|client], client_id, created_by, archived_at
- **channel_members** — channel_id*, user_id, person_id (exactly one of the two), member_role* [member|owner], last_read_at, added_at*
- **channel_messages** — channel_id*, author_user, author_person, body*, attachment_url, edited_at, deleted_at

### Work queue
- **tasks** — title*, detail, department* [marketing|sales|onboarding|operations|deliverability|finance|client_success|admin], client_id, assignee, status* [todo|doing|blocked|done|cancelled], priority* 1-5 (default 3), due_on date, created_by, done_at

### Cold calling
- **call_targets** — company*, person_name, job_title, phone, email, website, country, timezone, source, status* [new|queued|calling|booked|not_interested|bad_number|callback|dnc], attempts*, last_called_at, next_call_at, owner, notes
- **call_log** — target_id*, caller, called_at*, target_local_time time, outcome* [no_answer|voicemail|gatekeeper|conversation|booked|not_interested|bad_number|dnc_request|callback], duration_seconds, meeting_id, notes
- **dnc** — phone, email, domain (at least one), reason* [requested|complaint|legal|bounced|competitor|other], note, added_by

**The do-not-call list is enforced in the database, not the screen.** Inserting
or updating a `call_targets` row whose phone, email or website matches a `dnc`
row raises an error. Adding a `dnc` row sets any matching target to status
`dnc`. Never work around this; show the error.
US calling hours are 8am-9pm in the prospect's own time zone (TCPA).

### Outreach (the custom tool)
- **outreach_accounts** — client_id*, provider* [demo|smartlead|instantly], label*, external_id, key_ref (a NAME, never a key), status* [ok|needs_key|error|paused], last_synced_at, last_error
- **outreach_campaigns** — account_id*, client_id*, external_id, name*, status* [draft|running|paused|finished|error], started_on date, sent*, opened*, replied*, positive*, booked*, bounced*, unsubscribed*, last_synced_at
- **outreach_daily** — campaign_id*, client_id*, on_day* date, sent*, opened*, replied*, positive*, booked*, bounced*, unsubscribed*
- **outreach_threads** — campaign_id, client_id*, external_id, lead_name, lead_email, lead_company, lead_title, sentiment* [unknown|positive|neutral|negative|out_of_office|unsubscribe], status* [open|answered|booked|closed], owner, meeting_id, last_message_at
- **outreach_messages** — thread_id*, client_id*, external_id, direction* [out|in], subject, body, sent_at*, delivery* [synced|queued|sending|sent|failed], delivery_error, author_user
- **outreach_inboxes** — account_id*, client_id*, external_id, email*, domain, warmed*, health 0-100, daily_limit, sent_today*, status* [ok|warming|warning|blocked|paused], last_synced_at

View **v_outreach_summary** — client_id, client_name, campaigns, running, sent, replied, positive, booked, reply_pct, last_synced_at.

### Already there, untouched
- **profiles** — id (= auth user), email, name, role*, approved*, title, loc, init, color, workload, status, phone, emp_no
- **discovery_bookings** — name*, email*, role, company*, website, city, country, industry, budget, decision_maker, goal, timeline, current_lead_gen, call_at* timestamptz, minutes*, timezone, source, status*, score, calendar_event_id, meet_link, day_before_sent_at
- **research_briefs** — booking_id* (pk), brief* jsonb, raw jsonb, agents jsonb, writer, ms  *(the research engine stays)*
- **research_log** — id int8, at*, booking_id, event jsonb
- **agreements** — booking_id, client_name*, client_email*, client_company*, plan*, term*, monthly_fee*, status*, gmail_message_id, sent_by, error
- **agreement_pdfs** — key* (pk), filename*, b64*, updated_at*
- **workspace_shared / workspace_admin** — id int4, data* jsonb, updated_at

## The words the database will accept

A module holding a word the database refuses does not crash — the write just
fails, or the count silently reads zero. Three of those were found after the
rebuild. These lists mirror the live CHECK constraints. **If a migration changes
one, change it here and in `tests/vocabulary.test.mjs` in the same commit.**

- **clients.stage** / **client_stage_history** — `enquiry, booked, won, onboarding, live, at_risk, paused, ended, lost`
  (`warming`, `sending`, `setting_up`, `finished` are retired)
- **meetings.kind** — `discovery, strategy, onboarding, qualified, review, check_in, other`
  (`qualified` is a booked sales call we delivered: the one that counts toward the guarantee)
- **meetings.status** — `requested, booked, held, no_show, cancelled` (`confirmed` is retired, now `booked`)
- **channels.kind** — `team, internal, client`
- **tasks.department** — the eight: `marketing, sales, onboarding, operations, deliverability, finance, client_success, admin`
- **discovery_bookings.plan** — `pilot, starter, growth, scale`
- **discovery_bookings.lost_reason** — `price, timing, no_budget, went_elsewhere, not_a_fit, no_show, ghosted, other`

## What the website may do

The booking page on aviance.online is not signed in, so it acts as `anon`. It is
allowed exactly two things and nothing else:

- `select * from public.free_slots(days)` — free start times and slot length,
  **nothing else**: no names, no client ids, no booking ids. It reads the same
  `calendar_settings` row the hub's Settings screen writes, so changing the
  working day in the hub changes what the website offers. It subtracts anything
  in `meetings`, `calendar_blocks` and `discovery_bookings`.
- `select * from public.v_call_hours` — the working day in words, for the
  "7am to 9pm Eastern, weekdays" line on the page.
- `insert into public.discovery_bookings` — guarded by the `website can book`
  policy: status must be `booked`, no score, no calendar id, and the call must
  be in the future.

Proven by planting a client, a meeting and a do-not-call row, then reading as
`anon`: every one came back 0, while `free_slots` correctly dropped the taken
slot. A unique index (`discovery_bookings_one_per_slot`) means the database
itself refuses a double booking, which is what lets the page say "someone just
took that time".
