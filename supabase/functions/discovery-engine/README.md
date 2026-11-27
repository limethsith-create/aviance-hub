# discovery-engine — RECOVERED FROM PRODUCTION, COPY VERIFIED 2026-11-27

This function was **live in production but had no source in this repository.** It was
recovered from the Supabase deployment on 2026-11-27 (deployed version 2, last updated
2026-11-21) and committed here with no intentional changes.

**Verified on 2026-11-27 (round 3): all four files match the deployment byte for byte.**
Nothing had to be corrected.

| file        | bytes  | sha256 of both copies |
|-------------|-------:|-----------------------|
| index.ts    |  2,433 | `4fcaa45f554f2ab5e48a02cd31ef35ff257f8d47693e8f0efb547a650d65c067` |
| pipeline.js |  3,760 | `47dee8c0261aacaa0171103920ff88a4874db63d4712269c19bb3000dca88b16` |
| deliver.js  |  7,982 | `973713c75708b59b076fa94f8a00968b2e941316a61c2f68628f706275596757` |
| research.js | 29,052 | `c9c862c09c492f2a0e2ea332607a2042798fda7ba980c418ff007b2afece4141` |

How it was checked, so you know exactly how far to trust it. The deployed source was
fetched again from Supabase (version 2, still the live one). Each file was saved in the
escaped form Supabase returns it in, decoded by a program, and compared with `cmp`
against the file here. That is a second, independent reading of the deployment, and it
agrees with the first one on every byte. What it is not: a file downloaded straight to
disk by the Supabase CLI, because the CLI is not signed in on the machine that did this.
If you ever want that last inch, it is two commands:

    supabase functions download discovery-engine
    diff -r supabase/functions/discovery-engine <downloaded copy>

Re-verify before any redeploy if the deployed version is no longer 2.

## Why that mattered

It is load-bearing and it is not small:

- **On every booking** (called by a database trigger on `discovery_bookings`) it runs
  eight research agents in parallel, creates the Google Calendar event and the Google
  Meet link, saves the brief to `research_briefs`, emails the brief to the closer,
  emails the prospect their intro, and posts to Slack.
- **Every hour** (pg_cron job 2, `aviance-day-before`, `5 * * * *`) it picks up calls
  starting in 20-28 hours, re-runs four of the agents, and emails the closer what
  changed since the first brief. It owns `discovery_bookings.day_before_sent_at`.

Because the source was only inside Supabase: nobody could read or review it, no test
could cover it, and the next `supabase functions deploy` from this repo would not have
touched it. If it had been deleted or overwritten, it was gone.

## What it needs to actually run

`dayBefore()` returns 0 immediately unless BOTH `GOOGLE_REFRESH_TOKEN` and
`CLOSER_EMAIL` are set. Check whether they are before assuming the hourly job does
anything. The optional keys are `SERPER_API_KEY`, `GOOGLE_PLACES_API_KEY`,
`GROQ_API_KEY`; each agent degrades on its own if its key is missing, and the brief
falls back from Groq to a rules writer.

It authenticates callers with a shared secret from the `aviance_webhook_secret()` RPC,
checked against the `x-aviance-secret` header, and is deployed with `verify_jwt: false`.

## Not deployed from here yet

This folder only puts the source under version control. The deployed copy is unchanged
and still serving. Nothing was deployed in round 3 either. These files are the record of
what is running today, not a new version.

## See also

`send-agreement` is deployed (version 4, `verify_jwt: false`) and is not in this repo.
Checked on 2026-11-27: nothing in this repository calls it, no database function or
trigger mentions it, and none of the three scheduled jobs calls it (`aviance-day-before`
`5 * * * *`, `aviance-mail-tick` `* * * * *`, `aviance-journey-hourly` `17 * * * *`).
The `agreements` table it would write to has no rows. The one thing that cannot be seen
from here is the marketing site, which is a separate codebase. If the site does not call
it either, it is retired and should be deleted, because it is still publicly reachable.
