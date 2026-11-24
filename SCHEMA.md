# Aviance OS — the one shared schema

Supabase project `zjbxnkpktbghhudjbxhk`. Every module in Aviance OS reads and writes
these tables through the global `sb` client. Nothing in Aviance OS calls another
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
`invoices` are admin-read. A signed-in portal client sees ONLY their own channel:
they may select the `channel_messages` of that channel (`deleted_at is null`) and
insert `{channel_id, author_person, body}` (with `author_user` null). Every other
table and view returns nothing for a client. A client never enters the hub shell:
index.html asks `portal_home()` for anyone who is not an approved team member and
sends a client to `/portal.html`.

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
The Calendar (meetings.js) is the one place every call lives. It reads `meetings`
**and** `discovery_bookings` and draws both; there is no separate Bookings screen.
A booking's outcome is still written only by pipeline.js (Won goes through `close_won`, below). Both tables hold their
time: the hub's slot finder treats any booking that is not `cancelled` as taken.
`discovery_bookings.status` starts as `booked` (the website), becomes `brief_sent`
(the research engine), then `held`, `no_show`, `won`, `lost` or `cancelled`. A
booking is open unless it is `won`, `lost` or `cancelled` — never test for a list
of "open" words.
- **meetings** — client_id, booking_id, kind*, starts_at* timestamptz, minutes* (15–240), time_zone*, status*, meet_link (a trigger fills in a stand-in room when it is left empty), calendar_event_id, invited_at, reminded_24h_at, reminded_1h_at, held_at, notes, title (≤160), guest_name (≤120), guest_email (a valid email or null), plan [null|pilot|starter|growth|scale]. **Unique index on starts_at for every meeting that is not `cancelled`**, so two live meetings can never start at the same instant; a clash comes back as duplicate key (23505) and the Calendar says "There is already a call at that time." A meeting the owner adds by hand (meetings.js `mtAddOwn`) is `kind = 'other'` with its own `title`, `guest_name`, `guest_email` and `plan`; the Calendar colours it by that `plan` and falls back to the client's company and plan when a meeting has none of its own. `kind = 'qualified'` requires `client_id`.
- **calendar_settings** — id int4 (single row, id=1), open_time* ('07:00'), close_time* ('21:00'), days* int4[] ({1,2,3,4,5}), slot_minutes* (30), min_notice_h*, days_ahead*, us_zone* ('America/New_York'), owner_zone* ('Asia/Colombo'), meeting_link, updated_at*
- **calendar_blocks** — starts_at* timestamptz, ends_at* timestamptz, reason

### Their people and the portal
- **client_people** — client_id*, full_name*, email, phone, role, is_primary*, timezone, notes
- **portal_invites** — client_id*, person_id, email*, token_hash, portal_role* [viewer|manager], status* [pending|accepted|revoked|expired], expires_at* (now + 14 days), accepted_at, accepted_user. **There is no `token` column.** Only a hash is stored; the raw token is handed back once by `portal_invite_create` and is never readable again, so a listed invite has a status and no link (portal.js).
- **client_requests** — client_id*, person_id, kind* [question|change|complaint|dispute|pause|cancel|other], subject*, body, status* [open|in_progress|answered|closed], owner, closed_at

### Conversations
- **channels** — name*, purpose, kind* [team|internal|client], client_id (required for client), created_by, archived_at
- **channel_members** — channel_id*, user_id, person_id (exactly one of the two), member_role* [member|owner], last_read_at, added_at*. Unique (channel_id,user_id) and (channel_id,person_id).
- **channel_messages** — channel_id*, author_user, author_person, body*, attachment_url, edited_at, deleted_at. A team message has `author_user`; a client's has `author_person` (a `client_people` id). Realtime is on. There is **no `messages` table** and no `chat-files` bucket: the Channels screen sends text only, and shows an `attachment_url` only when it is a web link.

