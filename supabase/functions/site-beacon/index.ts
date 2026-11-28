/* site-beacon — who is on aviance.online, and a nudge to the owner's phone.
 *
 * The website calls this every few seconds while a tab is open. It keeps one
 * row per browser session and, twice per session at most, sends the owner a
 * message: once when somebody arrives, once when they start booking.
 *
 * Nothing identifying is stored. No IP address, no fingerprint — a session key
 * is a random string the browser invents and forgets when the tab closes.
 * Country and city come from the edge network's own headers, which are coarse
 * by design.
 *
 * The message goes wherever the secrets say. Set ALERT_PROVIDER to one of:
 *   callmebot  — WHATSAPP_PHONE (+countrycode, no spaces) and CALLMEBOT_KEY
 *   meta       — WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TO
 *   telegram   — TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 * With none set it records the visit and sends nothing, which is the right
 * behaviour before the keys exist rather than an error every few seconds.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ok = (b: unknown) =>
  new Response(JSON.stringify(b), { headers: { ...cors, 'content-type': 'application/json' } });

const env = (k: string) => Deno.env.get(k) || '';
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

/* Keep the stored strings short and boring: this table is read by a person. */
const trim = (s: unknown, n: number) => String(s ?? '').slice(0, n);

/* Send the owner a line. Never throws: a beacon must not fail because a
   messaging provider is having a day. */
async function tell(text: string): Promise<string> {
  const how = env('ALERT_PROVIDER').toLowerCase();
  try {
    if (how === 'callmebot') {
      const phone = env('WHATSAPP_PHONE'), key = env('CALLMEBOT_KEY');
      if (!phone || !key) return 'callmebot: not configured';
      const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}`
              + `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
      const r = await fetch(u);
      return 'callmebot: ' + r.status;
    }
    if (how === 'meta') {
      const token = env('WHATSAPP_TOKEN'), id = env('WHATSAPP_PHONE_ID'), to = env('WHATSAPP_TO');
      if (!token || !id || !to) return 'meta: not configured';
      const r = await fetch(`https://graph.facebook.com/v21.0/${id}/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
      });
      return 'meta: ' + r.status;
    }
    if (how === 'telegram') {
      const token = env('TELEGRAM_TOKEN'), chat = env('TELEGRAM_CHAT_ID');
      if (!token || !chat) return 'telegram: not configured';
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
      return 'telegram: ' + r.status;
    }
    return 'no provider set';
  } catch (e) {
    return 'send failed: ' + (e instanceof Error ? e.message : String(e));
  }
}

/* Where they came from, in words a person reads rather than a URL. */
function source(ref: string): string {
  if (!ref) return 'direct';
  try {
    const h = new URL(ref).hostname.replace(/^www\./, '');
    if (h.includes('aviance.online')) return '';
    if (h.includes('google.')) return 'Google';
    if (h.includes('bing.')) return 'Bing';
    if (h.includes('chatgpt.com') || h.includes('openai.')) return 'ChatGPT';
    if (h.includes('perplexity.')) return 'Perplexity';
    if (h.includes('claude.ai')) return 'Claude';
    if (h.includes('gemini.google') || h.includes('bard.')) return 'Gemini';
    if (h.includes('linkedin.')) return 'LinkedIn';
    if (h.includes('reddit.')) return 'Reddit';
    return h;
  } catch { return 'direct'; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return ok({ ok: false, error: 'POST only.' });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty beacon is not an error */ }

  const key = trim(body.k, 64);
  if (key.length < 8) return ok({ ok: false, error: 'No session key.' });

  const stage = ['browsing', 'booking', 'booked'].includes(String(body.stage))
    ? String(body.stage) : 'browsing';
  const path = trim(body.path, 120);
  const ref  = trim(body.ref, 300);
  const mine = body.me === true;

  const h = req.headers;
  const country = trim(h.get('x-vercel-ip-country') || h.get('cf-ipcountry') || '', 4);
  const city    = trim(h.get('x-vercel-ip-city') || '', 60);
  const device  = /mobile|android|iphone|ipad/i.test(h.get('user-agent') || '') ? 'phone' : 'desktop';

  const { data: had } = await sb.from('site_visits')
    .select('id, stage, alerted_at, booking_alerted_at, page_views, is_owner, first_path')
    .eq('session_key', key).maybeSingle();

  const now = new Date().toISOString();
  let row = had;

  if (!had) {
    const ins = await sb.from('site_visits').insert({
      session_key: key, first_path: path, path, referrer: ref,
      country, city, device, stage, is_owner: mine,
      started_at: now, last_seen_at: now,
    }).select('id, stage, alerted_at, booking_alerted_at, is_owner').maybeSingle();
    row = ins.data;
  } else {
    const up = await sb.from('site_visits').update({
      path, stage, last_seen_at: now,
      page_views: (had.page_views || 1) + (path && path !== had.first_path ? 1 : 0),
      is_owner: had.is_owner || mine,
    }).eq('session_key', key)
      .select('id, stage, alerted_at, booking_alerted_at, is_owner').maybeSingle();
    row = up.data;
  }

  if (!row || row.is_owner) return ok({ ok: true, owner: true });

  /* Two messages per session, at most. Somebody reading three pages is one
     arrival, not three, and a phone that buzzes on every page view is a phone
     that gets silenced. */
  const where = [city, country].filter(Boolean).join(', ');
  const from = source(ref);
  let sent: string | null = null;

  if (!row.alerted_at) {
    sent = await tell(
      'Somebody is on aviance.online'
      + (where ? ' from ' + where : '')
      + (from ? ' (via ' + from + ')' : '')
      + (path ? '\nPage: ' + path : '')
      + '\nSee them: https://aviance.store/#live');
    await sb.from('site_visits').update({ alerted_at: now }).eq('session_key', key);
  }

  if (stage === 'booking' && !row.booking_alerted_at) {
    sent = await tell(
      'Someone has started booking a call'
      + (where ? ' — ' + where : '') + '.'
      + '\nhttps://aviance.store/#live');
    await sb.from('site_visits').update({ booking_alerted_at: now }).eq('session_key', key);
  }

  return ok({ ok: true, sent });
});
