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
| `tests/fixtures.mjs` | Sample machine answers, shaped exactly like the contract. |

## Screens

- **Trials** (the landing view) — machine bar (heartbeat, last send, active
  trials, usage, missing setup), "What you need to do" (every to-do from the
  machine, urgent first, with its action button), the stage columns with one
  card per trial, the queue (promote / decline) and the owner's own
  `aviance` / `_test` rows. "New client" creates a pre-approved trial.
  Refreshes itself every 60 s while open.
- **Trial** (one client) — header, that client's to-dos, the thirteen system
  cards, then tabs: Numbers, Inboxes, Calls, Replies, Copy, Setup, Reports,
  Promises, Timeline, Upcoming, Actions, plus copyable client links.
- **Application review** — trial applications from the website arrive as
  clients in `applied`, held for the owner. On the board their card carries a
  "New application" marker; the "Review … application" to-do opens the trial
  scrolled to the **Application** section: who applied and when, the fit check
  (each rule pass / fail / unknown with a note) and every answer. While it is
  pending it sits at the top of the trial with two buttons — **Approve — send
  the onboarding link** (the machine starts onboarding, or queues them if three
  trials are running) and **Decline…** (a one-sentence reason, emailed to the
  applicant). Once decided it moves to an Application tab.
- **Buy & paste** — the one manual step per trial: the shopping list the
  machine produced and the form to paste the domain and inbox logins.
- **Machine alerts** — every alert the machine sent, with Acknowledge.

Sidebar: the two screens above under **Trials**, and under **Machine** five
links that open signed-in inside the machine's own Mission Control (new tab):
Queue, Warm-up circle, Config, Test Mode, Learning. Topbar: ⌘K (trials and
commands), the bell (trial to-dos + open urgent alerts), theme, New client.

## Readability floor (keep this in any redesign)

The owner reads this hub a lot; text must be easy to see. Every size and
colour comes from tokens in `index.html` (`:root`, and `body.dark` for dark
mode), and the tests enforce the floor.

- **Size:** nothing smaller than **13px** anywhere — labels, pills, badges,
  table heads, timestamps, mono lines, sidebar nav. Body text is **15px**.
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
- **Spacing:** line-height ≈1.5 for reading text; to-do rows, cards and
  table cells have room to breathe.
- **Phones (≤560px):** long button labels wrap rather than clip; the topbar
  "New client" button shows only its + icon.

`npm test` fails if any `font-size` in `trials.css`, the shell styles or
inline styles drops below 13px, or if any tested colour pair drops below
4.5:1.

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
with a fake Supabase client, then exercise the router, the admin gate and the
pure render functions with `tests/fixtures.mjs`; no network.
