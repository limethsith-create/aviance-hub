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
| `index.html` | The shell: styles, login screen, app skeleton, sign-in/recovery, router, sidebar, ⌘K, notifications, theme. |
| `trials.js` | The Trials section — everything the owner sees inside. Talks to the machine. |
| `trials.css` | Styles for the Trials screens, on top of the shell's CSS variables (light + dark). |
| `tests/trials.test.mjs` | Node tests for the shell (router, admin gate, nav, ⌘K), the Trials screens, application review, and the readability floor. |
| `tests/fixtures.mjs` | Sample machine answers, shaped exactly like the contract — including a realistic growth history generator and a tiny growth payload full of nulls. |

## Screens

- **Trials** (the landing view) — machine bar (heartbeat, last send, active
  trials, usage, missing setup), "What you need to do" (every to-do from the
  machine, urgent first, with its action button), the stage columns with one
  card per trial, the queue (promote / decline) and the owner's own
  `aviance` / `_test` rows. "New client" creates a pre-approved trial.
  Refreshes itself every 60 s while open.
- **Trial** (one client) — header (state, day, dates, what's next), then
  tabs. It opens on **Overview**: what you need to do, the 13 systems as one
  strip (each says OK / Working / Waiting / Blocked / Off in words), and four
  growth numbers — emails sent, replies, calls booked, warm-up inbox rate —
  each with a 14-day sparkline. Everything else lives in tabs: **Growth**,
  Systems, **Leads**, **Deliverability**, Inboxes, Calls, Replies, Copy,
  Coming up (dates, your promises and notes, reports), Timeline, Actions
  (state moves, jobs, re-run a step, invoice, client links).
- **Growth tab** — the progress of every system over time, 7 / 30 / 45 / 90
  days: emails sent per day (first emails vs follow-ups) with replies,
  positive replies and calls booked in aligned rows underneath (each on its own
  scale — never two scales on one chart), warm-up emails per day (landed in
  the inbox vs spam, with the number sent) and the rolling 7-day inbox rate
  against the 90% "ready" and 80% "low" lines, one small chart per inbox (rate
  + today's cap), and every placement test (seed inbox rate against the 85%
  Day-1 line; mail-tester score out of 10). Hover or tap a day for the numbers
  in plain words; arrow keys work too; "Show the numbers" gives the same data
  as a table. A day with nothing recorded is a gap, never a 0.
- **Leads tab** — lead grades (A / B / C / rejected), how many are ready to
  send, email checks and today's check budget, top reject reasons, where
  leads come from, and the 25 best leads with why.
- **Deliverability tab** — bounce rate against the 1.5% pause and 2% stop
  lines, blacklists, the warm-up circle (pool, helpers, providers, today's
  pairs), placement tests with report links, and the domain's DNS checks.
- **Application review** — trial applications from the website arrive as
  clients in `applied`, held for the owner. On the board their card carries a
  "New application" marker; the "Review … application" to-do opens the trial
  scrolled to the **Application** section: who applied and when, the fit check
  (each rule pass / fail / unknown with a note), **what the machine found**
  about the company (summary, services, locations, Google rating with a Maps
  link, team size and age hints, socials, their market size, and warnings in
  amber) and every answer. While it is
  pending it sits at the top of the trial with two buttons — **Approve — send
  the onboarding link** (the machine starts onboarding, or queues them if three
  trials are running) and **Decline…** (a one-sentence reason, emailed to the
  applicant). Once decided it moves to an Application tab.
- **Buy & paste** — the one manual step per trial: the total for the first
  month, a comparison of the best domain names (why, the best first-year and
  renewal price with a link to that registrar, every other registrar's price
  marked *live* or *price list*) with a **Use this domain** button that fills
  the form, the inbox order (CheapInboxes: price, count, monthly cost and a
  step-by-step checklist with the sender names), then the form to paste the
  domain and inbox logins. Older machines without the comparison still show
  the plain shopping list.
- **Machine alerts** — every alert the machine sent, with Acknowledge.

Sidebar: the two screens above under **Trials**, and under **Machine** five
links that open signed-in inside the machine's own Mission Control (new tab):
Queue, Warm-up circle, Config, Test Mode, Learning. Topbar: ⌘K (trials and
commands), the bell (trial to-dos + open urgent alerts), theme, New client.

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
  table heads, timestamps, chart labels, sidebar nav. Body text is **15px**.
  Scale: `--fs-min` 13 · `--fs-small` 14 · `--fs-base` 15 · `--fs-strong` 16 ·
  `--fs-h3` 18 · `--fs-h2` 22 · `--fs-num` 18 (the five numbers, machine bar) ·
  `--fs-num-lg` 24. Use a token, never a raw size under 13px.
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
- **Phones (≤560px):** long button labels wrap rather than clip; the topbar
  "New client" button shows only its + icon.

`npm test` fails if any `font-size` in `trials.css`, the shell styles or
inline styles drops below 13px, if any other font family, capitals-only
label, letter-spacing or weight other than 400/600 appears, if any text pair
drops below 4.5:1, or if any chart mark drops below 3:1.

## How much the hub asks of the machine

The growth history is the expensive call (about days × (2 + inboxes) Redis
reads), so the hub only fetches it when you open something that shows it:

- **Growth tab** — the chosen range, reused for 5 minutes.
- **Overview** — 14 days, reused for 15 minutes.
- **Board cards** — 14 days per warming/sending client (never for clients
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
npm run check     # node --check trials.js
```

The tests load the shell's inline script and `trials.js` into a tiny fake DOM
with a fake Supabase client, then exercise the router, the admin gate, the
chart data mapping (null = gap), when growth is and isn't fetched, and the
pure render functions with `tests/fixtures.mjs`; no network.

Charts are hand-drawn SVG in `trials.js` (no chart library, no build step):
`renderChart()` for the Growth tab, `renderSpark()` for the tiny ones.
