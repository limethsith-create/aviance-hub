// Aviance — prospect research engine
// Runs the moment someone books a discovery call. No Claude at runtime.
// Several "agents" run in parallel, each with its own timeout; one failing never stops the rest.
// Works in Deno (Supabase Edge Functions) and Node 20+ (for local tests).
//
// Keys (all optional — the engine does what it can with what it has):
//   SERPER_API_KEY         Google search, news, social, hiring results   (serper.dev)
//   GOOGLE_PLACES_API_KEY  Google Maps rating, reviews, competitors      (Places API (New))
//   GROQ_API_KEY           writes the brief (Llama 3.3 70B)             (console.groq.com)

const env = (k, d = '') => (globalThis.Deno ? Deno.env.get(k) : process.env[k]) ?? d;
const BASES = () => ({
  serper: env('SERPER_BASE', 'https://google.serper.dev'),
  places: env('PLACES_BASE', 'https://places.googleapis.com'),
  groq: env('GROQ_BASE', 'https://api.groq.com'),
});
const UA = 'Mozilla/5.0 (compatible; AvianceResearch/1.0; +https://aviance.store)';

/* ---------------- small helpers ---------------- */
const withTimeout = (p, ms, name) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`${name} timed out after ${ms / 1000}s`)), ms))]);
const clean = (s, n = 400) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const uniq = (a) => [...new Set(a.filter(Boolean))];
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const normUrl = (u) => (!u ? '' : /^https?:\/\//i.test(u) ? u : 'https://' + u);

async function getText(url, ms = 12000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return (await r.text()).slice(0, 600_000);
}
async function serper(path, body) {
  const key = env('SERPER_API_KEY');
  if (!key) throw new Error('no SERPER_API_KEY');
  const r = await fetch(BASES().serper + path, { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`serper ${path} → ${r.status}`);
  return r.json();
}
async function places(textQuery, fields, max = 5) {
  const key = env('GOOGLE_PLACES_API_KEY');
  if (!key) throw new Error('no GOOGLE_PLACES_API_KEY');
  const r = await fetch(BASES().places + '/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields.map((f) => 'places.' + f).join(',') },
    body: JSON.stringify({ textQuery, pageSize: max }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`places → ${r.status}`);
  return (await r.json()).places || [];
}

/* ---------------- HTML extraction ---------------- */
function htmlToText(html) {
  return clean(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"'), 6000);
}
const TECH = [
  ['WordPress', /wp-content|wp-includes/i], ['Shopify', /cdn\.shopify|myshopify/i], ['Wix', /wixstatic|wix\.com/i], ['Squarespace', /squarespace/i], ['Webflow', /webflow/i],
  ['HubSpot', /js\.hs-scripts|hubspot/i], ['Google Analytics', /gtag\(|googletagmanager|google-analytics/i], ['Meta Pixel (runs Facebook/Instagram ads)', /fbq\(|connect\.facebook\.net/i],
  ['LinkedIn Insight (runs LinkedIn ads)', /snap\.licdn|_linkedin_partner/i], ['Google Ads', /googleadservices|AW-\d{6,}/i], ['Calendly', /calendly/i], ['Intercom', /intercom/i],
  ['Live chat widget', /tawk\.to|drift\.com|crisp\.chat|livechatinc|tidio/i], ['Mailchimp', /mailchimp|list-manage/i], ['Klaviyo', /klaviyo/i], ['Stripe', /js\.stripe/i],
];
function extractPage(html, url) {
  const title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1], 160);
  const desc = clean((html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i) || html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)/i) || [])[1], 300);
  const heads = uniq([...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => clean(m[1].replace(/<[^>]+>/g, ' '), 120))).slice(0, 12);
  const links = [...html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => { try { return new URL(m[1], url).href; } catch { return ''; } });
  const emails = uniq([...html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0].toLowerCase()).filter((e) => !/\.(png|jpg|svg|webp)$|example\.|sentry|wixpress/.test(e))).slice(0, 6);
  const phones = uniq([...htmlToText(html).matchAll(/(\+?\d[\d\s().-]{8,}\d)/g)].map((m) => m[1].trim()).filter((p) => p.replace(/\D/g, '').length >= 9 && p.replace(/\D/g, '').length <= 15)).slice(0, 4);
  const socials = uniq(links.filter((l) => /linkedin\.com\/company|facebook\.com\/(?!sharer)|instagram\.com\/|twitter\.com\/|x\.com\/|youtube\.com\/|tiktok\.com\/@/i.test(l))).slice(0, 8);
  const tech = TECH.filter(([, re]) => re.test(html)).map(([n]) => n);
  const year = Math.max(0, ...[...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d\d)/gi)].map((m) => +m[1]));
  return { url, title, desc, heads, text: htmlToText(html), links, emails, phones, socials, tech, copyrightYear: year || null };
}

