# Recorded response shapes

Hand-built from the providers' own published reference, not from a live key, so the mapping in
../map.mjs can be proven by `node --test tests/outreach.test.mjs` before any key exists. Every
field name here is one the provider documents. No real addresses, bodies, ids or keys.

* `instantly-campaigns.json`        GET https://api.instantly.ai/api/v2/campaigns
* `instantly-analytics.json`        GET /api/v2/campaigns/analytics
* `instantly-analytics-daily.json`  GET /api/v2/campaigns/analytics/daily
* `instantly-accounts.json`         GET /api/v2/accounts
* `instantly-emails.json`           GET /api/v2/emails
* `smartlead-campaigns.json`        GET https://server.smartlead.ai/api/v1/campaigns/
* `smartlead-analytics.json`        GET /api/v1/campaigns/{id}/analytics-by-date
* `smartlead-daywise.json`          GET /api/v1/analytics/day-wise-overall-stats
* `smartlead-email-accounts.json`   GET /api/v1/email-accounts/
* `smartlead-categories.json`       GET /api/v1/leads/fetch-categories
* `smartlead-leads.json`            GET /api/v1/campaigns/{id}/leads
* `smartlead-history.json`          GET /api/v1/campaigns/{id}/leads/{lead}/message-history
* `smartlead-history-alt.json`      the same call, the other shape the docs show (`messages[]`)

A Smartlead email account really does come back with a decrypted `password`. It is left out of
these fixtures on purpose and the sync never reads or stores it.