The team's Channels screen (channels.js) reads and writes only through channels-api.js, which uses these
tables plus four team-only database functions (`supabase/migrations/20261124_channels_rpcs.sql`,
security definer, refuse unless `is_approved()`):
- `my_channels()` → jsonb `[{id, name, purpose, kind, client_id, company, archived_at, created_at, last_message_at, last_body, unread}]` — every client channel, plus team/internal ones you belong to or made. `unread` counts others' live messages after your `last_read_at` (never opened = all; not a member = 0).
- `mark_channel_read(c uuid)` → void — upserts your member row with `last_read_at = now()`.
- `channel_people(p_ids uuid[])` → jsonb `[{id, name, role, kind: team|client, company}]` — names for login ids (profiles) and client person ids (client_people). A client author is always shown as "Name (Company)" with a Client tag.
- `ensure_client_channel(p_client_id uuid, p_name text)` → uuid — the client's open channel, or a new one named after the company, with you as owner and every person of that client as a member.

Edits and deletes from the screen only ever touch your own messages (`author_user = auth.uid()`); deleting is a soft delete (`deleted_at`).

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
- **discovery_bookings** — name*, email*, role, company*, website, city, country, industry, budget, decision_maker, goal, timeline, current_lead_gen, capacity, phone, sells, tried_outbound, plan [pilot|starter|growth|scale], call_at* timestamptz, minutes*, timezone, source, status*, score, calendar_event_id, meet_link, lost_reason, lost_at, day_before_sent_at
- **research_briefs** — booking_id* (pk), brief* jsonb, raw jsonb, agents jsonb, writer, ms  *(the research engine stays)*
- **research_log** — id int8, at*, booking_id, event jsonb
- **agreements** — booking_id, client_name*, client_email*, client_company*, plan*, term*, monthly_fee*, status*, gmail_message_id, sent_by, error
- **agreement_pdfs** — key* (pk), filename*, b64*, updated_at*
- **workspace_shared / workspace_admin** — id int4, data* jsonb, updated_at

## Close to onboarded

The path from a won call to a client who can sign in. Every step is a database
rule called with `sb.rpc`; each returns jsonb unless said, and refuses in plain
English that the screen shows as it is.

1. **Won** on a call's panel (pipeline.js `plCloseWon`, after the plan picker) →
   `close_won` → client + channel + agreement + invoice, and the "pack" email queued.
2. The client opens the links, signs the agreement (typed name) and pays by the
   Wise / Payoneer details on the invoice.
3. The owner clicks **Paid** (finance.js `fnMarkInvoicePaid`, from the client's
   page or Billing) → `mark_paid` → invoice paid, invite made, "welcome" email queued.
4. The client opens the join link and sets a password → edge function
   `portal-accept` → lands on portal.html and sees only their channel.

Team (admin only):
- `close_won(p_booking uuid, p_plan text, p_term text default 'monthly')` → `{client_id, invoice_id, agreement_id, invoice_number}`. `p_plan` in pilot|starter|growth|scale; `p_term` in monthly|3month. Raises 'That call is already a client.' if done twice.
- `mark_paid(p_invoice uuid, p_via text default null)` → `{invoice_id, client_id, welcome_sent boolean}`.
- `biz_get()` → `{legal_name, address, email, wise_details, payoneer_link, kickoff_link, site}` — the business details on agreements, invoices and emails. Stand-ins until set: a value that starts with `[` is not set yet (Settings → "Payments and documents", settings.js).
- `biz_set(p jsonb)` → the same shape; merges the keys given.
- `portal_invite_create(p_client uuid, p_email text, p_person uuid default null)` → `text`, the RAW token, shown once. Only its hash is stored; earlier pending invites for that email + client are revoked.