/* ---------------- the agents ---------------- */
// Each agent: async (ctx) => ({ summary, data, sources })
const AGENTS = {
  async website(ctx) {
    if (!ctx.website) throw new Error('no website given');
    const home = extractPage(await getText(ctx.website), ctx.website);
    const host = hostOf(ctx.website);
    const wanted = /about|team|who-we|service|solution|pricing|price|plans|contact|career|jobs|testimonial|review|case-stud|results|locations/i;
    const sub = uniq(home.links.filter((l) => hostOf(l) === host && wanted.test(new URL(l).pathname))).slice(0, 7);
    const pages = (await Promise.allSettled(sub.map(async (u) => extractPage(await getText(u, 9000), u)))).filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const all = [home, ...pages];
    const has = (re) => all.some((p) => re.test(p.url));
    return {
      summary: `${all.length} pages read · ${uniq(all.flatMap((p) => p.tech)).length} tools detected`,
      data: {
        title: home.title, description: home.desc, headings: home.heads,
        pages: all.map((p) => ({ url: p.url, title: p.title, excerpt: clean(p.text, 900) })),
        emails: uniq(all.flatMap((p) => p.emails)), phones: uniq(all.flatMap((p) => p.phones)), socials: uniq(all.flatMap((p) => p.socials)),
        tech: uniq(all.flatMap((p) => p.tech)), copyrightYear: home.copyrightYear,
        hasPricingPage: has(/pric|plans/i), hasCareersPage: has(/career|jobs/i), hasCaseStudies: has(/case-stud|results|testimonial/i),
      },
      sources: all.map((p) => p.url),
    };
  },

  async google(ctx) {
    const j = await serper('/search', { q: `"${ctx.company}" ${ctx.city || ''}`.trim(), num: 10, gl: ctx.country || 'us' });
    const org = (j.organic || []).slice(0, 8).map((o) => ({ title: o.title, link: o.link, snippet: o.snippet }));
    return { summary: `${org.length} results${j.knowledgeGraph ? ' + Google business panel' : ''}`, data: { organic: org, knowledgeGraph: j.knowledgeGraph || null, peopleAlsoAsk: (j.peopleAlsoAsk || []).slice(0, 4).map((p) => p.question) }, sources: org.map((o) => o.link) };
  },

  async reviews(ctx) {
    const fields = ['id', 'displayName', 'formattedAddress', 'rating', 'userRatingCount', 'websiteUri', 'nationalPhoneNumber', 'businessStatus', 'primaryTypeDisplayName', 'googleMapsUri', 'reviews'];
    const list = await places(`${ctx.company} ${ctx.city || ''}`.trim(), fields, 3);
    const host = hostOf(ctx.website);
    const p = list.find((x) => host && hostOf(x.websiteUri) === host) || list[0];
    if (!p) throw new Error('not found on Google Maps');
    const reviews = (p.reviews || []).map((r) => ({ rating: r.rating, when: r.relativePublishTimeDescription, text: clean(r.text?.text || r.originalText?.text, 500) }));
    return {
      summary: p.rating ? `${p.rating}★ from ${p.userRatingCount} Google reviews` : 'On Google Maps, no rating yet',
      data: { name: p.displayName?.text, address: p.formattedAddress, rating: p.rating ?? null, count: p.userRatingCount ?? 0, phone: p.nationalPhoneNumber, status: p.businessStatus, category: p.primaryTypeDisplayName?.text, mapsUrl: p.googleMapsUri, reviews },
      sources: [p.googleMapsUri].filter(Boolean),
    };
  },

  async news(ctx) {
    const j = await serper('/news', { q: `"${ctx.company}"`, num: 8, tbs: 'qdr:y' });
    const n = (j.news || []).slice(0, 6).map((x) => ({ title: x.title, source: x.source, date: x.date, link: x.link, snippet: x.snippet }));
    return { summary: n.length ? `${n.length} article${n.length === 1 ? '' : 's'} in the last year` : 'No news in the last year', data: { articles: n }, sources: n.map((x) => x.link) };
  },

  async socials(ctx) {
    const j = await serper('/search', { q: `"${ctx.company}" (site:linkedin.com/company OR site:facebook.com OR site:instagram.com OR site:youtube.com)`, num: 10 });
    const r = (j.organic || []).map((o) => ({ network: hostOf(o.link).split('.').slice(-2, -1)[0], link: o.link, snippet: o.snippet }));
    const li = r.find((x) => x.network === 'linkedin');
    const emp = li && (li.snippet.match(/([\d,]+(?:\s*-\s*[\d,]+)?)\s+employees/i) || [])[1];
    const fol = li && (li.snippet.match(/([\d,.]+K?)\s+followers/i) || [])[1];
    return { summary: `${r.length} profiles${emp ? ` · LinkedIn says ${emp} employees` : ''}`, data: { profiles: r.slice(0, 8), linkedinEmployees: emp || null, linkedinFollowers: fol || null }, sources: r.map((x) => x.link) };
  },

  async hiring(ctx) {
    const j = await serper('/search', { q: `"${ctx.company}" (hiring OR careers OR "job opening") ${ctx.city || ''}`.trim(), num: 10, tbs: 'qdr:m6' });
    const r = (j.organic || []).filter((o) => /job|career|hiring|indeed|linkedin\.com\/jobs|glassdoor|ziprecruiter/i.test(o.link + o.title)).slice(0, 6).map((o) => ({ title: o.title, link: o.link, snippet: o.snippet }));
    const sales = r.filter((x) => /sales|business development|sdr|bdr|account exec|marketing/i.test(x.title + x.snippet)).length;
    return { summary: r.length ? `${r.length} open roles found${sales ? `, ${sales} in sales/marketing` : ''}` : 'No recent job posts found', data: { roles: r, salesOrMarketingRoles: sales }, sources: r.map((x) => x.link) };
  },

  async competitors(ctx) {
    if (!ctx.industry || !ctx.city) throw new Error('needs industry + city');
    const list = await places(`${ctx.industry} in ${ctx.city}`, ['displayName', 'rating', 'userRatingCount', 'websiteUri', 'formattedAddress'], 10);
    const host = hostOf(ctx.website);
    const others = list.filter((p) => !(host && hostOf(p.websiteUri) === host) && (p.displayName?.text || '').toLowerCase() !== ctx.company.toLowerCase())
      .map((p) => ({ name: p.displayName?.text, rating: p.rating ?? null, reviews: p.userRatingCount ?? 0, website: p.websiteUri || null })).slice(0, 8);
    return { summary: `${others.length} nearby competitors`, data: { competitors: others }, sources: others.map((x) => x.website).filter(Boolean) };
  },

  async contact(ctx) {
    if (!ctx.name) throw new Error('no contact name');
    const j = await serper('/search', { q: `"${ctx.name}" "${ctx.company}"`, num: 6 });
    const r = (j.organic || []).slice(0, 5).map((o) => ({ title: o.title, link: o.link, snippet: o.snippet }));
    return { summary: r.length ? `${r.length} public mentions of ${ctx.name}` : `No public profile found for ${ctx.name}`, data: { mentions: r }, sources: r.map((x) => x.link) };
  },
};
export const AGENT_LABELS = { website: 'Website reader', google: 'Google search', reviews: 'Google reviews', news: 'News', socials: 'Social profiles', hiring: 'Hiring signals', competitors: 'Local competitors', contact: 'The person who booked' };

