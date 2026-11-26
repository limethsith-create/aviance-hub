# discovery-engine — RECOVERED FROM PRODUCTION

This function was **live in production but had no source in this repository.** It was
recovered from the Supabase deployment on 2026-11-27 (deployed version 2, last updated
2026-11-21) and committed here with no intentional changes.

**One caveat, stated plainly.** The source was read out of the deployment and written
back out here by hand, then syntax-checked (all four files parse). That is not the same
as a verified byte-for-byte copy. Before you treat these files as authoritative, or
before you ever redeploy from them, run a real diff against the deployment:

    supabase functions download discovery-engine
    diff -r supabase/functions/discovery-engine <downloaded copy>

Until that diff is clean, trust the deployment over this copy.

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

This commit only puts the source under version control. The deployed copy is unchanged
and still serving. Before ever redeploying it, diff it against the deployment first —
these files are the record of what is running today, not a new version.

## See also

`send-agreement` is in the same position: deployed, `verify_jwt: false`, and absent from
this repo. Nothing in the repo or in pg_cron appears to call it, so it may simply be
retired — but it is still publicly reachable and still unversioned.
