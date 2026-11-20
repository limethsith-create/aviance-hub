# Aviance Hub

The Aviance owner's window onto the **machine** — live at
https://aviance.store. One static page, plain browser JavaScript, no build
step. The machine (`limethsith-create/email-distributor`, deployed at
https://email-distributor.vercel.app) runs every paying client (Starter,
Growth or Scale) by itself; the hub shows what it is doing and lets the owner
steer it, through the contract in `email-distributor/docs/HUB-API.md`.

> **No free trial, one way in (November 2026).** A client starts as a booking
> from the website's "Book a call" form; the owner marks it **Won** after the
> sales call (they become a client and get the onboarding email) or **Lost**.
> "+ Add a paying client yourself" stays. The Trials place, the waiting list,
> Day 30 and the decision page, the Test run, the Dialer and My stats (the
> owner's own cold email) are gone.

The hub is for one person. Sign-in is Supabase email + password, and only a
`profiles` row that is `approved` with `role = 'admin'` gets in; anyone else
sees "This hub is for the Aviance owner." and is signed out.

> The older workspace features (projects, team, clients, calendars, CRM,
> proposals, invoices) were removed from the hub. Their data is still stored in
> the Supabase tables `workspace_shared` / `workspace_admin` — it is simply not
> shown any more.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The shell: styles, login screen, app skeleton, sign-in/recovery, router, the four-place navigation (sidebar on a computer, tab bar on a phone), ⌘K, notifications, theme. |
| `trials.js` | Clients (the list, one client's page and their email system, Buy & paste, Behind the scenes) and Settings — the file name is from the trial days. Talks to the machine. |
| `calendar.js`, `calendar.css` | The Calendar: requests waiting for your yes, the week, meetings, each confirmed call's Google Meet, and "Book a call" for a cold call (see `email-distributor/docs/CALENDAR.md`). |
| `messages.js` | Messages on every client page (the whole conversation, how each email we sent went, the reply box, the reply-bot switch), Settings › Google Meet and Settings › Reply bot (see `email-distributor/docs/REPLYBOT-MEET.md` and HUB-API "Delivery monitoring"). Styles in `trials.css`. |
| `autobuy.js` | Their domain and inboxes through CheapInboxes: the "what to buy" panel behind the big button, the "Inboxes & domain" card on a client while it sets itself up, and Settings › Inboxes & domains (see `email-distributor/docs/AUTO-BUY.md`). Styles in `trials.css`. |
| `warmup.js` | Warm-up: Settings › Warm-up (the circle meter, why helpers exist, the helpers with Test / Remove, Add a helper) and the "Warm-up" card on a client; while a client waits for helpers its big button is "Add N warm-up helpers" (see `email-distributor/docs/WARMUP-HUB.md`). Styles in `trials.css`. |
| `keys.js` | The owner's own set-up, so he never opens Vercel: Settings › Keys (one card per service key — status in words, the steps and an "Open …" link, a password box, Test and save / Test / Forget; a value is never shown back) over `GET/POST /api/mc/keys`, and Settings › Your details (name, address, email, the onboarding inbox, call link, PayPal.me, Wise, Clutch — each with its own Save, "Still to fill in: N", the two the first client needs marked in amber) over `GET/POST /api/mc/config` (see `email-distributor/docs/KEYS.md`). Styles in `trials.css`. |
| `trials.css` | Styles for the Clients screens, on top of the shell's CSS variables (light + dark). |
| `inquiries.js` | Bookings: the sales calls booked from the website — list, detail, status/notes, Won / Lost, the board strip. |
| `manifest.webmanifest` | Makes the hub installable (Add to Home Screen) — the hub can sit on a phone's home screen. |
| `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | The brand cube from the website, flattened onto white (see *Home Screen app*). |
| `tests/trials.test.mjs` | Node tests for the shell (router, admin gate, ⌘K, deep links), the Clients screens, bookings waiting for their sales call (Won / Lost), and the readability floor. |
| `tests/simple.test.mjs` | Node tests for the simple hub: the four places and their badges, the one journey, "Needs you", the three questions and the one big button, Settings, deep links, plain words (a banned-word list), and no function name declared twice. |
| `tests/calendar.test.mjs` | Node tests for the Calendar. |
| `tests/messages.test.mjs` | Node tests for Messages (each kind of email, escaped; auto-reply labels; reply and bot posts), "Answer Sam's message", the Join Google Meet button and its fallback, Settings › Google Meet (states, the four actions, the return from Google) and Settings › Reply bot (incl. "who are you" / "not now" and the check-back weeks); delivery monitoring: the status line under our emails (each status, amber "not opened yet", red bounce with why, missing fields, escaping), the "hasn't opened" to-do (big button, list line, confirm → `unopenedDone`, reload), the four new alerts, plain words. |
| `tests/autobuy.test.mjs` | Node tests for CheapInboxes: the big button and the "what to buy" panel (Copy, "Buy this one instead", "I've bought it — check now", one post per click), the card in every status (steps, current step, inboxes, the problem + "Check now", "Wrong domain? Undo"), the Buy & paste fallback with its pointer to Settings, Settings › Inboxes & domains (states, card on file, steps, Save / Test it / Forget, "This is for…" + Link it), plain words, and that nothing can place an order. |
| `tests/warmup.test.mjs` | Node tests for the warm-up: the circle meter in each state, the helpers' health words, Test / Remove bodies, Add a helper (kinds, steps, password label, the body, greyed out while testing, success and refusal), the trial card, the "Add N warm-up helpers" big button, `#settings/warmup`, the `{view:'settings', section}` to-do, plain words. |
| `tests/keys.test.mjs` | Node tests for Settings › Keys (cards per status, order, env-set keys without a box, save / test / forget bodies incl. Verifalia's two fields, a refused key keeps what was typed, a saved one is cleared and never drawn, no encryption key) and Settings › Your details (the eight boxes, required marks, "Still to fill in", save / clear bodies for both row shapes, checks), `#settings/keys`, `#settings/details`, ⌘K, the "Is everything running?" pointers, plain words, touch targets. |
| `tests/app.test.mjs` | Node tests for the manifest, the icons, the `<head>` tags and the manifest. |
| `tests/fixtures.mjs` | Sample machine answers, shaped exactly like the contract — including a realistic growth history generator and a tiny growth payload full of nulls. |
| `tests/journey.test.mjs` | The dress rehearsal: the machine's 31 real snapshots of one client's whole journey (the booking → Won → onboarding call → warm-up → the launch call → sending → month two), each drawn with the real hub code on a device set to US Pacific — the Clients list, the three questions and the big button, Messages (with how each email we sent went), the call / inboxes / warm-up / launch-call cards, "What we found" (the brief and the company file), every Behind-the-scenes tab, the Calendar and Settings; plus the moment of the launch call itself and the delivery watch (an unopened "we start on" email, a bounce, a failed send — between two snapshots). Checks: nothing broken or empty on screen, the journey step is the machine's, the big button is what the owner must do, red only when he is needed, plain words, Sri Lanka time with US Eastern beside a call. `HUB_JOURNEY_REPORT=path npm test` writes what the owner sees at every step as plain text. |
| `tests/journey-fixtures.mjs`, `tests/fixtures/journey/` | A trimmed copy of the machine's snapshots (`email-distributor/tests/fixtures/journey/`) without repeats; `node tests/fixtures/journey/trim.mjs` copies them again. |

## Screens

A few places only, the same on a phone (a tab bar along the bottom) and a
computer (a sidebar): **Clients**, **Calendar**, **Team**, **Activity** (the
owner) and **Settings** (the owner). Badges: Clients = how many clients need
you + new bookings (red), Calendar = call times waiting for your yes (amber).
The hub opens on Clients (`#trials`, the old place, opens it too). Pages
inside a place (a client, Buy & paste, the bookings, Behind the scenes) have a
Back arrow in the top bar.

**One journey, everywhere the same:** ① Sales call → ② Onboarding call →
③ Setting up → ④ Sending emails → ⑤ Stopped, from the machine's
`row.simple.step` (new → 1, accepted/call_booked → 2, setting_up/warming_up →
3, sending → 4, finished → 5; declined is "Not taken", grey, no journey).
While sending it also says "Day 12 of sending" (unless the plain sentence
already says the day).

- **Clients** (the landing view) — first, the bookings waiting for their sales
  call (state `applied`): the business, the plan, how well they match,
  **Before the call (Word)** and **Won** / **Lost**. Then one row per client:
  the company and the person, the journey as five small squares (done ✓,
  current filled) with "Step 2 of 5 — Onboarding call", the machine's plain
  sentence (`row.simple.label`) and what happens next (`row.simple.next`). A
  row that needs you has a red left edge and a red "You need to…" line (from
  the next step, or the first to-do; when they wrote and nobody has answered
  it says "Sam wrote — answer them") and sits under **Needs you**; then
  **In progress**; then a folded **Done / not taken**. The owner sees the money
  received (this month · all time) above the stage tiles. At the bottom:
  **Bookings ›** and **+ Add a paying client yourself** (with the plan).
  Opening it asks the machine to look for onboarding-call replies and bookings
  (`POST /api/mc/onboard-calls/check`, fire-and-forget). Refreshes itself
  every 60 s while open.
- **A client** — one card, big and plain: the journey, the one-line status
  ("Sending — day 13, 1 call booked") and — only when something needs you —
  **What do you need to do?** with ONE big button for the single most
  important thing, in this order: a booking waiting for its sales call ("Read
  what we found, then mark it Won or Lost" → scrolls to it) · a call time they
  asked for · their message waiting for an answer · a call whose time has
  passed · a late booking · buying the domain and inboxes · warm-up helpers ·
  anything else on the to-do list (not urgent: "When you have a minute: …") ·
  otherwise "Nothing — we'll tell you when something needs you". Under the
  card: ONE big button, **Open <Business>'s email system →** — or, before Won,
  what they sent and what we found (Won / Lost / Download as Word).
- **Their email system** (`clientSystem`, `#system/{id}` = Shared › Overview,
  `#system/{id}/{tab}`, Back → the client page) — the whole width of the screen.
  At the top one switch with two sides (the side and tab last open are
  remembered per client):
  - **Shared with <Business>** (the default) — exactly what the client sees on
    their own page, so you can show it to them: "This is exactly what Dana sees
    on their own page", who has access ("Shared with dana@… · 2 people" →
    Manage, or "Not shared yet — Give access"). Five tabs: **Overview** (where
    they are on the journey in plain words, Emails sent · Opened · Replies ·
    Bounced, Interested · Calls booked, emails sent per day), **Conversations**,
    **Emails sent**, **Calls** (the calls prospects booked: when, who, booked /
    showed / no-show; the onboarding and launch call times — nothing to press),
    **Messages** (your emails with them, the reply box). Never money, costs,
    the fit score, internal to-dos, rule names or dispute buttons.
  - **Only you** (a lock, a tinted screen; you and your team) — **Money & plan**
    (the Money card — the owner only —, the plan, Day 1 and the sending day), **Health** (Inboxes & warm-up · Landing in the inbox · Growth
    over time), **Leads & emails** (Leads · The emails · Replies · Coming up),
    **Setup & history** (who they are, who can see their page, what they sent before the sales call,
    the call boxes and disputes, Parts, History, Actions with "Also on your
    list").
  Every to-do, the bell, ⌘K, the Calendar and `openTrial(id, tab, section)` land
  on the right side and tab.
- **What we found** (before the sales call; `application.research`,
  `email-distributor/docs/HUB-API.md` "Applicant research"). At the top,
  **Before the call** (`renderBrief`): the machine's brief (`research.brief`, up
  to 12 plain sentences) as one readable paragraph; after each sentence a small
  mark — a numbered link when the source is a page (`tkSafeUrl`, new tab;
  "Google Maps", "Google News", "Web archive" named in words), the record's name
  as plain text otherwise ("fit score", "USAspending.gov", a Census benchmark as
  "Census figures"); every source once under it, folded ("Where this comes
  from · 13 sources"). No brief → no card. Then the summary, the flags, About
  the company and the **Full company file**, which adds (folded): **Who buys
  from them** (`deep.customers`: the line, the kinds of customers as pills with
  their counts, the clients they name with a link to the page), **In the news**
  (`deep.news`: each story's title as a safe link, source · date, its flags as
  small pills — "New office", "Lawsuit"…; the search as a caption), **Competitors
  nearby** (`deep.competitors`: name, rating and reviews, their site and Google
  Maps; the search as a caption; "we never email them") and **What they write
  about** (`deep.topics`: how often they post, the words they use most).
- **Settings** — named sections, each folds open and says its state in one
  word: **Alerts** (every alert, "Not seen" first, "Mark as seen"; `#alerts`
  opens it), **Your details** (`#settings/details`), **Keys** (`#settings/keys`), **Google Meet**, **Inboxes & domains**, **Warm-up** (`#settings/warmup` opens it), **Reply bot**, **Is everything running?** (last check-in, last
  email sent, clients running, alerts not seen, paid services used, setup
  still to finish), **Behind the scenes** (the old board: every to-do, all
  clients by stage), **Advanced**
  (the full control panel — Mission Control — pages, opened signed-in in a new
  tab), **Light or dark**, **Your account** (log out).
- **Inboxes & domain** (`autobuy.js`, `autobuy` on the client detail —
  `email-distributor/docs/AUTO-BUY.md`). The owner buys in his own
  CheapInboxes account; the system never buys or spends anything — it finds
  the purchase, matches it to the client and sets up the rest. While a client
  waits for its domain (`ready_to_buy`) the big button opens a panel with
  exactly what to buy: the domain and its price (up to 3 other free names,
  folded, each "Buy this one instead" → `{action:'pick', domain}`), Google, the
  two inboxes (first name, last name, email prefix, full address — each with
  **Copy**), **Open CheapInboxes** (their order page, new tab), "After you buy,
  we connect everything by ourselves — you'll get a message." and "I've
  bought it — check now" (`{action:'recheck'}`). Once bought, the **Inboxes &
  domain** card: the plain sentence, the steps with ticks and times (the
  current one highlighted), each inbox (Being created / Created / Connected),
  and when it failed the problem in plain words + **Check now**. "Wrong domain?
  Undo" (`{action:'unlink'}`, asks first) until anything is connected. Every
  post goes to `POST /api/mc/clients/{id}/autobuy`, one at a time (the button
  is greyed out until the answer is in), and the card and the three questions
  are redrawn from the answer's `autobuy`.
  **Settings › Inboxes & domains** (`GET/POST /api/mc/cheapinboxes`, fetched
  when Settings opens, at most every 5 minutes): Not set up · Connected as
  {account} · Problem — {reason}; whether a card is on file ("Add a card in
  your CheapInboxes account under Billing" when not); six numbered steps
  (account → card → API key → paste it → **Save** → **Test it**); the key in a
  password box (`saveKey`, cleared once saved, never shown back), **Test it**,
  **Forget the key** (asks first); and purchases it couldn't match — "This is
  for…" (the clients in the Setting-up step) + **Link it** (`{action:'link',
  domain}`). Without CheapInboxes the Buy & paste page stays exactly as it was.
- **Warm-up** (`warmup.js`, `email-distributor/docs/WARMUP-HUB.md`). The warm-up
  is the system's own free circle; what it needs from the owner is **helpers**
  (free Gmail / Yahoo / AOL / iCloud / GMX / WEB.DE / Yandex accounts he makes
  once — the system never creates accounts). **Settings › Warm-up**
  (`GET /api/mc/warmup`, at most every 5 minutes, at once after a change): the
  circle meter ("6 of 8 in the warm-up circle — add 2 more helpers", one square
  per place, green when ready), one line on why helpers exist, each helper
  (address, kind, Working / New / Not working: {problem} / Off) with **Test**
  (`testHelper`) and **Remove** (`removeHelper`, asks first), and **Add a
  helper**: big buttons for each kind → its numbered steps and note → the
  address and a password box labelled the provider's way (`passwordLabel`) →
  **Test and add** (`addHelper`; greyed out with "Testing the login…" for up to
  a minute) → "Added — Gmail helper is working" or the reason in plain words.
  Answers redraw only the meter and the helpers, never what is typed. A client's
  **Warm-up** card (`warmup` on the detail): a bar (day N of about 14), how many
  reach the inbox, each inbox with its day and rate, "Ready to start sending
  around …", the problem when paused — the machine's label only when the top of
  the page doesn't already say it. While `warmup.status` is
  `waiting_for_helpers` the big button is **Add N warm-up helpers** → Settings ›
  Warm-up (N from the client, else Settings' answer, else the to-do's words). A
  to-do `{type:'view', view:'settings', section}` (warm-up, inboxes…) opens that
  Settings section.
- **Onboarding call** card (when `detail.onboardCall` exists — after Approve
  the machine sends one email asking them to book the call): its plain
  label, the five steps as ticks with times, "Book by {day}" (red when
  overdue), how many reminders went out, the booking link, one line pointing
  to the emails ("See the messages" — they live only under Messages, never
  twice) and the buttons **Mark call booked** (date + time), **Call
  done**, **They didn't show**, **Send the email again**, **Stop reminders**
  — each posts `POST /api/mc/clients/{id}/onboard-call` `{action, …}`, says
  what happened in plain words and redraws the card from the answer.
- **Launch call** card (when `detail.launchCall` exists — near the end of
  warm-up the machine sends the launch invite: their list and their emails
  are ready, go through them together; `email-distributor/docs/LAUNCH-CALL.md`).
  It is the SAME card (`renderCallCard`, drawn with `kind: 'launch'`), right
  under the Warm-up card, above the folded onboarding call. At its top:
  **Before the call** — the research brief (`application.research.brief`, the
  same `renderBrief` card as at the top of "What we found"), open while the
  call is ahead, one closed line once it is over. Then the five steps,
  "Book by", the messages link, Join Google Meet / See it in the Calendar, and
  **Open the approval page** (a safe link, new tab — he shares his screen on
  the call). Two extra buttons: **Approved on the call** (first while the call
  is booked or done and their OK is not in; asks "This approves their list and
  emails — sending can start.") and **Skip the call** (only once they approved
  on the page themselves — "They approved on the page on {date}. The call is
  optional now"). After the OK: "Approved on the call — sending starts on Day 1
  (Mon 26 Oct)". Each posts `POST /api/mc/clients/{id}/launch-call` `{action}`
  (`approvedOnCall`, `skip`, and the shared ones with the kind carried along);
  the card and the three questions are redrawn from `{ok, launchCall}`. The
  big button follows it: "Say yes to their launch-call time" (Calendar), "Hold
  the launch call, then press Approved on the call" (scrolls to the card),
  "Press Approved on the call", "Mark the launch call done", "Skip the launch
  call", "Write to them about booking", "Answer {name}'s message". The
  journey stays ①–⑤; step ③'s sentence is the machine's `simple.label`. In the
  Calendar a `kind: 'launch'` meeting reads "Launch call · 8:30 pm · Confirmed"
  (its title from the machine, "Launch call — {company}" when there is none)
  and the panel's first button is **Approved on the call**, a shortcut to the
  client's launch card while the OK is not in.
- **Messages** (every client page, right under the three questions;
  `messages.js`, `conversation` on the client detail) — every email between
  him and the client as a chat, oldest at the top and the newest scrolled
  into view: theirs on grey at the left ("Sam wrote", or the address when
  someone else from their side writes), ours outlined at the right ("You
  wrote", "Acceptance email — sent automatically"…), the reply bot's dashed
  and marked "Auto-reply · sent your booking link and free times" (each rule
  in plain words), automatic emails folded to one line "We sent: {subject}"
  with "show". Times in Sri Lanka time with "(US Eastern …)" small. Plain
  text, escaped, line breaks kept; the subject only when it changes. Under
  each of our emails (on a folded one, in its line) a small grey line says
  how it went, in the machine's own words (`statusText`: "delivered · opened
  Tue 8:10 pm", "replied …", "sent …"); a bounce is red with why in plain
  words ("— that email address does not exist"; the returned reason itself is
  only in the tooltip); an important email (`milestone`) with `unopenedAt`
  and no `openedAt` is amber ("… · not opened yet"). Their emails, and older
  ones without the fields, show nothing. The call cards send him here for the
  emails, so this is the one place it shows. Then
  "Sam is waiting for your answer." (red) when `needsReply`, a reply box
  "Send to Sam" (2 000 characters) → `POST /api/mc/clients/{id}/messages`
  `{action:'reply', text}` and a switch "Reply bot for Sam: On/Off" →
  `{action:'botOn'|'botOff'}`; both redraw Messages and the three questions
  from the answer's `conversation` at once. No inbox to send from
  (`canReply: false`): "Set up the inbox in Settings to reply from here." An
  older machine without `conversation` shows the onboarding call's thread and
  sends the reply through the call's own reply action (same email thread).
- **Settings › Google Meet** (`GET/POST /api/mc/google`) — the status in
  words: Not set up · Ready to connect · Connected as owner@gmail.com ·
  Broken — connect again (with the machine's `problem`). Eight numbered steps
  for a first-timer (a Google Cloud project → the Google Calendar API → the
  consent screen: External, his email, **Publish app** → Credentials › OAuth
  client ID › Web application → the redirect address with a **Copy** button
  → Client ID + Client secret (a password box) and **Save** → **Connect
  Google** → **Test it**), open until the details are saved, then folded.
  Buttons by status: Connect Google (goes to Google's page — only a
  `*.google.com` https address is followed), Test it (shows the test Meet
  link), Disconnect (asks first). Google sends him back to
  `#settings/google?connected=1` or `?error=<code>`: Settings opens there with
  a plain sentence for every code (docs/GOOGLE-SETUP.md). The status is
  fetched when Settings opens (at most every 5 minutes, never by the 60 s
  refresh). Details set on the server (`clientFrom: 'env'`) → nothing to
  paste; no password lock (`encKey: false`) → said plainly.
- **Settings › Reply bot** — what it answers, rule by rule in plain words
  (including "They ask who you are, or how you got their email" and "They say
  not now, or later" — "check back in N weeks" from `REPLYBOT.laterWeeks` in
  `GET /api/mc/config`, which Settings already reads for Your details; "in a
  few weeks" without it — read-only like the rest), what it never does, and
  where to switch it off (one person: the switch under Messages; everyone:
  Advanced settings). The contract has no switch for everyone, so no state is
  shown unless the board ever sends `replyBot {enabled}`.
- **The delivery watch** (HUB-API "Delivery monitoring") — the to-do
  `unopened:{id}` ("Sam hasn't opened the “we start on” email — call or text
  them?") is the client's big button **I've reached Sam** (red), with when it
  went; it asks the to-do's own question ("Did you reach Sam? This clears the
  reminder."), posts `{action:'unopenedDone'}` through the generic "api"
  to-do action, and reads the client and the list again (pressed from the list,
  a client kept from before is read again when opened). On the list its red
  line is the machine's question as it is. The alerts `client_email_failed`
  and `client_email_bounced` (urgent) show the machine's title; their to-do's
  big button "Mark as seen" says what to do first ("Reach Sam another way —
  call or text" / "Check Sam's email address with them"); `client_email_unopened`
  and `bot_later_due` are quiet notes in Settings › Alerts (not in the bell).
- **Calendar and Google Meet** — a confirmed call with `meetLink` gets a big
  **Join Google Meet** button in its panel (safe link, new tab) and a small
  camera on its block in the week and the phone list. Without one: "No Meet
  link yet" + why (the machine's `meetError` in its own words; "Settings ›
  Google Meet" as a button when the Google status in `settings.googleMeet`
  is not connected) + either "The email had your usual link instead" or
  "Send them a link yourself".
- **Book a call (cold call)** — the Calendar's **Book a call** button opens a
  form for someone on the phone: their name, email, and the date and time in
  your own time zone (required); company, website, time zone or US state,
  phone, what they sell, plan and notes (optional). As you type, the hub asks
  the machine (`POST /api/mc/inquiries`, `action:'bookCheck'`, nothing saved)
  and shows "Your time … · Their time …", where the website and time zone came
  from ("from their email", "guessed from the phone number", "US Eastern, as
  nothing was given") and any warnings in amber. **Book it** sends
  `action:'book'`; on a 409 (a clash, or outside your call hours) the
  warnings show with **Book it anyway** (resends with `force:true`). On
  success: a toast and the new booking opens (`#inquiry/{id}`).
- **Behind the scenes in a client's email system** — tabs. **Parts**: the 13 parts as one
  strip (each says OK / Working / Waiting / Blocked / Off in words), and four
  growth numbers — emails sent, replies, calls booked, warm-up inbox rate —
  each with a 14-day sparkline (fetched only once you open Parts), then each
  part in full. Everything else lives in tabs: **Growth**,
  Parts, **Leads**, **Deliverability**, Inboxes, Calls, Replies, Copy,
  Coming up (dates, your promises and notes, reports), History, Actions
  (move to another step, automatic tasks, re-run a step, invoice, client links).
- **Growth tab** — the progress of every system over time, 7 / 30 / 45 / 90
  days: emails sent per day (first emails vs follow-ups) with replies,
  positive replies and calls booked in aligned rows underneath (each on its own
  scale — never two scales on one chart), warm-up emails per day (landed in
  the inbox vs spam, with the number sent) and the rolling 7-day inbox rate
  against the 90% "ready" and 80% "low" lines, one small chart per inbox (rate
  + today's cap), and every placement test: the seed test (share that landed
  in the inbox, against the 85% Day-1 line), the SpamAssassin points from
  DKIM Validator (lower is better; Day 1 needs 2 or less, 5 or more = spam)
  and the mail-tester score (out of 10; Day 1 needs 8 or more), each dot
  coloured pass / too high / spam, with each inbox's own result in the
  tooltip. Hover or tap a day for the numbers in plain words; arrow keys work
  too; "Show the numbers" gives the same data as a table. A day with nothing
  recorded is a gap; a recorded day where nothing happened is a real 0 (the
  warm-up days before Day 1 show 0 emails, and "Starts on Day 1").
  The Day-1 lines are the machine's defaults (CANARY.gate 0.85,
  PLACEMENT.minScore 8, PLACEMENT.maxSpamAssassin 2); the payload does not
  carry them yet, and a test's own `pass` from the machine always wins.
- **Leads tab** — "Ready to send" (good leads not yet emailed), good leads in
  total, lead grades (A / B / C / rejected), when the leads were last graded,
  email checks and today's check budget, top reject reasons, where leads come
  from, and the 25 best leads with why. Before the first list arrives it says
  so instead of showing zeros.
- **Deliverability tab** — bounce rate for the last 7 days (with how many
  were sent and when it was worked out) against the pause and stop lines from
  the machine, and "Half speed" when the machine has slowed sending;
  blacklists (Clean / Listed / "Couldn't check", with which lists were listed
  or couldn't be checked); the spam tests with a plain "Day 1 check passes /
  not passed yet" line (every inbox's newest test must pass); every placement
  test with its tool, result and report link (a test that couldn't finish says
  so); the warm-up circle (pool, helpers, this client's and Aviance's inboxes,
  provider families, providers, today's pairs, and the outside warm-up network
  — connected or not, and how many a day); and the domain's DNS checks.
- **Before the sales call** — a booking with a website holds a client record
  in `applied` (researched, nothing emailed). Its page shows who booked and
  when, **what the machine found** about the company (the brief, the fit
  score, services, locations, Google rating, team size, socials, their market
  size, warnings in amber; **Research again** looks it up again) and every
  answer, with **Won — make them a client** (the onboarding email goes out; the
  booking moves to Won) and **Lost** (nothing is emailed; the booking moves to
  Lost). Once decided it folds into one line ("Before the sales call · Won").
- **Buy & paste** — the one manual step per client: the total for the first
  month, a comparison of the best domain names (why, the best first-year and
  renewal price with a **Buy at {registrar}** link straight to that
  registrar's search for the name, any promo code as a small chip, every other
  registrar's price marked *live* or *price list*) with a **Use this domain**
  button that fills the form, the inbox order (CheapInboxes: price, count, monthly cost and a
  step-by-step checklist with the sender names), then the form to paste the
  domain and inbox logins. Older machines without the comparison still show
  the plain shopping list.
- **Bookings** (Inquiries) — people who booked a sales call from the
  website's "Book a call" form — the only way in. The machine saves
  each one, puts the call in the Calendar as a confirmed **Sales call**, emails
  them a confirmation with a calendar invite, then reminders the day before and
  an hour before, and pops it up on the owner's phone.
  - **Stages** (the pipeline, in order): Booked · Call done · No-show ·
    Following up · Agreement and invoice sent · Won · Lost. Above the list, one tile per
    stage with how many are in it (a tile filters the list); chips Open / All.
    Calls still ahead come first, soonest first. Each card shows its stage, the
    call, their answers in one line (role · deal size · calls a month) and what
    was emailed (✓ Confirmation · Day before · 1 hour before). A Booked call
    whose time has passed gets a red edge: "How did the call go? Move them on".
  - One inquiry: Join the call (Google Meet) · Reply by email · See it in the
    Calendar; **Where it stands** — a stepper (Booked → Call done → Following up
    → Agreement and invoice sent → Won), the likely next stages as buttons, every other stage
    under "Another stage", a note with the change; **Their answers** (the
    website's five questions); **Emails to them** (confirmation, reminders).
    Call done / No-show here also mark the Calendar meeting, and the Calendar's
    buttons move the inquiry. The Calendar's meeting panel has "Open their
    inquiry".
  - The list: four filter chips with their counts — Open (the default: new +
    contacted), Won, Lost, All — and a card per inquiry,
    newest first — company, name, plan, the booked call in the owner's time
    (the website's own text) with "call in 3 h" / "was 2 days ago", what they
    sell, and a red New marker until someone moves it on.
  - One inquiry (`#inquiry/{id}`, what a link to it opens): **Reply by
    email** (mailto, subject "Your Aviance call"), their time and time zone,
    email, website, what they sell, plan; **Where it stands** — the stages,
    with an optional note. **Won** asks first, makes them a paying client (the
    onboarding email) and links to their page; the machine says why when it
    can't (a booking without a website: **Add them as a paying client**, filled
    in from the booking). **Lost** closes the record held for the call;
    **Notes** (newest first) + Add note.
  - On Behind the scenes a strip — "2 new inquiries — Stone Roofing, call Tue
    7:30 PM" (the soonest upcoming call, in Sri Lanka time) — opens the list;
    each new one is also an urgent to-do ("Open the inquiry"), in the bell, and in
    ⌘K. The Inquiries badge counts new ones.
  - Machine: `GET /api/mc/inquiries`, `POST /api/mc/inquiries`
    `{action:'status'|'note', …}`, and `inquiries` on
    `GET /api/mc/hub` (see HUB-API.md "## Plan inquiries"). An older machine
    without it simply shows no strip and no badge.

Top bar: Back (on pages inside a place), the page title, ⌘K on a computer
(find a client, or type what you want to do), and the bell (what needs you:
urgent to-dos, urgent alerts, call times waiting for your yes).

## Alerts: inside the hub only

Machine alerts are not sent to the owner's email, phone or Telegram. They show
in the bell and in Settings › Alerts, and nowhere else. (Phone notifications,
the service worker and `push.js` were removed on 2026-11-20; a phone that had
turned them on forgets its old helper the next time it signs in.)

The hub can still be added to a phone's Home Screen (Share → Add to Home
Screen); it then opens like an app. Links such as `#trial/{id}` open straight to the page.

- Deep links (`#trial/{id}`, `#alerts`, `#trials`, `#settings/google?connected=1|error=…`) work on load and on
  `hashchange`; the hash is cleared once handled so the same alert can open it
  again.
- The brand PNGs on the website have a transparent background (and a
  transparent stripe under the red top). iOS paints transparency black on the
  home screen, so the hub's icons are the same cube flattened onto white.

## Readability floor (keep this in any redesign)

The owner reads this hub a lot; text must be easy to see. Every size and
colour comes from tokens in `index.html` (`:root`, and `body.dark` for dark
mode), and the tests enforce the floor.

- **One simple font:** the computer's own UI font for everything —
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
  sans-serif` (the `--font` token). Nothing is downloaded, so it never loads
  late or looks different while loading. No second font (no monospace, not
  even for emails), no labels in capitals, no letter-spacing, and only two
  weights: 400 (normal) and 600 (bold).

- **Size:** nothing smaller than **13px** anywhere — labels, pills, badges,
  table heads, timestamps, chart labels, tab bar. Body text is **16px**.
  Scale: `--fs-min` 13 · `--fs-small` 15 · `--fs-base` 16 · `--fs-strong` 17 ·
  `--fs-h3` 19 · `--fs-h2` 24 · `--fs-num` 19 (the five numbers) ·
  `--fs-num-lg` 26. Use a token, never a raw size under 13px.
- **Contrast:** every text colour passes **WCAG AA, 4.5:1**, against every
  background it sits on, in light and dark — including pill text on its pill
  fill. Light: text #000, muted #3A3A3A, muted-2 #555555, green #17662F,
  amber #8A5300, red #B01F06 on white / #F4F4F4 / #EAEAEA. Dark: text #FFF,
  muted #C8C8C8, muted-2 #A3A3A3, green #5CCB83, amber #E6B03A, red #FF6A4D on
  black / #121212 / #1D1D1D. Pill fills are solid tokens (`--green-bg`,
  `--amber-bg`, `--red-bg`, `--blue-bg`), never see-through rgba, so their
  contrast is fixed and testable. The lowest pair in use is 5.4:1.
- **Charts:** every mark colour is at least **3:1** against the page in both
  themes (series blue `--c1`, orange `--c2`, violet `--c3`, grey `--c-none`,
  and a blue ramp `--g-a/b/c` for lead grades), checked with a colour-blind
  safety validator. Chart text is ordinary HTML, not SVG text, so it never
  shrinks below 13px on a phone.
- **Spacing:** line-height ≈1.5 for reading text; to-do rows, cards and
  table cells have room to breathe.
- **Phones (≤860px):** one column, the tab bar at the bottom, every tap target
  at least 44px (buttons, tabs, rows), long button labels wrap rather than
  clip, no sideways scrolling.
- **Colour means one thing:** red = needs you, amber = waiting, green = good,
  grey = done. Hover and focus use black/white, never red.

`npm test` fails if any `font-size` in `trials.css`, the shell styles or
inline styles drops below 13px, if any other font family, capitals-only
label, letter-spacing or weight other than 400/600 appears, if any text pair
drops below 4.5:1, or if any chart mark drops below 3:1.

## How much the hub asks of the machine

The growth history is the expensive call (about days × (2 + inboxes) Redis
reads), so the hub only fetches it when you open something that shows it:

- **Growth tab** — the chosen range, reused for 5 minutes.
- **Parts** (a client's email system › Behind the scenes) — 14 days, reused for 15 minutes.
- **Overview** (a client's email system) — their growth history for the chart and by inbox, reused for 5 minutes.
- **Board cards** (Behind the scenes only — the Clients list asks for none) — 14 days per warming/sending client (never for clients
  still applying, onboarding or buying), reused for **6 hours** and kept in
  the browser (`localStorage`) so reloading the page costs nothing. Signing
  out clears it.

The 60-second auto-refresh never fetches growth history.

## `MACHINE_URL`

`index.html` defines `MACHINE_URL` (default `https://email-distributor.vercel.app`).
To point the hub at another machine while testing, set
`localStorage.avianceMachineUrl` in the browser console and reload:

```js
localStorage.setItem('avianceMachineUrl', 'http://localhost:3000')
```

## How the hub signs in to the machine

Every `/api/mc/*` call carries the signed-in owner's Supabase access token as
`Authorization: Bearer <token>` (`machineFetch()` in `trials.js`). The machine
verifies the token against the Supabase project's public keys and checks the
email is on its admin list. No machine secret lives in the hub.

To open a Mission Control page inside the machine, the hub POSTs a hidden
form with `hubToken` and `next` to `POST /api/mc/login` in a new tab
(`openMachine()`); the machine sets its own session cookie and redirects.

If the machine cannot be reached, every screen shows one card with the reason
and a "Try again" button; after a failed refresh the last good data stays on
screen with a red note saying so.

## Running locally

Any static file server works (`npx serve .`, `python3 -m http.server`).
Sign-in needs the real Supabase project.

## Tests

```
npm test          # node --test tests/*.test.mjs
HUB_JOURNEY_REPORT=/tmp/journey.txt npm test   # + a plain-text report of every step of the journey
npm run check     # node --check trials.js, inquiries.js, calendar.js, messages.js, autobuy.js, warmup.js, keys.js, people.js, ava.js
```

The tests load the shell's inline script, `trials.js` and `inquiries.js` into a tiny fake DOM
with a fake Supabase client, then exercise the router, the admin gate, the
chart data mapping (null = gap, 0 = a real zero), spam-test verdicts for
both tools, when growth is and isn't fetched, the simple Clients list (needs-you
order, the `simple` fallback, escaping, and that the old clutter is gone), the
client page's journey line and onboarding-call card (every reply/button posts the
contract body; the check call), the Inquiries screens and
actions (incl. the empty state and an older machine without inquiries), and the
pure render functions with `tests/fixtures.mjs`; no network.

Charts are hand-drawn SVG in `trials.js` (no chart library, no build step):
`renderChart()` for the Growth tab, `renderSpark()` for the tiny ones.
Lines and bars are SVG stretched to the width; dots are small HTML circles
laid over the chart so they stay round and visible on a phone.