/* ---------------- orchestrator ---------------- */
// booking: { name, email, company, website, role, city, country, industry, budget, decision_maker, goal, timeline, current_lead_gen, call_at, source }
export async function runResearch(booking, { only, onEvent = () => {}, perAgentMs = 25000 } = {}) {
  const ctx = { ...booking, website: normUrl(booking.website), company: clean(booking.company, 120) };
  const names = only || Object.keys(AGENTS);
  const t0 = Date.now();
  onEvent({ type: 'start', agents: names });
  const results = await Promise.all(names.map(async (name) => {
    const s = Date.now();
    onEvent({ type: 'agent_start', agent: name });
    try {
      const r = await withTimeout(AGENTS[name](ctx), perAgentMs, name);
      const out = { agent: name, ok: true, ms: Date.now() - s, ...r };
      onEvent({ type: 'agent_done', agent: name, ok: true, ms: out.ms, summary: r.summary });
      return out;
    } catch (e) {
      const out = { agent: name, ok: false, ms: Date.now() - s, error: String(e.message || e) };
      onEvent({ type: 'agent_done', agent: name, ok: false, ms: out.ms, summary: out.error });
      return out;
    }
  }));
  const raw = Object.fromEntries(results.map((r) => [r.agent, r]));
  onEvent({ type: 'writing' });
  let brief, writer = 'groq';
  try { brief = await writeWithGroq(ctx, raw); }
  catch (e) { writer = 'rules'; brief = writeWithRules(ctx, raw); brief._writer_note = `Groq unavailable (${e.message}); brief built from rules.`; }
  brief = mergeFacts(brief, ctx, raw);
  const doc = { booking: ctx, brief, raw, writer, ms: Date.now() - t0, created_at: new Date().toISOString(), agents: results.map(({ agent, ok, ms, summary, error }) => ({ agent, label: AGENT_LABELS[agent], ok, ms, summary: summary || error })) };
  onEvent({ type: 'done', ms: doc.ms });
  return doc;
}

