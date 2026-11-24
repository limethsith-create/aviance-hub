/* ================= AVIANCE OS — Outreach: Instantly (not connected) =================
   An empty adapter. Every method is here, every method says the same plain
   thing: Instantly is not connected yet. Nothing in this file touches the
   network, and there is no key in it — there never will be. A key lives
   outside the browser; outreach_accounts.key_ref holds only its NAME.

   To finish this adapter, fill in the five methods below against the endpoints
   named in the TODOs, map each answer onto the shapes documented at the top of
   outreach-adapter.js, and keep returning {ok,data,error} without throwing.
   ==================================================================================== */

const OA_INSTANTLY_OFF = 'Instantly is not connected yet.';
const oaInstantlyOff = () => ({ok:false, data:null, error: OA_INSTANTLY_OFF});

const oaInstantlyImpl = {
  /* TODO: GET /api/v2/campaigns?limit=&starting_after= -> {items:[{id, name,
     status, timestamp_created, campaign_schedule}]}, with
     GET /api/v2/campaigns/analytics?id= for the counters (leads_count,
     contacted_count, emails_sent_count, open_count, reply_count,
     bounced_count, unsubscribed_count, total_opportunities). Instantly's
     numeric status (0 draft, 1 active, 2 paused, 3 completed) -> our
     draft|running|paused|finished. */
  async getCampaigns(clientId){ return oaInstantlyOff() },

  /* TODO: GET /api/v2/campaigns/analytics/daily?campaign_id=&start_date=&end_date=
     -> [{date, sent, opened, unique_opened, replies, unique_replies,
     clicks}]. Bounces are not in the daily feed: take them from
     GET /api/v2/campaigns/analytics/overview for the same window, or count
     'bounced' events from the webhook feed. */
  async getStats(clientId, range){ return oaInstantlyOff() },

  /* TODO: POST /api/v2/emails?campaign_id=&email_type=received for the
     replies, then GET /api/v2/emails/{id} for the body, and
     GET /api/v2/leads/{id} for the lead's name, company and title. The
     lead's interest status (1 Interested, 2 Meeting Booked, 3 Meeting
     Completed, 4 Closed, 0/-1 Out of Office, -2 Wrong Person,
     -3 Not Interested) is the sentiment and the thread status. */
  async getReplies(clientId, opts){ return oaInstantlyOff() },

  /* TODO: POST /api/v2/emails/reply with {reply_to_uuid, subject, body:
     {html, text}, eaccount, cc_address_email_list}. reply_to_uuid is the id
     of the received email, so store it on outreach_messages.external_id when
     the thread is synced; eaccount must be one of the client's own inboxes. */
  async sendReply(threadId, msg){ return oaInstantlyOff() },

  /* TODO: GET /api/v2/accounts?limit= -> {items:[{email, status,
     warmup_status, warmup_score, daily_limit, stat_warmup_score,
     timestamp_last_used}]}. warmup_score is the health 0-100; status 2 is
     paused and status -1/-2/-3 means the inbox has a problem -> 'blocked'.
     Instantly does not report sent-today per inbox: keep our own count from
     outreach_messages. */
  async getInboxHealth(clientId){ return oaInstantlyOff() }
};

if (typeof oaRegister === 'function') oaRegister('instantly', oaInstantlyImpl);
