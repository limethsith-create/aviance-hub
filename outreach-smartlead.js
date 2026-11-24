/* ================= AVIANCE OS — Outreach: Smartlead (not connected) =================
   An empty adapter. Every method is here, every method says the same plain
   thing: Smartlead is not connected yet. Nothing in this file touches the
   network, and there is no key in it — there never will be. A key lives
   outside the browser; outreach_accounts.key_ref holds only its NAME.

   To finish this adapter, fill in the five methods below against the endpoints
   named in the TODOs, map each answer onto the shapes documented at the top of
   outreach-adapter.js, and keep returning {ok,data,error} without throwing.
   ==================================================================================== */

const OA_SMARTLEAD_OFF = 'Smartlead is not connected yet.';
const oaSmartleadOff = () => ({ok:false, data:null, error: OA_SMARTLEAD_OFF});

const oaSmartleadImpl = {
  /* TODO: GET /api/v1/campaigns  -> [{id, name, status, created_at, ...}]
     plus GET /api/v1/campaigns/{campaign_id}/analytics for the lifetime
     counters (sent_count, open_count, reply_count, bounce_count,
     unsubscribed_count). Map id -> externalId, status
     (ACTIVE|PAUSED|COMPLETED|DRAFTED) -> running|paused|finished|draft. */
  async getCampaigns(clientId){ return oaSmartleadOff() },

  /* TODO: GET /api/v1/campaigns/{campaign_id}/statistics?start_date=&end_date=
     -> one row per day per campaign {date, sent_count, open_count,
     reply_count, bounce_count, unsubscribed_count}. Smartlead has no
     "positive" or "booked" of its own: derive positive from the lead
     category (see getReplies) and booked from our own meetings table. */
  async getStats(clientId, range){ return oaSmartleadOff() },

  /* TODO: GET /api/v1/campaigns/{campaign_id}/leads?limit=&offset= for the
     lead and GET /api/v1/campaigns/{campaign_id}/leads/{lead_id}/message-history
     for the thread. Smartlead's lead_category_id is the sentiment
     (1 Interested, 2 Meeting Request, 3 Not Interested, 4 Do Not Contact,
     5 Information Request, 6 Out Of Office, 7 Wrong Person) -> map onto
     positive|neutral|negative|out_of_office|unsubscribe. */
  async getReplies(clientId, opts){ return oaSmartleadOff() },

  /* TODO: POST /api/v1/campaigns/{campaign_id}/reply-email-thread with
     {email_stats_id, email_body, reply_message_id, reply_email_time,
     reply_email_body, cc, bcc}. It needs the id of the message being
     replied to, so store Smartlead's stats id on outreach_messages.external_id
     when the thread is synced. */
  async sendReply(threadId, msg){ return oaSmartleadOff() },

  /* TODO: GET /api/v1/email-account/ -> [{id, from_email, warmup_details:
     {warmup_reputation, status}, message_per_day, daily_sent_count,
     is_smtp_success, is_imap_success}]. warmup_reputation (a percentage) is
     the health 0-100; a failing SMTP or IMAP check means status 'blocked'. */
  async getInboxHealth(clientId){ return oaSmartleadOff() }
};

if (typeof oaRegister === 'function') oaRegister('smartlead', oaSmartleadImpl);
