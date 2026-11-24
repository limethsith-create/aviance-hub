/* The client's pages (doc.html, join.html, portal.html) share portal-client.js.
   These are the parts a client's money, signature and messages pass through:
   reading the link token, escaping, money, invoice lines, dates, the password
   rule and message grouping — plus proof that the data calls ask the database
   for the right thing and never throw. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(import.meta.dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-client.js'), 'utf8'), { filename: 'portal-client.js' });
const P = (n) => vm.runInThisContext(n);

/* ───────────── a fake supabase ───────────── */
let rpcs, queries, answer, tableAnswer;
function fakeSb() {
  return {
    async rpc(name, args) { rpcs.push({ name, args }); if (answer instanceof Error) throw answer; return answer; },
    from(table) {
      const q = { table, filters: [], op: 'select', payload: null };
      queries.push(q);
      const api = {
        select() { return api; }, insert(p) { q.op = 'insert'; q.payload = p; return api; },
        eq(k, v) { q.filters.push([k, v]); return api; }, is(k, v) { q.filters.push([k, v]); return api; },
        order() { return api; }, limit() { return api; },
        async single() { const r = tableAnswer(q); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
        then(res, rej) { return Promise.resolve(tableAnswer(q)).then(res, rej); },
      };
      return api;
    },
  };
}
function reset() {
  rpcs = []; queries = []; answer = { data: null, error: null };
  tableAnswer = () => ({ data: [], error: null });
  P('pcUseClient')('anon', fakeSb());
  P('pcUseClient')('portal', fakeSb());
}

/* ───────────── token ───────────── */
test('the token is read from the #fragment and nothing else', () => {
  const t = P('pcTokenFromHash');
  assert.equal(t('#abcDEF0123456789'), 'abcDEF0123456789');
  assert.equal(t('abcDEF0123456789'), 'abcDEF0123456789');
  assert.equal(t('#token=abcDEF0123456789'), 'abcDEF0123456789');
  assert.equal(t('#/abc-DEF_012.345~6789'), 'abc-DEF_012.345~6789');
  assert.equal(t('#  abcDEF0123456789  '), 'abcDEF0123456789');
});
test('anything that cannot be a token reads as no token', () => {
  const t = P('pcTokenFromHash');
  for (const bad of ['', '#', null, undefined, '#short', '#has space in it', '#<script>alert(1)</script>', '#%E0%A4%A', '#abc&def=1234567', '#' + 'a'.repeat(600)]) {
    assert.equal(t(bad), '', String(bad));
  }
});

/* ───────────── escaping ───────────── */
test('pcEsc makes any text safe for HTML, attributes included', () => {
  const e = P('pcEsc');
  assert.equal(e(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(e(null), ''); assert.equal(e(undefined), ''); assert.equal(e(0), '0');
  assert.equal(e('[SQUARE BRACKETS] stay'), '[SQUARE BRACKETS] stay');
});
test('only a plain https link can become a pay button', () => {
  const u = P('pcSafeUrl');
  assert.equal(u('https://pay.example/abc?x=1'), 'https://pay.example/abc?x=1');
  for (const bad of ['', null, 'javascript:alert(1)', 'http://pay.example', 'data:text/html,x', 'https://a.example/"onmouseover="x', 'https://a b']) assert.equal(u(bad), '', String(bad));
});

/* ───────────── money ───────────── */
test('money: whole dollars in, a full figure out', () => {
  const m = P('pcMoney');
  assert.equal(m(3997, 'USD'), '$3,997.00');
  assert.equal(m(0, 'USD'), '$0.00');
  assert.equal(m(1234567, 'usd'), '$1,234,567.00');
  assert.equal(m(300), '$300.00');
  assert.equal(m(-300, 'USD'), '−$300.00');
  assert.equal(m(2497, 'GBP'), '£2,497.00');
  assert.equal(m(2497, 'LKR'), '2,497.00 LKR');
  assert.equal(m(null, 'USD'), ''); assert.equal(m('abc', 'USD'), '');
});

/* ───────────── invoice lines ───────────── */
test('invoice lines: the pilot credit is its own negative line and the total checks out', () => {
  const r = P('pcInvoiceLines')({ lines: [{ label: 'Growth', amount: 3997 }, { label: 'Pilot credit', amount: -300 }], gross: 3997, pilot_credit: 300, amount: 3697 });
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines[1], { label: 'Pilot credit', amount: -300, credit: true });
  assert.equal(r.sum, 3697); assert.equal(r.total, 3697); assert.equal(r.matches, true);
});
test('invoice lines: a credit the lines forgot is added, never doubled', () => {
  const f = P('pcInvoiceLines');
  const a = f({ lines: [{ label: 'Starter', amount: 2497 }], gross: 2497, pilot_credit: 300, amount: 2197 });
  assert.deepEqual(a.lines.map((l) => l.amount), [2497, -300]); assert.equal(a.matches, true);
  const b = f({ gross: 2497, pilot_credit: 300, amount: 2197 });
  assert.deepEqual(b.lines.map((l) => l.amount), [2497, -300]); assert.equal(b.total, 2197);
  const c = f({ lines: [{ label: 'Pilot', amount: 300 }], gross: 300, pilot_credit: 0, amount: 300 });
  assert.equal(c.lines.length, 1); assert.equal(c.matches, true);
});
test('invoice lines: the database total wins, and a mismatch is flagged', () => {
  const r = P('pcInvoiceLines')({ lines: [{ label: 'Growth', amount: 3997 }], pilot_credit: 0, amount: 3500 });
  assert.equal(r.total, 3500); assert.equal(r.sum, 3997); assert.equal(r.matches, false);
  const empty = P('pcInvoiceLines')(null);
  assert.deepEqual(empty, { lines: [], sum: 0, total: 0, matches: true });
});

/* ───────────── dates ───────────── */
test('a date-only value is a calendar day in every time zone', () => {
  const d = P('pcDate');
  assert.equal(d('2026-11-24'), '24 November 2026');
  assert.equal(d('2026-01-01'), '1 January 2026');
  assert.equal(d('2026-12-31'), '31 December 2026');
  assert.equal(d(''), ''); assert.equal(d(null), ''); assert.equal(d('not a date'), '');
});
test('a timestamp is shown in the viewer\'s own zone', () => {
  const local = new Date(2026, 10, 25, 23, 30);
  assert.equal(P('pcDate')(local.toISOString()), '25 November 2026');
  assert.equal(P('pcDayKey')(local.toISOString()), '2026-11-25');
  assert.match(P('pcTime')(local.toISOString()), /11[:.]30|23[:.]30/);
});
test('day labels: Today, Yesterday, then the day by name', () => {
  const l = P('pcDayLabel');
  const now = new Date(2026, 10, 24, 12, 0);
  assert.equal(l(new Date(2026, 10, 24, 0, 5), now), 'Today');
  assert.equal(l(new Date(2026, 10, 23, 23, 55), now), 'Yesterday');
  assert.equal(l(new Date(2026, 10, 20, 9, 0), now), 'Friday 20 November');
  assert.equal(l(new Date(2025, 11, 31, 9, 0), now), 'Wednesday 31 December 2025');
  assert.equal(l(new Date(2026, 10, 30), new Date(2026, 11, 1)), 'Yesterday');
});

/* ───────────── password + signature rules ───────────── */
test('password: at least 8, at most 72, and both boxes agree', () => {
  const p = P('pcPasswordProblem');
  assert.equal(p('1234567', '1234567'), 'Use at least 8 characters.');
  assert.equal(p('', ''), 'Use at least 8 characters.');
  assert.equal(p(null), 'Use at least 8 characters.');
  assert.equal(p('12345678', '12345679'), 'The two passwords do not match.');
  assert.equal(p('x'.repeat(73), 'x'.repeat(73)), 'Use 72 characters or fewer.');
  assert.equal(p('12345678', '12345678'), '');
  assert.equal(p('correct horse'), '', 'no second box given means only the length is checked');
});
test('signature: a real name and a ticked box', () => {
  const s = P('pcSignProblem');
  assert.equal(s('', true), 'Type your full name to sign.');
  assert.equal(s('   ', true), 'Type your full name to sign.');
  assert.equal(s('12', true), 'Type your full name to sign.');
  assert.match(s('Dana Whitfield', false), /Tick the box/);
  assert.match(s('x'.repeat(121), true), /too long/);
  assert.equal(s('Dana Whitfield', true), '');
  assert.equal(s('Zoë Ångström', true), '');
});
test('first name for the welcome line', () => {
  const f = P('pcFirstName');
  assert.equal(f('Dana Whitfield'), 'Dana'); assert.equal(f('  Sam  '), 'Sam'); assert.equal(f(''), 'there'); assert.equal(f(null), 'there');
});
test('a message is trimmed and capped at 4000 characters', () => {
  const c = P('pcCleanBody');
  assert.equal(c('  hi\r\nthere  '), 'hi\nthere');
  assert.equal(c('   '), ''); assert.equal(c(null), '');
  assert.equal(c('x'.repeat(5000)).length, 4000);
});

/* ───────────── message grouping ───────────── */
const HOME = { person: { id: 'p1', name: 'Dana' }, company: 'Northwind', channel: { id: 'c1', name: 'n' },
  members: [{ kind: 'team', id: 'u1', name: 'Rashid' }, { kind: 'client', id: 'p1', name: 'Dana' }, { kind: 'client', id: 'p2', name: 'Sam' }] };
const at = (d, h, m) => new Date(2026, 10, d, h, m).toISOString();

test('messages are grouped by local day, in time order, with names from the members map', () => {
  const days = P('pcGroupMessages')([
    { id: 3, author_person: 'p1', body: 'three', created_at: at(24, 9, 0) },
    { id: 1, author_user: 'u1', body: 'one', created_at: at(23, 10, 0) },
    { id: 2, author_user: 'u1', body: 'two', created_at: at(23, 10, 2) },
    { id: 4, author_person: 'p2', body: 'four', created_at: at(24, 9, 1) },
  ], HOME, new Date(2026, 10, 24, 12, 0));
  assert.deepEqual(days.map((d) => d.label), ['Yesterday', 'Today']);
  assert.deepEqual(days[0].items.map((m) => [m.id, m.kind, m.name, m.mine, m.lead]), [[1, 'team', 'Rashid', false, true], [2, 'team', 'Rashid', false, false]]);
  assert.deepEqual(days[1].items.map((m) => [m.id, m.kind, m.name, m.mine, m.lead]), [[3, 'client', 'Dana', true, true], [4, 'client', 'Sam', false, true]]);
});
test('grouping: a long gap or a new day starts a fresh header; unknown authors get a plain name', () => {
  const days = P('pcGroupMessages')([
    { id: 1, author_user: 'u1', body: 'a', created_at: at(24, 9, 0) },
    { id: 2, author_user: 'u1', body: 'b', created_at: at(24, 9, 6) },
    { id: 3, author_user: 'u9', body: 'c', created_at: at(24, 9, 7) },
    { id: 4, author_person: 'p9', body: 'd', created_at: at(24, 9, 8) },
  ], HOME, new Date(2026, 10, 24, 12, 0));
  assert.deepEqual(days[0].items.map((m) => m.lead), [true, true, true, true]);
  assert.equal(days[0].items[2].name, 'Aviance');
  assert.equal(days[0].items[3].name, 'Northwind');
  assert.equal(days[0].items[3].mine, false);
});
test('grouping: removed messages, duplicates and junk are left out; nothing throws', () => {
  const g = P('pcGroupMessages');
  const days = g([
    { id: 1, author_user: 'u1', body: 'a', created_at: at(24, 9, 0) },
    { id: 1, author_user: 'u1', body: 'a', created_at: at(24, 9, 0) },
    { id: 2, author_user: 'u1', body: 'gone', created_at: at(24, 9, 1), deleted_at: at(24, 9, 2) },
    null,
  ], HOME, new Date(2026, 10, 24, 12, 0));
  assert.equal(days.length, 1); assert.equal(days[0].items.length, 1);
  assert.deepEqual(g(null, null), []); assert.deepEqual(g([], HOME), []);
});

/* ───────────── HTML builders: escaped, and saying the right thing ───────────── */
const AGREEMENT = { kind: 'agreement', company: 'Acme <b>Ltd</b>', contact_name: 'Dana', status: 'sent', signed_name: null, signed_at: null,
  terms: { title: 'Service <i>Agreement</i>', intro: 'Intro & more', parties: [{ label: 'Provider', value: '[YOUR COMPANY LEGAL NAME]' }],
    sections: [{ h: 'Fees', body: ['Pay <script>alert(1)</script>', 'Governed by [JURISDICTION].'] }, { h: 'Term', body: ['Monthly.'] }],
    placeholders: ['OWNER-ONLY-NOTE-XYZ'] } };

test('agreement: everything from the database is escaped, brackets stay, the owner\'s list is not shown', () => {
  const h = P('pcAgreementHtml')(AGREEMENT);
  assert.ok(!h.includes('<script>alert(1)</script>') && h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!h.includes('<b>Ltd</b>') && !h.includes('<i>Agreement</i>'));
  assert.ok(h.includes('[YOUR COMPANY LEGAL NAME]') && h.includes('[JURISDICTION]'));
  assert.ok(!h.includes('OWNER-ONLY-NOTE-XYZ'));
  assert.ok(h.includes('Type your full name to sign'));
  assert.ok(h.includes('I have read this agreement and I am authorised to sign for Acme &lt;b&gt;Ltd&lt;/b&gt;'));
  assert.ok(h.includes('>Sign agreement</button>'));
  assert.equal((h.match(/class="pc-sec"/g) || []).length, 2);
});
test('agreement: once signed, the form is replaced by who signed and when', () => {
  const h = P('pcAgreementHtml')({ ...AGREEMENT, status: 'signed', signed_name: 'Dana <W>', signed_at: new Date(2026, 10, 25, 10, 0).toISOString() });
  assert.ok(h.includes('Signed by Dana &lt;W&gt; on 25 November 2026'));
  assert.ok(!h.includes('pcSignForm') && !h.includes('Sign agreement'));
  assert.ok(h.includes('Print or save as PDF'));
  const v = P('pcAgreementHtml')({ ...AGREEMENT, status: 'void' });
  assert.ok(!v.includes('pcSignForm') && v.includes('withdrawn'));
  assert.doesNotThrow(() => P('pcAgreementHtml')(null));
});

const INVOICE = { kind: 'invoice', number: 'AV-1042', status: 'sent', issued_on: '2026-11-24', due_on: '2026-12-01', paid_at: null, currency: 'USD',
  lines: [{ label: 'Growth <plan>', amount: 3997 }, { label: 'Pilot credit', amount: -300 }], gross: 3997, pilot_credit: 300, amount: 3697,
  bill_to: { company: 'Acme & Co', contact_name: 'Dana', contact_email: 'dana@acme.example' },
  from: { legal_name: '[YOUR COMPANY LEGAL NAME]', address: '[YOUR COMPANY ADDRESS]', email: 'aviancelk@gmail.com' },
  pay: { wise_details: 'IBAN: GB00 <TEST>', payoneer_link: 'https://pay.example/x' } };

test('invoice: lines, credit, total and how to pay', () => {
  const h = P('pcInvoiceHtml')(INVOICE);
  assert.ok(h.includes('>Invoice</h1>') && h.includes('AV-1042'));
  assert.ok(h.includes('24 November 2026') && h.includes('1 December 2026'));
  assert.ok(h.includes('Growth &lt;plan&gt;') && h.includes('Acme &amp; Co'));
  assert.ok(h.includes('class="pc-credit"') && h.includes('−$300.00'));
  assert.ok(h.includes('Total due') && h.includes('$3,697.00'));
  assert.ok(h.includes('How to pay') && h.includes('IBAN: GB00 &lt;TEST&gt;'));
  assert.ok(h.includes('href="https://pay.example/x"') && h.includes('>Pay by card</a>'));
});
test('invoice: no card button without a safe link', () => {
  const f = P('pcInvoiceHtml');
  assert.ok(!f({ ...INVOICE, pay: { wise_details: 'x', payoneer_link: '' } }).includes('Pay by card'));
  assert.ok(!f({ ...INVOICE, pay: { wise_details: 'x', payoneer_link: 'javascript:alert(1)' } }).includes('Pay by card'));
});
test('invoice: once paid it reads as a receipt', () => {
  const h = P('pcInvoiceHtml')({ ...INVOICE, status: 'paid', paid_at: new Date(2026, 10, 26, 9, 0).toISOString() });
  assert.ok(h.includes('>Receipt</h1>') && h.includes('pc-stamp-paid') && h.includes('26 November 2026'));
  assert.ok(h.includes('Total paid') && !h.includes('How to pay') && !h.includes('Pay by card'));
  assert.doesNotThrow(() => P('pcInvoiceHtml')(null));
});
test('thread: the empty state, and message text escaped', () => {
  const t = P('pcThreadHtml');
  assert.ok(t([]).includes('This is your direct line to the Aviance team. Say hello.'));
  const days = P('pcGroupMessages')([{ id: 1, author_person: 'p1', body: '<img src=x onerror=alert(1)>', created_at: at(24, 9, 0) }],
    { ...HOME, members: [{ kind: 'client', id: 'p1', name: '<b>Dana</b>' }] }, new Date(2026, 10, 24, 12, 0));
  const h = t(days);
  assert.ok(!h.includes('<img') && h.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!h.includes('<b>Dana</b>') && h.includes('&lt;b&gt;Dana&lt;/b&gt;'));
  assert.ok(h.includes('pc-msg-mine'));
});
test('the dead-link page says the agreed words', () => {
  assert.ok(P('pcDeadLinkHtml')().includes('This link is not valid any more. Reply to our email and we will send a new one.'));
  assert.equal(P('pcInviteMessage')('used'), 'This link has already been used. Sign in instead.');
  assert.match(P('pcInviteMessage')('expired'), /expired/);
  assert.match(P('pcInviteMessage')('whatever'), /not valid any more/);
});

/* ───────────── data calls: right question, {ok,data,error}, never throw ───────────── */
test('pcDocGet asks doc_get with the token and passes the document through', async () => {
  reset(); answer = { data: INVOICE, error: null };
  const r = await P('pcDocGet')('tok12345');
  assert.deepEqual(rpcs, [{ name: 'doc_get', args: { p_token: 'tok12345' } }]);
  assert.equal(r.ok, true); assert.equal(r.data.number, 'AV-1042');
});
test('pcDocGet: no token asks nothing; a refusal or nonsense is a dead link, not a crash', async () => {
  reset();
  const none = await P('pcDocGet')('');
  assert.equal(none.ok, false); assert.equal(rpcs.length, 0);
  answer = { data: null, error: { message: 'This link is not valid.' } };
  const bad = await P('pcDocGet')('tok12345');
  assert.equal(bad.ok, false); assert.equal(bad.error, 'This link is not valid.'); assert.ok(!bad.offline);
  answer = { data: { kind: 'surprise' }, error: null };
  assert.equal((await P('pcDocGet')('tok12345')).ok, false);
  answer = new TypeError('Failed to fetch');
  const off = await P('pcDocGet')('tok12345');
  assert.equal(off.ok, false); assert.equal(off.offline, true); assert.match(off.error, /could not reach/i);
});
test('pcDocSign sends token, tidy name and the browser; refuses an empty name without asking', async () => {
  reset(); answer = { data: { ...AGREEMENT, status: 'signed' }, error: null };
  const r = await P('pcDocSign')('tok12345', '  Dana   Whitfield ', 'UA/1.0');
  assert.deepEqual(rpcs, [{ name: 'doc_sign', args: { p_token: 'tok12345', p_name: 'Dana Whitfield', p_agent: 'UA/1.0' } }]);
  assert.equal(r.ok, true);
  reset();
  const e = await P('pcDocSign')('tok12345', '  ', 'UA');
  assert.equal(e.ok, false); assert.equal(rpcs.length, 0);
});
test('pcInvitePeek always answers in the peek shape', async () => {
  reset();
  assert.deepEqual((await P('pcInvitePeek')('')).data, { ok: false, reason: 'invalid' });
  assert.equal(rpcs.length, 0);
  answer = { data: { ok: true, email: 'a@b.example', company: 'Acme', name: 'Dana W' }, error: null };
  const r = await P('pcInvitePeek')('tok12345');
  assert.deepEqual(rpcs, [{ name: 'invite_peek', args: { p_token: 'tok12345' } }]);
  assert.equal(r.data.email, 'a@b.example');
  answer = { data: null, error: null };
  assert.deepEqual((await P('pcInvitePeek')('tok12345')).data, { ok: false, reason: 'invalid' });
});
test('pcAccept posts only {token,password} to portal-accept, and reads plain-word errors', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opt) => { seen.push({ url, opt }); return { ok: true, json: async () => ({ ok: true, email: 'a@b.example' }) }; };
    const r = await P('pcAccept')('tok12345', 'longenough');
    assert.equal(r.ok, true); assert.equal(r.data.email, 'a@b.example');
    assert.equal(seen[0].url, 'https://zjbxnkpktbghhudjbxhk.supabase.co/functions/v1/portal-accept');
    assert.ok(!seen[0].url.includes('?'), 'the token never rides in a query string');
    assert.equal(seen[0].opt.method, 'POST');
    assert.deepEqual(JSON.parse(seen[0].opt.body), { token: 'tok12345', password: 'longenough' });
    const short = await P('pcAccept')('tok12345', 'short');
    assert.equal(short.ok, false); assert.equal(seen.length, 1, 'a short password is never posted');
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: 'This link has expired.' }) });
    assert.equal((await P('pcAccept')('tok12345', 'longenough')).error, 'This link has expired.');
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const off = await P('pcAccept')('tok12345', 'longenough');
    assert.equal(off.ok, false); assert.equal(off.offline, true);
  } finally { globalThis.fetch = realFetch; }
});
test('pcHome: null stays null (not a client), a full answer passes through', async () => {
  reset(); answer = { data: null, error: null };
  const n = await P('pcHome')();
  assert.equal(n.ok, true); assert.equal(n.data, null);
  assert.deepEqual(rpcs[0], { name: 'portal_home', args: {} });
  answer = { data: HOME, error: null };
  assert.equal((await P('pcHome')()).data.channel.id, 'c1');
  answer = { data: { company: 'half an answer' }, error: null };
  assert.equal((await P('pcHome')()).data, null);
});
test('pcMessages reads only this channel, oldest first', async () => {
  reset();
  tableAnswer = () => ({ data: [{ id: 2, created_at: at(24, 9, 1) }, { id: 1, created_at: at(24, 9, 0) }], error: null });
  const r = await P('pcMessages')('c1');
  assert.equal(queries[0].table, 'channel_messages');
  assert.deepEqual(queries[0].filters[0], ['channel_id', 'c1']);
  assert.deepEqual(r.data.map((m) => m.id), [1, 2]);
  assert.equal((await P('pcMessages')('')).ok, false);
  tableAnswer = () => ({ data: null, error: { message: 'permission denied' } });
  const e = await P('pcMessages')('c1');
  assert.equal(e.ok, false); assert.equal(e.error, 'permission denied');
});
test('pcSend writes as the client person, never as a team user, and never an empty message', async () => {
  reset();
  tableAnswer = (q) => ({ data: [{ id: 9, ...q.payload }], error: null });
  const r = await P('pcSend')('c1', 'p1', '  hello  ');
  assert.equal(r.ok, true);
  assert.deepEqual(queries[0].payload, { channel_id: 'c1', author_person: 'p1', body: 'hello' });
  assert.ok(!('author_user' in queries[0].payload));
  const n = queries.length;
  assert.equal((await P('pcSend')('c1', 'p1', '   ')).ok, false);
  assert.equal((await P('pcSend')('c1', '', 'hi')).ok, false);
  assert.equal(queries.length, n);
});