/* ---------------- brief writers ---------------- */
const SCHEMA = `{
 "one_liner": "what the business is, in one sentence",
 "what_they_sell": "", "who_they_sell_to": "", "size_estimate": "e.g. 20-50 staff, 3 locations (say how you know)",
 "signals": [{"label":"short","detail":"one sentence","source":"which agent"}],
 "reputation": {"praise":["..."],"complaints":["..."]},
 "current_marketing": ["what they do today to get customers, from evidence"],
 "pain_hypotheses": [{"pain":"","evidence":""}],
 "bant": {"budget":"","authority":"","need":"","timing":"","score":0,"verdict":"hot|warm|cold — one reason"},
 "closer_plan": {
   "clarify": ["2-3 opening questions specific to them"],
   "label": "their likely problem in one sentence",
   "past_pain": ["2-3 questions about what they tried"],
   "sell_the_vacation": "the outcome to paint, specific to them",
   "objections": [{"objection":"","acknowledge_associate_ask":""}],
   "reinforce": "one line to reinforce the decision"
 },
 "cost_of_inaction": "one sentence with a rough number if evidence allows",
 "recommended_plan": "Starter | Growth | Scale and why",
 "campaign_idea": "who we'd email for them and the angle",
 "red_flags": ["..."],
 "edify_line": "two sentences the closer can be introduced with"
}`;
async function writeWithGroq(ctx, raw) {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('no GROQ_API_KEY');
  const facts = JSON.stringify(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.ok ? v.data : { failed: v.error }]))).slice(0, 24000);
  const sys = `You are a sales researcher for Aviance, a cold email agency that sells booked sales calls with a guarantee. Write a pre-call brief for the closer using ONLY the facts given. Never invent numbers, names or reviews; when unsure say "unknown". Be specific and short. Use the C.L.O.S.E.R. call structure (Clarify, Label, Overview past pain, Sell the vacation, Explain away concerns with Acknowledge-Associate-Ask, Reinforce) and BANT. Reply with JSON only, matching this shape:\n${SCHEMA}`;
  const user = `BOOKING FORM ANSWERS:\n${JSON.stringify({ name: ctx.name, role: ctx.role, company: ctx.company, website: ctx.website, city: ctx.city, industry: ctx.industry, budget: ctx.budget, decision_maker: ctx.decision_maker, goal: ctx.goal, timeline: ctx.timeline, current_lead_gen: ctx.current_lead_gen })}\n\nRESEARCH FACTS:\n${facts}`;
  const r = await fetch(BASES().groq + '/openai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
    body: JSON.stringify({ model: env('GROQ_MODEL', 'llama-3.3-70b-versatile'), temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error(`groq → ${r.status}`);
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

function writeWithRules(ctx, raw) {
  const w = raw.website?.ok ? raw.website.data : {}, rv = raw.reviews?.ok ? raw.reviews.data : {}, hi = raw.hiring?.ok ? raw.hiring.data : {}, so = raw.socials?.ok ? raw.socials.data : {}, nw = raw.news?.ok ? raw.news.data : {}, cp = raw.competitors?.ok ? raw.competitors.data : {};
  const signals = [];
  if (rv.rating) signals.push({ label: `${rv.rating}★ (${rv.count} reviews)`, detail: rv.count > 100 ? 'Established, well-reviewed business.' : 'Smaller review footprint.', source: 'reviews' });
  if (hi.roles?.length) signals.push({ label: 'Hiring', detail: `${hi.roles.length} open roles${hi.salesOrMarketingRoles ? `, ${hi.salesOrMarketingRoles} in sales/marketing — they are investing in growth` : ''}.`, source: 'hiring' });
  if (so.linkedinEmployees) signals.push({ label: `${so.linkedinEmployees} employees`, detail: 'From LinkedIn.', source: 'socials' });
  if (nw.articles?.length) signals.push({ label: 'In the news', detail: nw.articles[0].title, source: 'news' });
  if (w.copyrightYear && w.copyrightYear < new Date().getFullYear() - 1) signals.push({ label: 'Website looks dated', detail: `Footer says © ${w.copyrightYear}.`, source: 'website' });
  const ads = (w.tech || []).filter((t) => /ads/i.test(t));
  const low = (rv.reviews || []).filter((r) => r.rating <= 3).map((r) => clean(r.text, 140));
  const high = (rv.reviews || []).filter((r) => r.rating >= 5).map((r) => clean(r.text, 140));
  const better = (cp.competitors || []).filter((c) => (c.reviews || 0) > (rv.count || 0)).length;
  const dm = /yes|owner|ceo|founder/i.test(ctx.decision_maker + ' ' + ctx.role);
  const budgetOk = /\d/.test(ctx.budget || '') && parseInt(String(ctx.budget).replace(/\D/g, '')) >= 1000;
  const soon = /now|asap|this month|30|immediately/i.test(ctx.timeline || '');
  const score = (dm ? 30 : 10) + (budgetOk ? 30 : 10) + (ctx.goal ? 20 : 5) + (soon ? 20 : 8);
  return {
    one_liner: w.description || w.title || `${ctx.company} — ${ctx.industry || 'business'} in ${ctx.city || 'unknown location'}`,
    what_they_sell: w.headings?.slice(0, 3).join(' · ') || 'unknown', who_they_sell_to: 'unknown — ask on the call',
    size_estimate: so.linkedinEmployees ? `${so.linkedinEmployees} employees (LinkedIn)` : 'unknown',
    signals, reputation: { praise: high.slice(0, 2), complaints: low.slice(0, 2) },
    current_marketing: [...ads, ctx.current_lead_gen ? `They say: ${ctx.current_lead_gen}` : null].filter(Boolean),
    pain_hypotheses: [
      ctx.current_lead_gen && /referral|word of mouth/i.test(ctx.current_lead_gen) ? { pain: 'Relies on referrals — pipeline is unpredictable', evidence: `Booking form: "${ctx.current_lead_gen}"` } : null,
      better ? { pain: `${better} local competitors have more reviews`, evidence: 'Google Maps comparison' } : null,
      hi.salesOrMarketingRoles ? { pain: 'Trying to hire their way to more pipeline', evidence: 'Open sales/marketing roles' } : null,
    ].filter(Boolean),
    bant: { budget: ctx.budget || 'not given', authority: ctx.decision_maker || 'not given', need: ctx.goal || 'not given', timing: ctx.timeline || 'not given', score, verdict: score >= 75 ? 'hot — decision maker with budget and urgency' : score >= 50 ? 'warm — confirm budget and timing early' : 'cold — qualify hard in the first 5 minutes' },
    closer_plan: {
      clarify: [`What made you book a call with us now, ${ctx.name?.split(' ')[0] || ''}?`.replace(' ,', ','), ctx.goal ? `You wrote "${clean(ctx.goal, 80)}" — what does hitting that look like in 90 days?` : 'What would a great quarter look like for new clients?', 'Why is that important to you right now?'],
      label: ctx.goal ? `So the goal is ${clean(ctx.goal, 100)}, and today new business depends on ${ctx.current_lead_gen || 'things you can\'t fully control'}.` : 'Unknown — label after Clarify.',
      past_pain: ['What have you tried to get more clients?', 'How long did you run it, and how did it work?', 'What else have you tried?'],
      sell_the_vacation: `A calendar with qualified ${ctx.industry || ''} buyers booked every week, without hiring an SDR — guaranteed.`,
      objections: [{ objection: 'We tried cold email and it didn\'t work', acknowledge_associate_ask: 'Totally fair — most of our clients said the same before seeing deliverability done right. What did your setup look like?' }, { objection: 'Need to think about it', acknowledge_associate_ask: 'Makes sense. The best clients we have also took a day. What specifically would you want to think through?' }],
      reinforce: 'Worst case you get the guaranteed calls; best case this becomes your main source of clients.',
    },
    cost_of_inaction: 'Every month without a predictable pipeline is clients going to competitors who reach out first.',
    recommended_plan: budgetOk ? 'Growth — budget fits and they want consistent volume' : 'Starter — prove it, then upgrade',
    campaign_idea: `Email ${ctx.industry ? 'buyers of ' + ctx.industry.toLowerCase() : 'their ideal buyers'} in ${ctx.city || 'their area'} with a proof-led angle from their best reviews.`,
    red_flags: [!dm ? 'May not be the decision maker' : null, !budgetOk ? 'Budget unclear or under $1,000/month' : null, rv.status && rv.status !== 'OPERATIONAL' ? `Google says: ${rv.status}` : null].filter(Boolean),
    edify_line: '',
  };
}

// Facts we never let the writer change, plus closer intro (from your "edify the closer" note)
function mergeFacts(b, ctx, raw) {
  const rv = raw.reviews?.ok ? raw.reviews.data : null;
  b.facts = {
    company: ctx.company, website: ctx.website, city: ctx.city || rv?.address || null, phone: rv?.phone || raw.website?.data?.phones?.[0] || null,
    google_rating: rv?.rating ?? null, google_reviews: rv?.count ?? null, maps: rv?.mapsUrl || null,
    tech: raw.website?.data?.tech || [], socials: uniq([...(raw.website?.data?.socials || []), ...((raw.socials?.data?.profiles || []).map((p) => p.link))]).slice(0, 6),
    competitors: raw.competitors?.data?.competitors || [], news: raw.news?.data?.articles || [],
  };
  const closer = env('CLOSER_NAME', 'Limethsith'), proof = env('CLOSER_PROOF', 'has run 30+ of these calls and every client he took on got the booked calls we promised');
  b.edify_line = b.edify_line || `You'll be speaking with ${closer}. He ${proof} — so expect a straight answer on whether we can do the same for ${ctx.company}.`;
  b.bant = b.bant || {}; b.bant.score = Math.max(0, Math.min(100, +b.bant.score || 0));
  return b;
}

/* ---------------- rendering ---------------- */
const e = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const li = (a) => (a || []).filter(Boolean).map((x) => `<li>${e(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('');
export function renderBriefHtml(doc, { hubUrl = '' } = {}) {
  const b = doc.brief, f = b.facts, k = doc.booking, cp = b.closer_plan || {};
  const when = k.call_at ? new Date(k.call_at).toLocaleString('en-GB', { timeZone: env('CLOSER_TZ', 'Asia/Colombo'), weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'time not set';
  const H = (t) => `<h3 style="font:600 13px/1.3 Arial;letter-spacing:.06em;text-transform:uppercase;color:#888;margin:22px 0 8px">${t}</h3>`;
  const verdictColor = b.bant.score >= 75 ? '#1E7A3B' : b.bant.score >= 50 ? '#A16207' : '#C42408';
  return `<div style="font:14px/1.55 Arial,Helvetica,sans-serif;color:#141414;max-width:680px">
  <div style="border-left:4px solid #E0290F;padding:4px 0 4px 14px;margin-bottom:12px"><div style="font-size:12px;color:#888">Discovery call · ${e(when)} (Sri Lanka)</div><div style="font-size:21px;font-weight:700">${e(k.company)}</div><div>${e(k.name)}${k.role ? ' · ' + e(k.role) : ''} · <a href="${e(k.website)}">${e(k.website)}</a></div></div>
  <p style="margin:0 0 10px"><b>${e(b.one_liner)}</b></p>
  <table style="border-collapse:collapse;font-size:13px;width:100%"><tr>
   <td style="padding:8px;border:1px solid #eee"><div style="color:#888;font-size:11px">LEAD SCORE</div><b style="font-size:18px;color:${verdictColor}">${b.bant.score}/100</b><div style="font-size:12px">${e(b.bant.verdict)}</div></td>
   <td style="padding:8px;border:1px solid #eee"><div style="color:#888;font-size:11px">GOOGLE</div><b style="font-size:18px">${f.google_rating ? f.google_rating + '★' : '—'}</b><div style="font-size:12px">${f.google_reviews ?? 0} reviews</div></td>
   <td style="padding:8px;border:1px solid #eee"><div style="color:#888;font-size:11px">SIZE</div><b>${e(b.size_estimate)}</b></td>
   <td style="padding:8px;border:1px solid #eee"><div style="color:#888;font-size:11px">SUGGESTED PLAN</div><b>${e(b.recommended_plan)}</b></td></tr></table>
  ${H('What they said on the booking form')}<table style="font-size:13px;border-collapse:collapse">${[['Budget', b.bant.budget], ['Decision maker', b.bant.authority], ['Goal', b.bant.need], ['Timeline', b.bant.timing], ['How they get clients today', k.current_lead_gen]].map(([a, v]) => `<tr><td style="color:#888;padding:2px 14px 2px 0;vertical-align:top">${a}</td><td>${e(v || '—')}</td></tr>`).join('')}</table>
  ${H('Signals')}<ul style="margin:0;padding-left:18px">${(b.signals || []).map((s) => `<li><b>${e(s.label)}</b> — ${e(s.detail)}</li>`).join('') || '<li>None found</li>'}</ul>
  ${H('Likely pains')}<ul style="margin:0;padding-left:18px">${(b.pain_hypotheses || []).map((p) => `<li><b>${e(p.pain)}</b> <span style="color:#888">(${e(p.evidence)})</span></li>`).join('') || '<li>Ask on the call</li>'}</ul>
  ${H('Call plan — C.L.O.S.E.R.')}
  <p style="margin:0 0 4px"><b>Clarify</b></p><ul style="margin:0 0 8px;padding-left:18px">${li(cp.clarify)}</ul>
  <p style="margin:0 0 8px"><b>Label:</b> ${e(cp.label)}</p>
  <p style="margin:0 0 4px"><b>Overview past pain</b></p><ul style="margin:0 0 8px;padding-left:18px">${li(cp.past_pain)}</ul>
  <p style="margin:0 0 8px"><b>Sell the vacation:</b> ${e(cp.sell_the_vacation)}</p>
  <p style="margin:0 0 4px"><b>Explain away concerns (Acknowledge · Associate · Ask)</b></p><ul style="margin:0 0 8px;padding-left:18px">${(cp.objections || []).map((o) => `<li><i>"${e(o.objection)}"</i> → ${e(o.acknowledge_associate_ask)}</li>`).join('')}</ul>
  <p style="margin:0 0 8px"><b>Reinforce:</b> ${e(cp.reinforce)}</p>
  <p style="margin:0 0 8px"><b>Cost of doing nothing:</b> ${e(b.cost_of_inaction)}</p>
  ${H('Reputation')}<p style="margin:0">👍 ${e((b.reputation?.praise || []).join(' · ') || '—')}</p><p style="margin:4px 0 0">👎 ${e((b.reputation?.complaints || []).join(' · ') || '—')}</p>
  ${H('Campaign we could run for them')}<p style="margin:0">${e(b.campaign_idea)}</p>
  ${b.red_flags?.length ? H('Red flags') + `<ul style="margin:0;padding-left:18px;color:#C42408">${li(b.red_flags)}</ul>` : ''}
  ${H('Competitors nearby')}<p style="margin:0;font-size:13px">${f.competitors.slice(0, 5).map((c) => `${e(c.name)} (${c.rating ?? '–'}★, ${c.reviews})`).join(' · ') || '—'}</p>
  ${H('Their tools')}<p style="margin:0;font-size:13px">${e(f.tech.join(' · ') || '—')}</p>
  ${H('Research agents')}<p style="margin:0;font-size:12px;color:#888">${doc.agents.map((a) => `${a.ok ? '✓' : '✕'} ${e(a.label)}: ${e(a.summary)}`).join('<br>')}<br>Done in ${(doc.ms / 1000).toFixed(1)}s · written by ${doc.writer === 'groq' ? 'Groq (Llama 3.3)' : 'rules (no AI key)'}${hubUrl ? ` · <a href="${e(hubUrl)}">Open in the hub</a>` : ''}</p>
  </div>`;
}
export function renderBriefText(doc, max = 7000) {
  const b = doc.brief;
  return [
    `RESEARCH BRIEF — ${doc.booking.company}`, b.one_liner, `Lead score ${b.bant.score}/100 — ${b.bant.verdict}`,
    `Google: ${b.facts.google_rating ?? '—'}★ (${b.facts.google_reviews ?? 0}) · Size: ${b.size_estimate} · Plan: ${b.recommended_plan}`,
    'Pains: ' + (b.pain_hypotheses || []).map((p) => p.pain).join('; '),
    'Open with: ' + (b.closer_plan?.clarify || []).join(' / '),
    b.red_flags?.length ? 'Red flags: ' + b.red_flags.join('; ') : '',
  ].filter(Boolean).join('\n').slice(0, max);
}
