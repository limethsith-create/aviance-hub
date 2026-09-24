# Aviance Hub

The owner's command centre for Aviance, live at https://aviance.store. One
static page (`index.html`), plain browser JavaScript, no build step. People
sign in through Supabase; the hub keeps its own data (projects, team, CRM,
calendar, proposals, invoices) in two Supabase JSON tables. Two roles:
`admin` (the founder) and `employee`.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole hub: styles, markup and the app script. |
| `trials.js` | The **Trials** section (admin only) — talks to the trial machine. |
| `trials.css` | Styles for the Trials section, built on the hub's CSS variables (light + dark). |
| `tests/trials.test.mjs` | Node tests for the Trials render functions and the machine client. |
| `tests/fixtures.mjs` | Sample machine answers, shaped exactly like the contract. |

## Trials

The Aviance Trial Machine (`limethsith-create/email-distributor`, deployed at
https://email-distributor.vercel.app) runs every 30-day trial by itself. The
hub's Trials section shows what the machine is doing and lets the owner steer
it. It is built against `email-distributor/docs/HUB-API.md`; the machine does
the work, the hub only shows and steers.

Screens (all admin only — employees never see them):

- **Trials** (board) — machine bar (heartbeat, last send, active trials, usage,
  missing setup), "What you need to do" (every to-do from the machine, urgent
  first, with its action button), the stage columns with one card per trial,
  the queue (promote / decline) and the owner's own `aviance` / `_test` rows.
  "New client" creates a pre-approved trial. Refreshes itself every 60 s while
  open.
- **Trial** (one client) — header, that client's to-dos, the thirteen system
  cards, then tabs: Numbers, Inboxes, Calls, Replies, Copy, Setup, Reports,
  Promises, Timeline, Upcoming, Actions, plus copyable client links.
- **Buy & paste** — the one manual step per trial: the shopping list the
  machine produced and the form to paste the domain and inbox logins.
- **Machine alerts** — every alert the machine sent, with Acknowledge.

Integration points: a "Trials" card on the dashboard health strip, urgent
to-dos and urgent alerts in the notification bell, trials and three actions in
the ⌘K palette, a "Start a trial" button on CRM leads (prefills the New client
form and leaves the lead's stage alone), and a "Trial: …" line under a client
in Clients when its name matches a trial.

### `MACHINE_URL`

`index.html` defines `MACHINE_URL` (default `https://email-distributor.vercel.app`).
To point the hub at another machine while testing, set
`localStorage.avianceMachineUrl` in the browser console and reload:

```js
localStorage.setItem('avianceMachineUrl', 'http://localhost:3000')
```

### How the hub signs in to the machine

Every `/api/mc/*` call carries the signed-in user's Supabase access token as
`Authorization: Bearer <token>` (`machineFetch()` in `trials.js`). The
machine verifies the token against the Supabase project's public keys and
checks the email is on its admin list. No machine secret lives in the hub.

To open a Mission Control page inside the machine (config, warm-up circle,
copy editor, test mode) the hub POSTs a hidden form with `hubToken` and `next`
to `POST /api/mc/login` in a new tab (`openMachine()`); the machine sets its
own session cookie and redirects.

If the machine cannot be reached, every trials screen shows one card with the
reason and a "Try again" button; after a failed refresh the last good data
stays on screen with a red note saying so.

## Running locally

Any static file server works (`npx serve .`, `python3 -m http.server`).
Sign-in needs the real Supabase project.

## Tests

```
npm test          # node --test tests/*.test.mjs
npm run check     # node --check trials.js
```

The tests load `trials.js` into a tiny fake DOM and call its pure render
functions with `tests/fixtures.mjs`; no network.