Public (anon, by link token):
- `doc_get(p_token text)` → an agreement `{kind:'agreement', company, contact_name, status [sent|signed|void], signed_name, signed_at, terms}` or an invoice `{kind:'invoice', number, status [draft|sent|paid|overdue|void], issued_on, due_on, paid_at, currency, lines:[{label, amount}], gross, pilot_credit, amount, bill_to, from, pay:{wise_details, payoneer_link}}`; raises 'This link is not valid.'
- `doc_sign(p_token text, p_name text, p_agent text)` → the agreement as `doc_get`, now signed. Once only.
- `invite_peek(p_token text)` → `{ok:true, email, company, name}` or `{ok:false, reason: used|expired|invalid}`.

Client (signed in as a portal client):
- `portal_home()` → null when the caller is not a portal client, else `{person:{id,name}, company, channel:{id,name}, members:[{kind: team|client, id, name}]}`.

Edge function (public, no JWT): `POST /functions/v1/portal-accept {token, password}` → `200 {ok:true, email}`, or `4xx {ok:false, error}` in plain words.

Links — the token rides in the URL #fragment, never the query string:
`{site}/doc.html#<token>`, `{site}/join.html#<token>`, `{site}/portal.html`
(`site` defaults to https://aviance.store). An old `/#join=<token>` link is
handed on to join.html by index.html.

SQL the documents and email side provides: `agreement_terms(p_client)`,
`mail_pack(p_client, p_agreement_url, p_invoice_url)`,
`mail_welcome(p_client, p_join_url, p_agreement_url, p_receipt_url, p_kickoff_url)`,
and the helper `biz(p_key text) returns text`.

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
  `calendar_settings` row Aviance OS's Settings screen writes, so changing the
  working day in Aviance OS changes what the website offers. It subtracts anything
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

## The mail room

Nothing in the browser sends email. Anything that needs one writes a row to
**mail_outbox** — to_email, to_name, subject, body_text, body_html, ics, kind*
[booking_confirmation|reminder_24h|reminder_1h|reminder_5min|agreement|portal_invite|friday_update|handover|other],
booking_id, meeting_id, client_id, status* [pending|sending|sent|failed|cancelled],
attempts, last_error, send_after, sent_at, gmail_message_id, needs_meet_link.
Staff-only under RLS; one row per booking or meeting per kind.

- A new row in `discovery_bookings` queues its own confirmation (trigger), and
  gets a stand-in video link at once so no email can ever go out without one.
- `queue_due_reminders()` queues the day-before, hour-before and five-minute
  nudges, each exactly once, and **only if the person booked before that
  nudge's window opened** — someone who books three hours ahead never gets
  "see you tomorrow".
- The edge function `mail-tick` (supabase/functions/mail-tick) runs every
  minute. It hands each row to the Apps Script inside aviancelk@gmail.com,
  which makes the calendar event and a real Google Meet link for a new booking,
  sends the email, and returns the link, which replaces the stand-in on the
  booking. Reminders carry that same link.
- Templates hold `{{MEET_LINK}}`; a trigger refuses to mark a row sent while
  the placeholder is still in it.
- Secrets live in Supabase (APPS_SCRIPT_URL, APPS_SCRIPT_SECRET) and in the
  script's own properties (SHARED_SECRET). With them missing the job runs as a
  rehearsal and sends nothing.

### The four designed emails

`mail_html(kind, name, at, zone)`, `mail_text(...)` and `mail_subject(...)` build
the booking confirmation and the day-before, one-hour and five-minute reminders:
email-safe HTML (tables, inline styles, the logo loaded from
https://www.aviance.online/logo-180.png) plus a plain-text fallback. Every
caller goes through `queue_call_mail(kind, email, name, at, zone, booking, meeting, client)`
so all four always match. Dates and times are written in the person's own time
zone; `{{MEET_LINK}}` is swapped for that booking's Google Meet link at send time.
The designs these were built from: "Aviance — booking & reminder emails"
(https://claude.ai/artifact/KM6PfhSTE2ZqtvvqbX6KUx).

A new booking also starts the research engine (existing trigger), so a test
booking leaves a research brief behind as well as mail.