/* ───────────── the pages themselves ───────────── */
const HUB = ['meetings.js', 'finance.js', 'portal.js', 'settings.js', 'channels.js', 'channels-api.js', 'clientbook.js', 'pipeline.js', 'calling.js', 'team.js', 'onboarding.js', 'digest.js', 'wrapup.js', 'outreach.js', 'theme.css'];
for (const page of ['doc.html', 'join.html', 'portal.html']) {
  test(`${page} loads only the client files and obeys the site's content policy`, () => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(scripts.length, 2);
    assert.ok(scripts[0].startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'));
    assert.equal(scripts[1], 'portal-client.js');
    assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]), ['portal-client.css']);
    for (const f of HUB) assert.ok(!html.includes('"' + f + '"'), `${page} must not load ${f}`);
    assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html), 'fonts come from this site only');
    assert.ok(!/location\.search|[?&]token=/.test(html), 'a token never rides in a query string');
    assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(html), 'a token is kept in memory only');
    assert.ok(html.includes('<html lang="en">') && html.includes('name="viewport"'));
  });
}
test('the stylesheet loads no outside font and ships print rules', () => {
  const css = fs.readFileSync(path.join(root, 'portal-client.css'), 'utf8');
  assert.ok(!/@import|https?:\/\//.test(css));
  assert.ok(css.includes('@media print') && css.includes('.pc-noprint{display:none'));
  assert.ok(css.includes('/fonts/inter-latin.woff2') && fs.existsSync(path.join(root, 'fonts', 'inter-latin.woff2')));
});
test('portal-client.js keeps no token or password in storage', () => {
  const js = fs.readFileSync(path.join(root, 'portal-client.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(js));
});
