# Aviance Hub

The Aviance owner's window onto the **trial machine** — live at
https://aviance.store. One static page, plain browser JavaScript, no build
step. The machine (`limethsith-create/email-distributor`, deployed at
https://email-distributor.vercel.app) runs every 30-day trial by itself; the
hub shows what it is doing and lets the owner steer it, through the contract
in `email-distributor/docs/HUB-API.md`.

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
| `trials.js` | Trials (the list, one trial, Buy & paste, Behind the scenes) and Settings. Talks to the machine. |
| `calendar.js`, `calendar.css` | The Calendar: requests waiting for your yes, the week, meetings, each confirmed call's Google Meet (see `email-distributor/docs/CALENDAR.md`). |
| `messages.js` | Messages on every trial page (the whole conversation, the reply box, the reply-bot switch), Settings › Google Meet and Settings › Reply bot (see `email-distributor/docs/REPLYBOT-MEET.md`). Styles in `trials.css`. |
| `autobuy.js` | Their domain and inboxes through CheapInboxes: the "what to buy" panel behind the big button, the "Inboxes & domain" card on a trial while it sets itself up, and Settings › Inboxes & domains (see `email-distributor/docs/AUTO-BUY.md`). Styles in `trials.css`. |
| `warmup.js` | Warm-up: Settings › Warm-up (the circle meter, why helpers exist, the helpers with Test / Remove, Add a helper) and the "Warm-up" card on a trial; while a trial waits for helpers its big button is "Add N warm-up helpers" (see `email-distributor/docs/WARMUP-HUB.md`). Styles in `trials.css`. |
| `keys.js` | The owner's own set-up, so he never opens Vercel: Settings › Keys (one card per service key — status in words, the steps and an "Open …" link, a password box, Test and save / Test / Forget; a value is never shown back) over `GET/POST /api/mc/keys`, and Settings › Your details (name, address, email, the onboarding inbox, call link, PayPal.me, Wise, Clutch — each with its own Save, "Still to fill in: N", the two the first trial needs marked in amber) over `GET/POST /api/mc/config` (see `email-distributor/docs/KEYS.md`). Styles in `trials.css`. |
| `trials.css` | Styles for the Trials screens, on top of the shell's CSS variables (light + dark). |
| `inquiries.js` | Inquiries: paid-plan calls booked from the website — list, detail, status/notes, "Start a trial instead", the board strip. |
| `push.js` | Phone alerts: the panel, turning Web Push on/off with the machine, the quiet re-subscribe after sign-in. |
| `sw.js` | Service worker (site root, scope `/`): shows the machine's push messages as notifications and opens the hub on a tap. Caches nothing. |
| `manifest.webmanifest` | Makes the hub installable (Add to Home Screen) — iPhone only allows alerts for installed web apps. |
| `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | The brand cube from the website, flattened onto white (see *Phone alerts*). |
| `badge-96.png` | One-colour "A" (white on transparent) for Android's status bar. |
| `tests/trials.test.mjs` | Node tests for the shell (router, admin gate, ⌘K, deep links), the Trials screens, application review, phone alerts (`push.js`) and the readability floor. |
| `tests/simple.test.mjs` | Node tests for the simple hub: the four places and their badges, the one journey, "Needs you", the three questions and the one big button, Settings, deep links, plain words (a banned-word list), and no function name declared twice. |
| `tests/calendar.test.mjs` | Node tests for the Calendar. |
| `tests/messages.test.mjs` | Node tests for Messages (each kind of email, escaped; auto-reply labels; reply and bot posts), "Answer Sam's message", the Join Google Meet button and its fallback, Settings › Google Meet (states, the four actions, the return from Google) and Settings › Reply bot. |
| `tests/autobuy.test.mjs` | Node tests for CheapInboxes: the big button and the "what to buy" panel (Copy, "Buy this one instead", "I've bought it — check now", one post per click), the card in every status (steps, current step, inboxes, the problem + "Check now", "Wrong domain? Undo"), the Buy & paste fallback with its pointer to Settings, Settings › Inboxes & domains (states, card on file, steps, Save / Test it / Forget, "This is for…" + Link it), plain words, and that nothing can place an order. |
| `tests/warmup.test.mjs` | Node tests for the warm-up: the circle meter in each state, the helpers' health words, Test / Remove bodies, Add a helper (kinds, steps, password label, the body, greyed out while testing, success and refusal), the trial card, the "Add N warm-up helpers" big button, `#settings/warmup`, the `{view:'settings', section}` to-do, plain words. |
| `tests/keys.test.mjs` | Node tests for Settings › Keys (cards per status, order, env-set keys without a box, save / test / forget bodies incl. Verifalia's two fields, a refused key keeps what was typed, a saved one is cleared and never drawn, no encryption key) and Settings › Your details (the eight boxes, required marks, "Still to fill in", save / clear bodies for both row shapes, checks), `#settings/keys`, `#settings/details`, ⌘K, the "Is everything running?" pointers, plain words, touch targets. |
| `tests/app.test.mjs` | Node tests for the manifest, the icons, the `<head>` tags and `sw.js` (run in a sandbox with a fake service-worker global). |
| `tests/fixtures.mjs` | Sample machine answers, shaped exactly like the contract — including a realistic growth history generator and a tiny growth payload full of nulls. |
| `tests/journey.test.mjs` | The dress rehearsal: the machine's 29 real snapshots of one applicant's whole trial (application → … → paid), each drawn with the real hub code on a device set to US Pacific — the Trials list, the three questions and the big button, Messages, the call / inboxes / warm-up cards, every Behind-the-scenes tab, the Calendar and Settings. Checks: nothing broken or empty on screen, the journey step is the machine's, the big button is what the owner must do, red only when he is needed, plain words, Sri Lanka time with US Eastern beside a call. `HUB_JOURNEY_REPORT=path npm test` writes what the owner sees at every step as plain text. |
| `tests/journey-fixtures.mjs`, `tests/fixtures/journey/` | A trimmed copy of the machine's snapshots (`email-distributor/tests/fixtures/journey/`) without repeats; `node tests/fixtures/journey/trim.mjs` copies them again. |

## Screens

Four places only, the same on a phone (a tab bar along the bottom) and a
computer (a sidebar): **Trials**, **Calendar**, **Inquiries**, **Settings**.
Badges: Trials = how many trial clients need you (red), Calendar = call times
waiting for your yes (amber), Inquiries = new ones (red). Everything else lives
in Settings. The hub opens on Trials. Pages inside a place (a trial, Buy &
paste, an inquiry, Behind the scenes) have a Back arrow in the top bar.

**One journey, everywhere the same:** ① Applied → ② Onboarding call →
③ Setting up → ④ Sending emails → ⑤ Done, from the machine's
`row.simple.step` (new/queued → 1, accepted/call_booked → 2,
setting_up/warming_up → 3, sending → 4, finished → 5; declined is "Not taken",
grey, no journey). While sending it also says "Day 12 of 30" (unless the plain
sentence already does).

- **Trials** (the landing view) — one row per trial client: the company and
  the person, the journey as five small squares (done ✓, current filled) with
  "Step 2 of 5 — Onboarding call", the machine's plain sentence
  (`row.simple.label`) and what happens next (`row.simple.next`). A row that
  needs you has a red left edge and a red "You need to…" line (from the next
  step, or the first to-do; when they wrote and nobody has answered —
  `simple.needsReply`, or the "answer them" to-do — it says "Sam wrote —
  answer them") and sits under **Needs you** at the top; then
  **In progress**; then a folded **Done / not taken**. When a client asked for
  a call time, a link under the row opens the Calendar at it. At the bottom:
  **+ Add a trial client yourself**. An older machine without `simple` falls
  back to the state and the to-dos. Opening it asks the machine to look for
  onboarding-call replies and bookings (`POST /api/mc/onboard-calls/check`,
  fire-and-forget) and refreshes if something new came in. Refreshes itself
  every 60 s while open (never the check, never growth history).
- **Trial** (one client) — three questions at the top, big and plain:
  **Where are they?** (the journey, bigger, + the plain sentence), **What
  happens next?** and **What do you need to do?** with ONE big button for the
  single most important thing, in this order: a new application ("Read the
  application and say yes or no" → scrolls to it) · a call time they asked for
  ("Say yes to their call time" → the Calendar at that meeting) · their message
  waiting for an answer (`conversation.needsReply`: "Answer Sam's message" →
  the reply box under Messages) · a call whose time has passed ("Mark
  the call done", asks first) · a late booking ("Write to them about booking")
  · buying the domain and inboxes — with CheapInboxes set up, "Buy their domain
  and 2 inboxes on CheapInboxes" (opens the "what to buy" panel), "See what
  went wrong" when setting them up failed (→ the card), and nothing while it
  sets itself up; without it, "Buy the domain and inboxes" (the Buy & paste
  page) with "Set up CheapInboxes in Settings" under it · anything else on the to-do list (not urgent:
  "When you have a minute: …") · otherwise "Nothing — we'll tell you when
  something needs you". Right under the questions: **Messages**. Below: the **Inboxes & domain** card (once bought), the **Warm-up** card (once `warmup` is set), the onboarding call card, the application (open
  while it waits; once decided, one folded line), any other to-dos under "Also
  on your list", and **Behind the scenes**, folded, with everything technical.
- **Settings** — named sections, each folds open and says its state in one
  word: **Alerts** (every alert, "Not seen" first, "Mark as seen"; `#alerts`
  opens it), **Phone alerts**, **Your details** (`#settings/details`), **Keys** (`#settings/keys`), **Google Meet**, **Inboxes & domains**, **Warm-up** (`#settings/warmup` opens it), **Reply bot**, **Is everything running?** (last check-in, last
  email sent, trials running, free extensions, alerts not seen, paid services
  used, setup still to finish), **Behind the scenes** (the old board: every
  to-do, all trials by stage, the waiting list, your own sending), **Advanced**
  (the full control panel — Mission Control — pages, opened signed-in in a new
  tab), **Light or dark**, **Your account** (log out).
- **Inboxes & domain** (`autobuy.js`, `autobuy` on the trial detail —
  `email-distributor/docs/AUTO-BUY.md`). The owner buys in his own
  CheapInboxes account; the system never buys or spends anything — it finds
  the purchase, matches it to the trial and sets up the rest. While a trial
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
  for…" (the trials in the Setting-up step) + **Link it** (`{action:'link',
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
  Answers redraw only the meter and the helpers, never what is typed. A trial's
  **Warm-up** card (`warmup` on the detail): a bar (day N of about 14), how many
  reach the inbox, each inbox with its day and rate, "Ready to start sending
  around …", the problem when paused — the machine's label only when the top of
  the page doesn't already say it. While `warmup.status` is
  `waiting_for_helpers` the big button is **Add N warm-up helpers** → Settings ›
  Warm-up (N from the trial, else Settings' answer, else the to-do's words). A
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
- **Messages** (every trial page, right under the three questions;
  `messages.js`, `conversation` on the trial detail) — every email between
  him and the client as a chat, oldest at the top and the newest scrolled
  into view: theirs on grey at the left ("Sam wrote", or the address when
  someone else from their side writes), ours outlined at the right ("You
  wrote", "Acceptance email — sent automatically"…), the reply bot's dashed
  and marked "Auto-reply · sent your booking link and free times" (each rule
  in plain words), automatic emails folded to one line "We sent: {subject}"
  with "show". Times in Sri Lanka time with "(US Eastern …)" small. Plain
  text, escaped, line breaks kept; the subject only when it changes. Then
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
- **Settings › Reply bot** — what it answers, rule by rule in plain words,
  what it never does, and where to switch it off (one person: the switch
  under Messages; everyone: Advanced settings). The contract has no switch
  for everyone, so no state is shown unless the board ever sends
  `replyBot {enabled}`.
- **Calendar and Google Meet** — a confirmed call with `meetLink` gets a big
  **Join Google Meet** button in its panel (safe link, new tab) and a small
  camera on its block in the week and the phone list. Without one: "No Meet
  link yet" + why (the machine's `meetError` in its own words; "Settings ›
  Google Meet" as a button when the Google status in `settings.googleMeet`
  is not connected) + either "The email had your usual link instead" or
  "Send them a link yourself".
- **Behind the scenes on a trial** — tabs. **Overview**: the 13 parts as one
  strip (each says OK / Working / Waiting / Blocked / Off in words), and four
  growth numbers — emails sent, replies, calls booked, warm-up inbox rate —
  each with a 14-day sparkline (fetched only once you open Behind the
  scenes). Everything else lives in tabs: **Growth**,
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
  so); the warm-up circle (pool, helpers, this trial's and Aviance's inboxes,
  provider families, providers, today's pairs, and the outside warm-up network
  — connected or not, and how many a day); and the domain's DNS checks.
- **Application review** — trial applications from the website arrive as
  clients in `applied`, held for the owner. On the board their card carries a
  "New application" marker; the "Review … application" to-do opens the trial
  scrolled to the **Application** section: who applied and when, the fit check
  (each rule pass / fail / unknown with a note), **what the machine found**
  about the company (summary, services, locations, Google rating with a Maps
  link, team size and age hints, socials, their market size, and warnings in
  amber) and every answer. **Research again** (small button beside "What we
  found") asks the machine to look the company up again. While it is
  pending it sits open on the trial page with two buttons — **Say yes and
  email them** (the machine sends the acceptance email, or puts them on the
  waiting list if three trials are running) and **Say no…** (a one-sentence
  reason, emailed to the applicant). Once decided it folds into one line
  ("Their application · You said yes").
- **Buy & paste** — the one manual step per trial: the total for the first
  month, a comparison of the best domain names (why, the best first-year and
  renewal price with a **Buy at {registrar}** link straight to that
  registrar's search for the name, any promo code as a small chip, every other
  registrar's price marked *live* or *price list*) with a **Use this domain**
  button that fills the form, the inbox order (CheapInboxes: price, count, monthly cost and a
  step-by-step checklist with the sender names), then the form to paste the
  domain and inbox logins. Older machines without the comparison still show
  the plain shopping list.
- **Inquiries** — people who want a paid plan (Starter / Growth / Scale)
  without a trial, from the website's "Book a call" form. The machine saves
  each one and pops it up on the owner's phone; nothing is sent to them.
  - The list: four filter chips with their counts — Open (the default: new +
    contacted), Won, Lost, All — and a card per inquiry,
    newest first — company, name, plan, the booked call in the owner's time
    (the website's own text) with "call in 3 h" / "was 2 days ago", what they
    sell, and a red New marker until someone moves it on.
  - One inquiry (`#inquiry/{id}`, what the phone alert opens): **Reply by
    email** (mailto, subject "Your Aviance call"), their time and time zone,
    email, website, what they sell, plan; **Where it stands** — Mark
    contacted / won / lost or Back to New, with an optional note; **Start a
    free trial and email them** (asks first, then
    says in plain words what the machine did and links to the new trial);
    **Notes** (newest first) + Add note.
  - On Behind the scenes a strip — "2 new inquiries — Stone Roofing, call Tue
    7:30 PM" (the soonest upcoming call, in Sri Lanka time) — opens the list;
    each new one is also an urgent to-do ("Open the inquiry"), in the bell, and in
    ⌘K. The Inquiries badge counts new ones.
  - Machine: `GET /api/mc/inquiries`, `POST /api/mc/inquiries`
    `{action:'status'|'note'|'toTrial', …}`, and `inquiries` on
    `GET /api/mc/hub` (see HUB-API.md "## Plan inquiries"). An older machine
    without it simply shows no strip and no badge.

- **Phone alerts** — a small panel (Settings → Phone alerts, or ⌘K)
  that turns on push notifications for this device. See below.

Top bar: Back (on pages inside a place), the page title, ⌘K on a computer
(find a trial, or type what you want to do), and the bell (what needs you:
urgent to-dos, urgent alerts, call times waiting for your yes).

## Phone alerts (Web Push)

Every machine alert can pop up on the owner's iPhone as a normal notification —
no Telegram, WhatsApp or SMS. It is standard Web Push. On iPhone and iPad it
only works for the hub **added to the Home Screen and opened from there**
(iOS 16.4 or later).

**On the iPhone, once:**

1. Open https://aviance.store in **Safari**.
2. Tap the **Share** button (the square with an arrow pointing up; on newer
   iPhones it is inside the ••• menu at the bottom), then **Add to Home Screen**
   → **Add**.
3. Open **Aviance** from the home screen and **sign in** (the home-screen app
   keeps its own sign-in, separate from Safari — the login screen says so).
4. **Settings** (bottom right) → **Phone alerts** → **Set up phone alerts** → **Turn on phone alerts** → **Allow**.
5. Tap **Send a test**. "Test alert from Aviance" should pop up within seconds.

Tapping an alert opens the trial it is about (`/#trial/{id}`), the inquiry
(`/#inquiry/{id}`), the Calendar (`/#calendar`), Settings › Alerts (`/#alerts`), Settings › Warm-up (`/#settings/warmup`), Settings › Keys (`/#settings/keys`), Settings › Your details (`/#settings/details`) or the list (`/#trials`) — signing in first if
needed. Urgent alerts stay on screen until tapped; a repeat of the same alert
replaces the previous one. If alerts are blocked later: iPhone Settings →
Notifications → Aviance → Allow Notifications.

How it fits together:

- `push.js` asks the machine for its public key (`GET /api/mc/push/key`, 503
  until the machine has VAPID keys), asks the phone for permission *inside the
  tap*, registers `/sw.js` (only then — just looking at the panel registers
  nothing), subscribes, and posts `{subscription, device}` to
  `/api/mc/push/subscribe`. "Send a test" → `/api/mc/push/test`; "Turn off" →
  `/api/mc/push/unsubscribe` and drops the subscription on the phone. After
  every sign-in it quietly re-posts an existing subscription (endpoints can
  rotate). All calls use the same Supabase bearer token as the rest of
  `/api/mc/*`.
- `sw.js` has no fetch handler and uses no cache, so the hub itself is never
  served stale; bump `SW_VERSION` when changing it. The push payload is
  `{title, body, url, tag, urgent, at}`; only hub paths are followed.
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
- **Overview** (inside a trial's Behind the scenes, only once it is opened) — 14 days, reused for 15 minutes.
- **Board cards** (Behind the scenes only — the Trials list asks for none) — 14 days per warming/sending client (never for clients
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
npm run check     # node --check trials.js, inquiries.js, calendar.js, messages.js, autobuy.js, warmup.js, push.js, sw.js
```

The tests load the shell's inline script, `trials.js`, `inquiries.js` and `push.js` into a tiny fake DOM
with a fake Supabase client, then exercise the router, the admin gate, the
chart data mapping (null = gap, 0 = a real zero), spam-test verdicts for
both tools, when growth is and isn't fetched, the simple Trials list (needs-you
order, the `simple` fallback, escaping, and that the old clutter is gone), the
trial page's journey line and onboarding-call card (every reply/button posts the
contract body; the check call), the Inquiries screens and
actions (incl. the empty state and an older machine without inquiries), and the
pure render functions with `tests/fixtures.mjs`; no network.

Charts are hand-drawn SVG in `trials.js` (no chart library, no build step):
`renderChart()` for the Growth tab, `renderSpark()` for the tiny ones.
Lines and bars are SVG stretched to the width; dots are small HTML circles
laid over the chart so they stay round and visible on a phone.
