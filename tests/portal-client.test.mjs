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
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
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
test('invoice lines: what the database sent, with the total checked', () => {
  const r = P('pcInvoiceLines')({ lines: [{ label: 'Growth', amount: 3000 }, { label: 'Discount', amount: -300 }], gross: 3000, amount: 2700 });
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines[1], { label: 'Discount', amount: -300, credit: true, detail: '', term: '', off: '' });
  assert.equal(r.sum, 2700); assert.equal(r.total, 2700); assert.equal(r.matches, true);
  const none = P('pcInvoiceLines')({ gross: 1500, amount: 1500 });
  assert.deepEqual(none.lines, [{ label: 'Services', amount: 1500, credit: false, detail: '', term: '', off: '' }]);
});
test('invoice lines: fields left over from the retired trial plan are ignored, never drawn', () => {
  const f = P('pcInvoiceLines');
  /* the old credit field alone adds no line */
  const a = f({ lines: [{ label: 'Starter', amount: 1500 }], gross: 1500, pilot_credit: 300, amount: 1500 });
  assert.deepEqual(a.lines.map((l) => l.amount), [1500]); assert.equal(a.matches, true);
  const b = f({ gross: 1500, pilot_credit: 300, amount: 1500 });
  assert.deepEqual(b.lines.map((l) => l.amount), [1500]); assert.equal(b.total, 1500);
  /* an old credit line is dropped; the database's amount is still the total shown */
  const c = f({ lines: [{ label: 'Growth', amount: 3000 }, { label: 'Pilot credit', amount: -300 }], gross: 3000, pilot_credit: 300, amount: 2700 });
  assert.deepEqual(c.lines.map((l) => l.label), ['Growth']); assert.equal(c.total, 2700); assert.equal(c.matches, false);
  /* junk in those fields cannot throw */
  for (const junk of [{ pilot_credit: 'abc' }, { pilot_credit: {} }, { lines: [null, 7, { label: null, amount: 'x' }, { amount: null }] }, { lines: 'nope', pilot_credit: -1 }]) {
    assert.doesNotThrow(() => f(junk)); assert.deepEqual(f(junk).lines, []);
  }
});
test('invoice lines: a 3-month term shows months × the monthly price, and the saving', () => {
  const d = P('pcLineDetail');
  assert.equal(d({ months: 3, unit: 1200, list_unit: 1500 }, 'USD'), '3 months × $1,200.00 a month · 20% off the $1,500.00 monthly price');
  assert.equal(d({ months: 3, unit: 2400 }, 'USD'), '3 months × $2,400.00 a month');
  assert.equal(d({ months: 3, unit: 1500, list_unit: 1500 }, 'USD'), '3 months × $1,500.00 a month');
  for (const quiet of [{ months: 1, unit: 3000 }, { months: 3 }, { months: 'x', unit: 5 }, { months: 3, unit: 0 }, { months: 2.5, unit: 10 }, {}, null]) assert.equal(d(quiet, 'USD'), '');
  const r = P('pcInvoiceLines')({ currency: 'USD', lines: [{ label: 'Starter · 5 qualified calls a month · 3-month term', amount: 3600, months: 3, unit: 1200, list_unit: 1500 }], amount: 3600 });
  assert.equal(r.lines[0].detail, '3 months × $1,200.00 a month · 20% off the $1,500.00 monthly price'); assert.equal(r.matches, true);
});
test('invoice lines: the database total wins, and a mismatch is flagged', () => {
  const r = P('pcInvoiceLines')({ lines: [{ label: 'Growth', amount: 3000 }], amount: 2500 });
  assert.equal(r.total, 2500); assert.equal(r.sum, 3000); assert.equal(r.matches, false);
  const empty = P('pcInvoiceLines')(null);
  assert.deepEqual(empty, { lines: [], sum: 0, total: 0, matches: true });
});

/* ───────────── dates ───────────── */
test('a date-only value is a calendar day in every time zone', () => {
  const d = P('pcDate');
  assert.equal(d('2026-11-24'), 'November 24, 2026');
  assert.equal(d('2026-01-01'), 'January 1, 2026');
  assert.equal(d('2026-12-31'), 'December 31, 2026');
  assert.equal(d(''), ''); assert.equal(d(null), ''); assert.equal(d('not a date'), '');
});
test('a timestamp is shown in the viewer\'s own zone', () => {
  const local = new Date(2026, 10, 25, 23, 30);
  assert.equal(P('pcDate')(local.toISOString()), 'November 25, 2026');
  assert.equal(P('pcDayKey')(local.toISOString()), '2026-11-25');
  assert.match(P('pcTime')(local.toISOString()), /11[:.]30|23[:.]30/);
});
test('day labels: Today, Yesterday, then the day by name', () => {
  const l = P('pcDayLabel');
  const now = new Date(2026, 10, 24, 12, 0);
  assert.equal(l(new Date(2026, 10, 24, 0, 5), now), 'Today');
  assert.equal(l(new Date(2026, 10, 23, 23, 55), now), 'Yesterday');
  assert.equal(l(new Date(2026, 10, 20, 9, 0), now), 'Friday, November 20');
  assert.equal(l(new Date(2025, 11, 31, 9, 0), now), 'Wednesday, December 31, 2025');
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
  assert.equal((h.match(/class="pc-sec[ "]/g) || []).length, 2);
});
test('agreement: once signed, the form is replaced by who signed and when', () => {
  const h = P('pcAgreementHtml')({ ...AGREEMENT, status: 'signed', signed_name: 'Dana <W>', signed_at: new Date(2026, 10, 25, 10, 0).toISOString() });
  assert.ok(h.includes('Signed by Dana &lt;W&gt; on November 25, 2026'));
  assert.ok(!h.includes('pcSignForm') && !h.includes('Sign agreement'));
  assert.ok(h.includes('Print or save as PDF'));
  const v = P('pcAgreementHtml')({ ...AGREEMENT, status: 'void' });
  assert.ok(!v.includes('pcSignForm') && v.includes('withdrawn'));
  assert.doesNotThrow(() => P('pcAgreementHtml')(null));
});

const INVOICE = { kind: 'invoice', number: 'AV-1042', status: 'sent', issued_on: '2026-11-24', due_on: '2026-12-01', paid_at: null, currency: 'USD',
  lines: [{ label: 'Growth <plan>', amount: 3000 }, { label: 'Agreed discount', amount: -300 }], gross: 3000, amount: 2700,
  bill_to: { company: 'Acme & Co', contact_name: 'Dana', contact_email: 'dana@acme.example' },
  from: { legal_name: '[YOUR COMPANY LEGAL NAME]', address: '[YOUR COMPANY ADDRESS]', email: 'aviancelk@gmail.com' },
  pay: { wise_details: 'IBAN: GB00 <TEST>', payoneer_link: 'https://pay.example/x' } };

test('invoice: lines, a negative line, total and how to pay', () => {
  const h = P('pcInvoiceHtml')(INVOICE);
  assert.ok(h.includes('>Invoice</h1>') && h.includes('AV-1042'));
  assert.ok(h.includes('November 24, 2026') && h.includes('December 1, 2026'));
  assert.ok(h.includes('Growth &lt;plan&gt;') && h.includes('Acme &amp; Co'));
  assert.ok(h.includes('class="pc-credit"') && h.includes('−$300.00'));
  assert.ok(h.includes('Total due · USD') && h.includes('$2,700.00') && h.includes('>Invoice no.</dt><dd>AV-1042</dd>'));
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
  assert.ok(h.includes('>Receipt</h1>') && h.includes('pc-stamp-paid') && h.includes('November 26, 2026'));
  assert.ok(h.includes('Total paid') && !h.includes('How to pay') && !h.includes('Pay by card'));
  assert.doesNotThrow(() => P('pcInvoiceHtml')(null));
  /* a receipt is its own document: says so, says when, and asks for nothing */
  assert.ok(h.includes('pc-receipt') && h.includes('<p class="pc-tag">Receipt</p>') && h.includes('>Paid on</dt><dd>November 26, 2026</dd>'));
  assert.ok(h.includes('Paid in full on November 26, 2026. Nothing more is owed on this invoice.') && h.includes('Received from'));
  assert.ok(!h.includes('>Due</dt>') && !h.includes('>Terms</dt>') && !h.includes('Total due') && !h.includes('Bill to'));
  const u = P('pcInvoiceHtml')(INVOICE);
  assert.ok(!u.includes('pc-receipt') && u.includes('>Due</dt><dd>December 1, 2026</dd>') && u.includes('Bill to') && !u.includes('Paid in full'));
  /* paid with no date recorded still reads properly */
  const nd = P('pcInvoiceHtml')({ ...INVOICE, status: 'paid', paid_at: null });
  assert.ok(nd.includes('Paid in full. Nothing more is owed') && !nd.includes('>Paid on</dt>') && !nd.includes('undefined'));
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
  /* a client never reads the database's own words: "permission denied" told them
     nothing they could act on and named our plumbing */
  assert.equal(e.ok, false);
  assert.equal(e.error, 'Your sign-in has run out. Please sign in again.');
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
    /* core.js is the shared leaf helpers (the escape, the result shape, the day key) and
       loads first on every page of the site. It reads no hub global, asks the database
       nothing and knows nothing about a client, so it is not a hub module: it is here so
       that the client's pages escape and date exactly as the owner's do, from one copy.
       After it, the portal loads its own journey files — client files only, never the hub's. */
    const want = page === 'portal.html' ? ['core.js', 'portal-client.js', 'portal-tracker.js', 'portal-schedule.js', 'portal-steps.js'] : ['core.js', 'portal-client.js'];
    assert.equal(scripts.length, 1 + want.length);
    assert.equal(want[0], 'core.js', 'core.js loads before anything that uses it');
    assert.ok(scripts[0].startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'));
    assert.deepEqual(scripts.slice(1), want);
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

/* ───────────── documents v2: brackets, signatures, the calm invoice ───────────── */
test('brackets stay visible but marked, and everything is still escaped', () => {
  const f = P('pcFillHtml');
  assert.equal(f('Governed by [the laws of Sri Lanka].'), 'Governed by the laws of Sri Lanka.');
  assert.equal(f('<b>[X]</b>'), '&lt;b&gt;<mark class="pc-fill">[X]</mark>&lt;/b&gt;');
  assert.equal(f('no brackets'), 'no brackets');
  assert.equal(f('[A] and [B]').match(/pc-fill/g).length, 2);
  assert.equal(f(null), '');
});
test('agreement: Aviance signs opposite the client, by name, as Founder', () => {
  const sig = { ...AGREEMENT, terms: { ...AGREEMENT.terms, signatures: [{ label: 'For Aviance', name: 'Ravi <P>', role: 'Founder', org: 'Aviance' }] } };
  const h = P('pcAgreementHtml')(sig);
  assert.ok(h.includes('class="pc-sigs"') && h.includes('Ravi &lt;P&gt;, Founder') && h.includes('For Aviance'));
  assert.ok(h.includes('For Acme &lt;b&gt;Ltd&lt;/b&gt;') && h.includes('Signs below'));
  const s = P('pcAgreementHtml')({ ...sig, status: 'signed', signed_name: 'Dana W', signed_at: new Date(2026, 10, 25, 10, 0).toISOString() });
  assert.ok(s.includes('class="pc-sigs"') && s.includes('Ravi &lt;P&gt;, Founder') && s.includes('Signed by Dana W on November 25, 2026'));
  /* an older snapshot without signatures still shows a line to fill in */
  const old = P('pcAgreementHtml')(AGREEMENT);
  assert.ok(old.includes('<mark class="pc-fill">[YOUR NAME]</mark>, Founder'));
  assert.ok(!P('pcAgreementHtml')({ ...AGREEMENT, status: 'void' }).includes('pc-sigs'));
});
test('agreement: section numbers from the database are not doubled', () => {
  const h = P('pcAgreementHtml')({ ...AGREEMENT, terms: { sections: [{ h: '7. How we send', body: ['x'] }] } });
  assert.ok(h.includes('<span class="pc-num">1</span>How we send</h2>'));
});
test('pay details: an admin reminder in brackets never reaches a client', () => {
  const d = P('pcPayDetails');
  assert.deepEqual(d({ wise_details: '[WISE BANK DETAILS — add in Settings]', payoneer_link: '' }), { ready: false, wise: '', link: '' });
  assert.deepEqual(d({ ready: false, wise_details: 'IBAN 1', payoneer_link: 'https://p.example' }), { ready: false, wise: '', link: '' });
  assert.deepEqual(d({ ready: true, wise_details: null, payoneer_link: 'https://p.example' }), { ready: true, wise: '', link: 'https://p.example' });
  assert.deepEqual(d({ wise_details: 'IBAN 1' }), { ready: true, wise: 'IBAN 1', link: '' });
  assert.equal(d(null).ready, false);
});
test('invoice: payment details not ready shows the calm block, never the placeholder', () => {
  const h = P('pcInvoiceHtml')({ ...INVOICE, pay: { ready: false, wise_details: null, payoneer_link: '' } });
  assert.ok(h.includes('Payment details') && h.includes('We’ll send these to you directly. Reply to our email if you need them now.'));
  assert.ok(!h.includes('How to pay') && !h.includes('pc-pre') && !h.includes('Pay by card'));
  const old = P('pcInvoiceHtml')({ ...INVOICE, pay: { wise_details: '[WISE BANK DETAILS — add in Settings]', payoneer_link: '' } });
  assert.ok(!old.includes('WISE BANK DETAILS') && old.includes('We’ll send these to you directly'));
});
test('invoice: status word, service period and terms', () => {
  const h = P('pcInvoiceHtml')({ ...INVOICE, status_word: 'Unpaid', terms: 'Net 7 — due Dec 1, 2026',
    service: 'Growth · 10 qualified calls · month 1 — starts the day your first emails go out' });
  assert.ok(h.includes('>Status</dt><dd>Unpaid</dd>') && h.includes('>Terms</dt><dd>Net 7 — due Dec 1, 2026</dd>'));
  assert.ok(h.includes('class="pc-service"') && h.includes('month 1 — starts the day your first emails go out'));
  const late = P('pcInvoiceHtml')({ ...INVOICE, status_word: 'Overdue' });
  assert.ok(late.includes('<p class="pc-stamp"><strong>Overdue</strong></p>'));
  assert.equal(P('pcStatusWord')({ status: 'sent' }), 'Unpaid');
  assert.equal(P('pcStatusWord')({ status: 'paid' }), 'Paid');
});
test('invoice: "From" is plain Aviance until the owner fills in the company details', () => {
  const h = P('pcInvoiceHtml')({ ...INVOICE, from: { ready: false, legal_name: 'Aviance', email: 'hi@aviance.example' } });
  assert.ok(h.includes('<p class="pc-strong">Aviance</p>') && h.includes('hi@aviance.example') && !h.includes('[YOUR COMPANY'));
  const full = P('pcInvoiceHtml')({ ...INVOICE, from: { ready: true, legal_name: 'Aviance Pvt Ltd', address: '1 Road', email: 'a@b.example', phone: '+94 77 000' } });
  assert.ok(full.includes('Aviance Pvt Ltd') && full.includes('1 Road') && full.includes('+94 77 000'));
});
test('print: deferred so the click never freezes, with a Save-as-PDF note', () => {
  const realWin = globalThis.window;
  let printed = 0;
  globalThis.window = { print() { printed++; } };
  try {
    assert.equal(P('pcPrint')(), true);
    assert.equal(printed, 0, 'not inside the click');
  } finally { globalThis.window = realWin; }
  assert.ok(P('pcInvoiceHtml')(INVOICE).includes('Save as PDF'));
  const doc = fs.readFileSync(path.join(root, 'doc.html'), 'utf8');
  assert.ok(doc.includes('pcPrint()') && !/window\.print\(\)/.test(doc));
});

/* ───────────── times: the same words as the emails ───────────── */
test('zones read as ET / CT / MT / PT, anywhere else as the city', () => {
  const z = P('pcZoneAbbr');
  assert.equal(z('America/New_York'), 'ET'); assert.equal(z('America/Indiana/Indianapolis'), 'ET');
  assert.equal(z('America/Chicago'), 'CT'); assert.equal(z('America/Indiana/Knox'), 'CT');
  assert.equal(z('America/Denver'), 'MT'); assert.equal(z('America/Phoenix'), 'MT');
  assert.equal(z('America/Los_Angeles'), 'PT');
  assert.equal(z('Asia/Colombo'), 'Colombo time'); assert.equal(z('America/Argentina/Buenos_Aires'), 'Buenos Aires time');
  assert.equal(z(''), 'UTC');
});
test('pcWhen: "Fri, Nov 27 · 10:00 AM ET" in any zone', () => {
  const w = P('pcWhen');
  assert.equal(w('2026-11-27T15:00:00Z', 'America/New_York'), 'Fri, Nov 27 · 10:00 AM ET');
  assert.equal(w('2026-11-27T15:00:00Z', 'America/Los_Angeles'), 'Fri, Nov 27 · 7:00 AM PT');
  assert.equal(w('2026-11-27T15:00:00Z', 'Asia/Colombo'), 'Fri, Nov 27 · 8:30 PM Colombo time');
  assert.equal(w('nonsense', 'America/New_York'), '');
});
test('kickoff slots are grouped by the client\'s own day, with ET beside them', () => {
  const slots = [{ starts_at: '2026-11-27T15:30:00Z' }, { starts_at: '2026-11-27T15:00:00Z' }, { starts_at: '2026-11-27T20:00:00Z' }, { starts_at: '2026-11-27T15:00:00Z' }, null];
  const col = P('pcKickoffDays')(slots, 'Asia/Colombo', 'America/New_York');
  assert.deepEqual(col.map((d) => d.label), ['Fri, Nov 27', 'Sat, Nov 28']);
  assert.deepEqual(col[0].slots.map((s) => s.time + ' / ' + s.other), ['8:30 PM / 10:00 AM ET', '9:00 PM / 10:30 AM ET']);
  assert.equal(col[1].slots[0].time, '1:30 AM');
  const ny = P('pcKickoffDays')(slots, 'America/New_York', 'America/New_York');
  assert.equal(ny.length, 1);
  assert.equal(ny[0].slots[0].other, '', 'no second time when the client is on ET');
  assert.deepEqual(P('pcKickoffDays')(null), []);
});
test('kickoff card: pick a day, pick a time, confirm; once booked it shows the time and the link', () => {
  const k = { zone: 'America/New_York', booked: null, slots: [{ starts_at: '2026-11-27T15:00:00Z' }, { starts_at: '2026-11-30T15:00:00Z' }] };
  const h = P('pcKickoffHtml')(k, { viewerZone: 'Asia/Colombo' });
  assert.ok(h.includes('Book your kickoff') && h.includes('data-pc-day="2026-11-27"') && h.includes('aria-pressed="true">Fri, Nov 27'));
  assert.ok(h.includes('data-pc-slot="2026-11-27T15:00:00.000Z"') && h.includes('10:00 AM ET') && !h.includes('data-pc-book'));
  const pick = P('pcKickoffHtml')(k, { viewerZone: 'Asia/Colombo', day: '2026-11-30', pick: '2026-11-30T15:00:00.000Z' });
  assert.ok(pick.includes('Book Mon, Nov 30 · 10:00 AM ET?') && pick.includes('data-pc-book="2026-11-30T15:00:00.000Z"') && pick.includes('Mon, Nov 30 · 8:30 PM your time'));
  const busy = P('pcKickoffHtml')(k, { viewerZone: 'Asia/Colombo', pick: '2026-11-27T15:00:00.000Z', busy: true, error: 'That time has just <gone>.' });
  assert.ok(busy.includes(' disabled>Booking…') && busy.includes('That time has just &lt;gone&gt;.'));
  const done = P('pcKickoffHtml')({ zone: 'America/New_York', booked: { starts_at: '2026-11-27T15:00:00Z', minutes: 45, status: 'booked', meet_link: 'https://meet.jit.si/aviance-x' } },
    { viewerZone: 'America/New_York', now: '2026-11-25T00:00:00Z' });
  assert.ok(done.includes('Kickoff: Fri, Nov 27 · 10:00 AM ET') && done.includes('href="https://meet.jit.si/aviance-x"') && !done.includes('your time'));
  assert.equal(P('pcKickoffHtml')({ booked: { starts_at: '2026-11-27T15:00:00Z', minutes: 45, status: 'booked' } }, { now: '2026-12-01T00:00:00Z' }), '', 'gone once it has happened');
  const bad = P('pcKickoffHtml')({ booked: { starts_at: '2099-11-27T15:00:00Z', meet_link: 'javascript:alert(1)' } }, {});
  assert.ok(!bad.includes('javascript:'));
  assert.ok(P('pcKickoffHtml')({ zone: 'America/New_York', slots: [] }, {}).includes('Message us below'));
  assert.doesNotThrow(() => P('pcKickoffHtml')(null, null));
});
test('pcKickoff / pcBookKickoff ask the portal functions and never throw', async () => {
  reset();
  answer = { data: { zone: 'America/New_York', booked: null, slots: [] }, error: null };
  assert.equal((await P('pcKickoff')(10)).ok, true);
  assert.deepEqual(rpcs[0], { name: 'portal_kickoff_slots', args: { p_days: 10 } });
  answer = { data: 'nonsense', error: null };
  assert.equal((await P('pcKickoff')(99)).ok, false);
  assert.equal(rpcs[1].args.p_days, 21);
  answer = { data: { starts_at: '2026-11-27T15:00:00Z', meet_link: 'https://m' }, error: null };
  const b = await P('pcBookKickoff')('2026-11-27T15:00:00Z');
  assert.equal(b.ok, true);
  assert.deepEqual(rpcs[2], { name: 'portal_book_kickoff', args: { p_start: '2026-11-27T15:00:00.000Z' } });
  const n = rpcs.length;
  assert.equal((await P('pcBookKickoff')('')).ok, false);
  assert.equal(rpcs.length, n, 'no time, no question');
  answer = { data: null, error: { message: 'That time has just gone. Please pick another.' } };
  assert.equal((await P('pcBookKickoff')('2026-11-27T15:00:00Z')).error, 'That time has just gone. Please pick another.');
  answer = new Error('Failed to fetch');
  assert.equal((await P('pcKickoff')(10)).offline, true);
});
test('join.html explains the channel, the link and where to get help', () => {
  const html = fs.readFileSync(path.join(root, 'join.html'), 'utf8');
  assert.ok(html.includes('Your private line to the Aviance team — updates, approvals and questions, all in one place.'));
  assert.ok(html.includes("Opening this page doesn't use your link — only setting your password does."));
  assert.ok(html.includes('Stuck? Reply to any of our emails.'));
  assert.ok(html.includes("Reply to our email and we\\'ll send a fresh link."));
  assert.match(P('pcInviteMessage')('expired'), /fresh link/);
});
test('portal.html shows the kickoff card above the chat', () => {
  const html = fs.readFileSync(path.join(root, 'portal.html'), 'utf8');
  assert.ok(html.indexOf('id="pcKick"') > 0 && html.indexOf('id="pcKick"') < html.indexOf('id="pcScroll"'));
  assert.ok(html.includes('pcKickoffHtml(') && html.includes('pcBookKickoff(') && html.includes('pcKickoff(10)'));
});

/* ───────────── no trial plan; the 3-month term; the guarantee line ───────────── */
const TERM3 = { kind: 'invoice', number: 'AV-2026-1051', status: 'sent', status_word: 'Unpaid', issued_on: '2026-11-26', due_on: '2026-12-03', paid_at: null, currency: 'USD',
  service: 'Starter · 5 qualified calls a month · 3-month term', period: 'Months 1–3 · starts the day your first emails go out', terms: 'Net 7',
  lines: [{ label: 'Starter · 5 qualified calls a month · 3-month term', amount: 3600, months: 3, unit: 1200, list_unit: 1500 }], gross: 3600, amount: 3600,
  bill_to: { company: 'Sample Co', contact_name: 'Sam Lee', contact_email: 'sam@sample.example' },
  from: { ready: false, legal_name: 'Aviance', email: 'hi@aviance.example' }, pay: { ready: false, wise_details: null, payoneer_link: '' } };

test('invoice: a 3-month term names the term, the monthly price and the total billed up front', () => {
  const h = P('pcInvoiceHtml')(TERM3);
  assert.ok(h.includes('<span class="pc-line-t">Starter · 5 qualified calls a month · 3-month term</span>'));
  /* the term and the saving are their own rows, so each reads at a glance */
  assert.ok(h.includes('<span class="pc-line-d pc-line-term">3 months × $1,200.00 a month</span>'));
  assert.ok(h.includes('<span class="pc-line-d pc-line-off">20% off the $1,500.00 monthly price</span>'));
  assert.ok(h.includes('<span class="pc-line-d">Months 1–3 · starts the day your first emails go out</span>'));
  assert.ok(h.includes('$3,600.00') && h.includes('>Terms</dt><dd>Net 7</dd>'));
  assert.ok(!h.includes('class="pc-service"'), 'the service is not said twice when the line already says it');
  /* a monthly invoice has no "months ×" line */
  const m = P('pcInvoiceHtml')({ ...TERM3, period: 'Month 1 · starts the day your first emails go out', lines: [{ label: 'Growth · 10 qualified calls a month', amount: 3000, months: 1, unit: 3000 }], service: 'Growth · 10 qualified calls a month', gross: 3000, amount: 3000 });
  assert.ok(!m.includes('months ×') && m.includes('Month 1 · starts the day') && m.includes('$3,000.00'));
});
test('invoice: the guarantee is one line at the foot, on the invoice and the receipt, never on a cancelled one', () => {
  const g = P('PC_GUARANTEE');
  assert.ok(/twice that month’s fee/.test(g) && /refund that month in full/.test(g) && /Money back, not credit/.test(g));
  const h = P('pcInvoiceHtml')(TERM3);
  assert.equal((h.match(/class="pc-guarantee"/g) || []).length, 1);
  assert.ok(h.indexOf('pc-guarantee') > h.indexOf('pc-total') && h.indexOf('pc-guarantee') > h.indexOf('pc-pay'));
  assert.ok(P('pcInvoiceHtml')({ ...TERM3, status: 'paid', paid_at: '2026-11-27T10:00:00Z' }).includes('class="pc-guarantee"'));
  const v = P('pcInvoiceHtml')({ ...TERM3, status: 'void', status_word: 'Void' });
  assert.ok(!v.includes('pc-guarantee') && !v.includes('How to pay') && !v.includes('Payment details') && !v.includes('Total due'));
  assert.ok(v.includes('This invoice has been cancelled. Nothing is owed on it.') && v.includes('<p class="pc-stamp"><strong>Void</strong></p>'));
});
test('invoice: an old document that still carries the retired plan\'s fields draws without them', () => {
  const old = { ...TERM3, pilot_credit: 300, gross: 3000, amount: 2700, service: undefined, period: undefined,
    lines: [{ label: 'Growth · 10 qualified calls · month 1', amount: 3000 }, { label: 'Pilot credit', amount: -300 }] };
  let h;
  assert.doesNotThrow(() => { h = P('pcInvoiceHtml')(old); });
  assert.ok(!/pilot/i.test(h) && !h.includes('pc-credit') && !h.includes('−$300.00'));
  assert.ok(h.includes('$2,700.00'), 'the amount the database says is owed is still the total');
  for (const junk of [{ pilot_credit: 'x' }, { pilot_credit: null, lines: null }, { kind: 'invoice', pilot_credit: 300 }]) {
    assert.doesNotThrow(() => P('pcInvoiceHtml')(junk));
    assert.ok(!/pilot/i.test(P('pcInvoiceHtml')(junk)));
  }
});
test('invoice: nothing breaks, and nothing reads "undefined", when details are missing', () => {
  const f = P('pcInvoiceHtml');
  for (const d of [null, {}, { status: 'sent' }, { status: 'paid' }, { ...TERM3, pay: undefined }, { ...TERM3, pay: null, from: null, bill_to: null },
    { ...TERM3, pay: { ready: true, wise_details: '', payoneer_link: '' } }, { ...TERM3, number: null, issued_on: null, due_on: null, terms: null, currency: null },
    { ...TERM3, lines: [], gross: null, amount: null }]) {
    let h;
    assert.doesNotThrow(() => { h = f(d); });
    assert.ok(!/undefined|null|NaN|\[object/.test(h.replace(/class="[^"]*"/g, '')), JSON.stringify(d));
  }
  /* no bank details and no card link: the calm block, no empty pay box, no button */
  const none = f({ ...TERM3, pay: { ready: true, wise_details: '', payoneer_link: '' } });
  assert.ok(none.includes('We’ll send these to you directly') && !none.includes('<pre') && !none.includes('Pay by card'));
  /* no one to bill yet: the block is left out, not left empty; "From" still names us */
  const bare = f({ ...TERM3, bill_to: {}, from: {} });
  assert.ok(!bare.includes('Bill to') && bare.includes('<p class="pc-strong">Aviance</p>'));
  /* a card link alone is enough to pay */
  const card = f({ ...TERM3, pay: { ready: true, wise_details: null, payoneer_link: 'https://pay.example/x' } });
  assert.ok(card.includes('How to pay') && card.includes('Pay by card') && !card.includes('<pre'));
});

/* The agreement the database writes (agreement_terms, 20261129): numbered clauses, bracketed defaults. */
const TERMS_V3 = { title: 'Service Agreement', intro: 'This is the whole agreement between Aviance ("we") and Sample Co ("you").',
  parties: [{ label: 'Aviance (we)', value: 'Aviance' }, { label: 'Client (you)', value: 'Sample Co' }],
  sections: [
    { h: '1. What you are buying', body: ['1.1 You are on the Growth plan: 10 booked calls a month.', '1.3 [Your first month starts on the day your first emails go out (your launch day), not the day you sign.]'] },
    { h: '5. Our guarantee', body: ['5.1 Month one: if we deliver fewer than 10 booked calls in your first month, we refund twice that month\'s fee: $6,000 back.',
      '5.4 A refund is money back, not a credit. We pay it [by bank transfer to the account you paid from] within [10 business days] of the end of the month we missed.'] },
    { h: '9. The small print', body: ['9.3 This agreement is governed by [the laws of Sri Lanka].'] }],
  signatures: [{ label: 'For Aviance', name: 'Limethsith', role: 'Founder', org: 'Aviance' }] };
test('agreement: numbered clauses read as plain text, with no brackets left for the client', () => {
  const h = P('pcAgreementHtml')({ kind: 'agreement', company: 'Sample Co', status: 'sent', terms: TERMS_V3 });
  assert.equal((h.match(/class="pc-sec[ "]/g) || []).length, 3);
  assert.ok(h.includes('<span class="pc-num">1</span>What you are buying</h2>') && h.includes('<span class="pc-num">3</span>The small print</h2>'));
  assert.ok(h.includes('<p>1.1 You are on the Growth plan: 10 booked calls a month.</p>'));
  assert.ok(h.includes('<p>1.3 Your first month starts on the day your first emails go out (your launch day), not the day you sign.</p>'));
  assert.ok(h.includes('We pay it by bank transfer to the account you paid from within 10 business days of'));
  assert.ok(h.includes('governed by the laws of Sri Lanka.') && !/[\[\]]/.test(h.replace(/<[^>]+>/g, '')) && !h.includes('pc-fill'));
  assert.ok(h.includes('Limethsith, Founder') && h.includes('Sign agreement'));
});
test('agreement: an old snapshot written for the retired plan, or a broken one, still draws', () => {
  const f = P('pcAgreementHtml');
  const old = { kind: 'agreement', company: 'Old Co', status: 'signed', signed_name: 'Pat Q', signed_at: '2026-10-02T09:00:00Z', pilot_credit: 300,
    terms: { title: 'Service Agreement', sections: [{ h: '3. Fees and payment', body: ['The Pilot costs $300, paid once.'] }], pilot: true } };
  let h;
  assert.doesNotThrow(() => { h = f(old); });
  assert.ok(h.includes('Signed by Pat Q') && h.includes('The Pilot costs $300, paid once.'), 'a signed document is shown as it was signed');
  for (const junk of [{ terms: null }, { terms: { sections: 'x', parties: 7, signatures: {} } }, { terms: { sections: [null, {}, { h: null, body: null }, { h: 'A', body: 'one paragraph' }] } }, { status: 'signed' }]) {
    assert.doesNotThrow(() => f(junk));
    assert.ok(!/undefined|\[object/.test(f(junk)));
  }
});
test('the migration that retires the trial plan ships, with its self-check', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261129_no_pilot_and_agreement_v3.sql'), 'utf8');
  for (const fn of ['close_won', 'raise_invoice', 'agreement_terms', 'mail_pack', 'doc_get_core', 'documents_preview']) {
    assert.ok(new RegExp('create or replace function public\\.' + fn + '\\(').test(sql), fn);
  }
  assert.ok(sql.includes("raise exception 'That plan is no longer offered. Choose Starter, Growth or Scale.'"));
  assert.ok(!/pilot_credit\b/.test(sql.replace(/^\s*--.*$/gm, '')), 'no statement reads or writes the old credit columns');
  assert.ok(!/drop\s+(column|table)|alter\s+table|delete\s+from/i.test(sql), 'nothing is dropped or deleted');
  /* outside comments, the word appears only in the self-check that hunts for it */
  const code = sql.replace(/^\s*--.*$/gm, '').split('\n').filter((l) => /pilot/i.test(l));
  assert.equal(code.length, 1); assert.ok(code[0].includes("~* 'pilot'"));
  assert.ok(sql.includes("array['starter','starter3','growth','growth3','scale','scale3']"));
  assert.ok(sql.includes('governed by [the laws of Sri Lanka]'));
});

/* ───────────── how to pay: every rail, several at once, and the honest fallback ─────────────
   The rail is not chosen yet, so all five are proved here. Every value below is an obvious
   fake — zeros, TESTTEST, example.com — and no real account number or link is in this file. */
const PAY_WIRE = { kind: 'bank_wire', fields: { account_holder: 'AVIANCE TEST HOLDER',
  beneficiary_address: '1 Test Lane, Test City, Testland', account_number: '0000 0000 0000',
  iban: 'TT00 TEST 0000 0000 0000', bank_name: 'Example Bank PLC', swift: 'TESTTEST',
  bank_address: '1 Example Road, Test City 03, Testland',
  intermediary_bank: 'Example Correspondent Bank, New York', intermediary_swift: 'TESTUS33' } };
const PAY_SECOND = { kind: 'wise', fields: { account_holder: 'AVIANCE TEST HOLDER',
  bank_name: 'Second Example Bank', account_number: '1111111111', swift: 'TESTSCND' } };
const PAY_PAYONEER = { kind: 'payoneer', fields: { link: 'https://pay.example/payoneer/request' } };
const PAY_PAYPAL = { kind: 'paypal', fields: { link: 'https://paypal.example/me/avianceTEST', email: 'billing@example.test' } };
const PAY_CARD = { kind: 'card_link', fields: { link: 'https://checkout.example/test-session' } };
const payInv = (pay) => ({ ...TERM3, pay: { ready: true, currency: 'USD', terms: 'Net 7', ...pay } });

test('how to pay: each rail renders its own fields, on its own', () => {
  const f = P('pcInvoiceHtml');

  /* The wire is the rail that works today, and it is a wire FROM a US company TO a bank
     abroad: beneficiary, SWIFT, branch address with its country, and the correspondent bank. */
  const wire = f(payInv({ preferred: 'bank_wire', methods: [PAY_WIRE] }));
  assert.ok(wire.includes('How to pay') && wire.includes('>Bank transfer</p>'));
  for (const [label, value] of [['Beneficiary name', 'AVIANCE TEST HOLDER'],
    ['Beneficiary address', '1 Test Lane, Test City, Testland'],
    ['Account number', '0000 0000 0000'], ['IBAN', 'TT00 TEST 0000 0000 0000'],
    ['Beneficiary bank', 'Example Bank PLC'], ['SWIFT / BIC', 'TESTTEST'],
    ['Bank address', '1 Example Road, Test City 03, Testland'],
    ['Correspondent bank', 'Example Correspondent Bank, New York'],
    ['Correspondent SWIFT / BIC', 'TESTUS33']]) {
    assert.ok(wire.includes('>' + label + '</dt>'), 'label missing: ' + label);
    assert.ok(wire.includes('>' + value + '</dd>'), 'value missing: ' + label);
  }
  /* the fields read down in the order a US wire form asks for them */
  assert.ok(wire.indexOf('Beneficiary name') < wire.indexOf('Account number'));
  assert.ok(wire.indexOf('Account number') < wire.indexOf('SWIFT / BIC'));
  assert.ok(wire.indexOf('SWIFT / BIC') < wire.indexOf('Correspondent bank'));
  /* no ABA is claimed when there is none: a Sri Lankan account has no routing number */
  assert.ok(!wire.includes('Routing number'), 'routing is left out unless it is filled in');
  const us = f(payInv({ preferred: 'bank_wire', methods: [{ kind: 'bank_wire', fields: { ...PAY_WIRE.fields, routing_number: '000000000' } }] }));
  assert.ok(us.includes('>Routing number (ABA)</dt>') && us.indexOf('Routing number') > us.indexOf('Correspondent SWIFT'),
    'and it is last when it is there');

  /* a second bank account is a second bank account; Wise is never named to a client */
  const second = f(payInv({ preferred: 'wise', methods: [PAY_SECOND] }));
  assert.ok(second.includes('>Bank transfer (second account)</p>'));
  assert.ok(second.includes('>1111111111</dd>') && second.includes('>TESTSCND</dd>'));
  assert.doesNotMatch(f(payInv({ preferred: 'wise', methods: [PAY_SECOND] })), /wise/i, 'the word Wise reaches no client');

  const payo = f(payInv({ preferred: 'payoneer', methods: [PAY_PAYONEER] }));
  assert.ok(payo.includes('>Payoneer</p>') && payo.includes('href="https://pay.example/payoneer/request"'));
  assert.ok(payo.includes('>Pay with Payoneer</a>') && /no Payoneer account needed/.test(payo));

  const pp = f(payInv({ preferred: 'paypal', methods: [PAY_PAYPAL] }));
  assert.ok(pp.includes('>PayPal</p>') && pp.includes('>Pay with PayPal</a>') && pp.includes('>billing@example.test</dd>'));
  assert.ok(/goods-and-services payment/.test(pp), 'the client is told which kind of PayPal payment to send');

  const card = f(payInv({ preferred: 'card_link', methods: [PAY_CARD] }));
  assert.ok(card.includes('>Card or online checkout</p>') && card.includes('>Pay by card</a>'));
  assert.ok(card.includes('href="https://checkout.example/test-session"') && !card.includes('<pre'));
});

test('how to pay: several rails at once — the preferred one large, the rest as "or"', () => {
  const all = [PAY_WIRE, PAY_SECOND, PAY_PAYONEER, PAY_PAYPAL, PAY_CARD];
  const h = P('pcInvoiceHtml')(payInv({ preferred: 'card_link', methods: all }));
  assert.equal((h.match(/class="pc-pay-main"/g) || []).length, 1, 'exactly one rail is the big one');
  assert.equal((h.match(/class="pc-pay-alt"/g) || []).length, 4, 'the other four read as "or"');
  assert.ok(h.indexOf('Or pay this way instead') > h.indexOf('pc-pay-main'));
  /* the preferred one comes first on the page */
  assert.ok(h.indexOf('Card or online checkout') < h.indexOf('Bank transfer<'), 'the pick is above the rest');
  for (const name of ['Bank transfer', 'Bank transfer (second account)', 'Payoneer', 'PayPal', 'Card or online checkout']) assert.ok(h.includes(name), name);
  /* the house order when no pick is made: wire, second account, Payoneer, card, PayPal last */
  assert.deepEqual(P('pcPayPlan')({ ready: true, methods: all }).others.map((m) => m.kind),
    ['wise', 'payoneer', 'card_link', 'paypal'], 'PayPal is last, the wire is first');
});

test('how to pay: preferred wins; an unknown or missing pick falls back to the first rail', () => {
  const plan = P('pcPayPlan');
  const two = { ready: true, methods: [PAY_WIRE, PAY_PAYPAL] };
  assert.equal(plan({ ...two, preferred: 'paypal' }).preferred.kind, 'paypal');
  assert.deepEqual(plan({ ...two, preferred: 'paypal' }).others.map((m) => m.kind), ['bank_wire']);
  assert.equal(plan({ ...two, preferred: 'nonsense' }).preferred.kind, 'bank_wire', 'an unknown pick is not obeyed');
  assert.equal(plan(two).preferred.kind, 'bank_wire', 'no pick: the first rail in the house order');
  /* the house order is the same whatever order the database sent */
  assert.deepEqual(plan({ ready: true, methods: [PAY_CARD, PAY_PAYPAL, PAY_WIRE] }).preferred.kind, 'bank_wire');
  /* a rail named twice is one rail */
  assert.equal(plan({ ready: true, methods: [PAY_WIRE, PAY_WIRE] }).others.length, 0);
  /* a rail the file does not know, or one switched on with nothing in it, is simply not there */
  assert.equal(plan({ ready: true, methods: [{ kind: 'crypto', fields: { account_number: '1' } }, { kind: 'paypal', fields: {} }] }).ready, false);
});

test('how to pay: the client is told the amount, the currency, the due date and the reference', () => {
  const h = P('pcInvoiceHtml')(payInv({ preferred: 'bank_wire', methods: [PAY_WIRE] }));
  assert.ok(h.includes('$3,600.00 USD') && h.includes('December 3, 2026'), 'what to pay and by when');
  assert.ok(h.includes('>Reference to quote</span> <span class="pc-pay-v pc-pay-num">AV-2026-1051</span>'));
  assert.ok(/Put the reference on the payment/.test(h));
  /* the owner may tell his bank to expect something else; then that is what the client quotes */
  const own = P('pcInvoiceHtml')(payInv({ preferred: 'bank_wire',
    methods: [{ kind: 'bank_wire', fields: { ...PAY_WIRE.fields, reference: 'AVIANCE-TEST-REF' } }] }));
  assert.ok(own.includes('>AVIANCE-TEST-REF</span>') && !own.includes('>AV-2026-1051</span>'));
  assert.ok(!own.includes('>Reference to quote</dt>'), 'the convention is not also a field row');
  /* nothing reads "undefined" when the invoice has no number, no due date and no currency */
  const bare = P('pcInvoiceHtml')({ ...payInv({ preferred: 'bank_wire', methods: [PAY_WIRE] }), number: null, due_on: null, currency: null, terms: null });
  assert.ok(bare.includes('How to pay') && !bare.includes('Reference to quote'));
  assert.ok(!/undefined|null|NaN|\[object/.test(bare.replace(/class="[^"]*"/g, '')));
});

test('how to pay: nothing configured keeps the honest sentence and invents nothing', () => {
  const f = P('pcInvoiceHtml');
  for (const pay of [undefined, null, {}, { ready: false }, { ready: true, methods: [] },
    { ready: false, methods: [PAY_WIRE] }, { ready: true, methods: 'not a list' },
    { ready: true, methods: [{ kind: 'bank_wire', fields: { account_number: '[YOUR ACCOUNT NUMBER]' } }] }]) {
    const h = f({ ...TERM3, pay });
    assert.ok(h.includes('We’ll send these to you directly. Reply to our email if you need them now.'), JSON.stringify(pay));
    assert.ok(!h.includes('How to pay') && !h.includes('pc-pay-main') && !h.includes('Reference to quote'), JSON.stringify(pay));
    assert.ok(!/YOUR ACCOUNT NUMBER|Account number/.test(h), 'no invented or bracketed detail');
  }
});

test('receipt: a paid invoice says how it was paid and never how to pay', () => {
  const paid = { ...payInv({ preferred: 'bank_wire', methods: [PAY_WIRE], paid_method: 'bank_wire' }), status: 'paid', paid_at: '2026-12-02T10:00:00Z' };
  const h = P('pcInvoiceHtml')(paid);
  assert.ok(h.includes('>Receipt</h1>') && h.includes('Payment received'));
  assert.ok(h.includes('Paid in full on December 2, 2026. Nothing more is owed on this invoice.'));
  assert.ok(h.includes('Paid by Bank transfer') && h.includes('Keep this receipt for your records.'));
  assert.ok(h.includes('>Reference</span>') && h.includes('AV-2026-1051'));
  /* not one instruction, not one stored detail */
  assert.ok(!h.includes('How to pay') && !h.includes('Reference to quote') && !h.includes('pc-pay-main'));
  for (const secret of ['0000 0000 0000', '000000000', 'TESTTEST', 'Example Bank', 'Aviance Test Holder']) {
    assert.ok(!h.includes(secret), 'a receipt shows no account detail: ' + secret);
  }
  /* no rail recorded: it says nothing rather than guessing one */
  const q = P('pcInvoiceHtml')({ ...paid, pay: { ...paid.pay, paid_method: undefined } });
  assert.ok(!q.includes('Paid by') && q.includes('Payment received'));
  assert.ok(!/undefined|null|NaN/.test(q.replace(/class="[^"]*"/g, '')));
});

test('how to pay: not one field reaches the page unescaped', () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const h = P('pcInvoiceHtml')({ ...TERM3, number: nasty, pay: { ready: true, preferred: 'bank_wire', currency: '"><b>',
    methods: [
      { kind: 'bank_wire', fields: { account_holder: nasty, bank_name: '</dd><script>a()</script>', account_number: nasty,
        routing_number: nasty, swift: nasty, bank_address: nasty, note: '</section><script>b()</script>' } },
      { kind: 'card_link', fields: { link: 'javascript:alert(1)', note: nasty } },
      { kind: 'paypal', fields: { link: 'https://a.example/"onmouseover="x', email: nasty } },
    ] } });
  assert.ok(!h.includes('<img src=x') && !h.includes('<script>') && !h.includes('</script>'));   /* the Aviance logo is the only <img */
  assert.ok(!/<[^>]*onerror=/i.test(h) && !/<[^>]*onmouseover=/i.test(h), 'no handler lands inside a tag');
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'), 'it is shown, escaped');
  assert.ok(!h.includes('Pay by card') && !h.includes('>Pay with PayPal</a>'), 'neither unsafe link becomes a button');
  assert.ok(!/href="javascript:|href="https:\/\/a\.example\/"/.test(h));
  /* and a note that is only an admin reminder is dropped, not shown */
  const held = P('pcInvoiceHtml')(payInv({ preferred: 'bank_wire',
    methods: [{ kind: 'bank_wire', fields: { account_holder: 'Aviance Test Holder', note: '[ADD A NOTE IN SETTINGS]' } }] }));
  assert.ok(!held.includes('ADD A NOTE IN SETTINGS') && held.includes('Aviance Test Holder'));
});

test('how to pay: the older invoice shape still works, and ready:false still wins', () => {
  const plan = P('pcPayPlan');
  const legacy = plan({ wise_details: 'Account 0000, SWIFT TESTTEST', payoneer_link: 'https://pay.example/x' });
  assert.equal(legacy.ready, true);
  /* the old free-text box was always just bank transfer details, and reads as that */
  assert.deepEqual([legacy.preferred.kind, legacy.others.map((m) => m.kind)], ['bank_wire', ['card_link']]);
  assert.equal(legacy.preferred.free, 'Account 0000, SWIFT TESTTEST');
  assert.equal(legacy.preferred.label, 'Bank transfer');
  assert.equal(plan({ ready: false, wise_details: 'Account 0000' }).ready, false);
  assert.equal(plan({ wise_details: '[WISE BANK DETAILS — add in Settings]', payoneer_link: '' }).ready, false);
  /* the new list, when there is one, is what is used */
  assert.equal(plan({ ready: true, methods: [PAY_PAYPAL], wise_details: 'Account 0000' }).preferred.kind, 'paypal');
  assert.deepEqual([plan(null).ready, plan('x').ready, plan(undefined).ready], [false, false, false]);
  /* currency and terms travel with the block */
  const p = plan({ ready: true, methods: [PAY_WIRE], currency: 'usd', terms: ' Net 7 ' });
  assert.deepEqual([p.currency, p.terms], ['USD', 'Net 7']);
});

test('how to pay: the preferred rail is one click to copy, and the whole block prints', () => {
  const h = P('pcInvoiceHtml')(payInv({ preferred: 'bank_wire', methods: [PAY_WIRE, PAY_CARD] }));
  assert.ok(h.includes('class="pc-pay-v pc-pay-num">0000 0000 0000<'), 'a number is select-all and in mono');
  const css = fs.readFileSync(path.join(root, 'portal-client.css'), 'utf8');
  assert.ok(/\.pc-pay-v\{[^}]*user-select:all/.test(css), 'select-all is what makes it copyable');
  assert.ok(/\.pc-pay-num\{[^}]*var\(--pc-mono\)/.test(css), 'numbers are JetBrains Mono');
  assert.ok(/\.pc-pay-main\{border:2px solid var\(--pc-ink\)/.test(css), 'the preferred rail is a 2px Ink box');
  assert.ok(/@media print[\s\S]*\.pc-pay-main\{/.test(css), 'the pay block has print rules too');
  /* the card button is hidden on paper, but the URL is printed as text */
  assert.ok(h.includes('<p class="pc-noprint"><a class="pc-btn') && h.includes('class="pc-pay-url pc-pay-v">https://checkout.example/test-session<'));
});

/* ───────────── the house style: letterhead, figures, the guarantee block ─────────────
   These are what makes the pages read as one firm's documents. They are
   structural, not decorative: a letterhead that names the document and its
   reference, mono tabular figures, and the one warm block on the clause the
   client is really buying. */

const CSS = fs.readFileSync(path.join(root, 'portal-client.css'), 'utf8');

test('letterhead: the mark, the wordmark, the kind of document and its reference', () => {
  const head = P('pcLetterheadHtml')('Invoice', 'AV-2026-1016');
  assert.ok(head.includes('class="pc-mark"') && head.includes('>Aviance</span>'));
  assert.ok(head.includes('<p class="pc-tag">Invoice</p>') && head.includes('<p class="pc-docref">AV-2026-1016</p>'));
  /* no reference, no empty line */
  assert.ok(!P('pcLetterheadHtml')('Agreement', '').includes('pc-docref'));
  assert.ok(!P('pcLetterheadHtml')('Agreement').includes('undefined'));
  /* the wordmark is decoration: the mark's alt already says Aviance */
  assert.ok(head.includes('aria-hidden="true"'));
  /* everything escapes */
  const bad = P('pcLetterheadHtml')('<b>Invoice</b>', '"><script>alert(1)</script>');
  assert.ok(!bad.includes('<script>') && !bad.includes('<b>Invoice</b>') && bad.includes('&lt;script&gt;'));
});

test('letterhead and footer are on the agreement, the invoice and the receipt', () => {
  const a = P('pcAgreementHtml')({ kind: 'agreement', company: 'Sample Co', status: 'sent', terms: TERMS_V3 });
  assert.ok(a.includes('class="pc-dochead"') && a.includes('<p class="pc-tag">Agreement</p>'));
  assert.ok(a.includes('class="pc-docend"') && a.includes('Aviance · Agreement'));
  assert.ok(a.indexOf('pc-docend') > a.indexOf('pc-sigs'), 'the footer is last');
  const i = P('pcInvoiceHtml')(INVOICE);
  assert.ok(i.includes('<p class="pc-docref">AV-1042</p>') && i.includes('Aviance · Invoice'));
  const r = P('pcInvoiceHtml')({ ...INVOICE, status: 'paid', paid_at: '2026-11-26T09:00:00Z' });
  assert.ok(r.includes('Aviance · Receipt'));
  /* an invoice with no number still draws a clean letterhead */
  assert.ok(!P('pcInvoiceHtml')({ ...INVOICE, number: null }).includes('pc-docref'));
});

test('invoice: the amount, the due date and the reference sit together at the top', () => {
  const h = P('pcInvoiceHtml')(INVOICE);
  const headline = h.indexOf('class="pc-headline"');
  assert.ok(headline > 0 && headline < h.indexOf('class="pc-two"'), 'the figure block comes before the addresses');
  assert.ok(h.indexOf('class="pc-total"') > headline && h.indexOf('class="pc-meta"') > headline);
  /* the due row is marked so the eye finds it; a receipt has nothing due */
  assert.ok(h.includes('<div class="pc-meta-r pc-meta-due"><dt class="pc-tag">Due</dt>'));
  assert.ok(h.includes('<div class="pc-meta-r pc-meta-ref"><dt class="pc-tag">Invoice no.</dt>'));
  const paid = P('pcInvoiceHtml')({ ...INVOICE, status: 'paid', paid_at: '2026-11-26T09:00:00Z' });
  assert.ok(!paid.includes('pc-meta-due'));
  /* the table closes with the same total, so a page of lines still foots */
  assert.ok(h.includes('<tfoot><tr><th scope="row">Total due · USD</th><td class="pc-amt">$2,700.00</td></tr></tfoot>'));
  assert.ok(paid.includes('<th scope="row">Total paid · USD</th>'));
});

test('invoice: every figure is mono and tabular, and the money column is right-aligned', () => {
  assert.ok(/\.pc-total-n\{font-family:var\(--pc-mono\)[^}]*font-variant-numeric:tabular-nums/.test(CSS));
  assert.ok(/\.pc-meta dd\{[^}]*font-family:var\(--pc-mono\)[^}]*font-variant-numeric:tabular-nums/.test(CSS));
  assert.ok(/\.pc-lines \.pc-amt\{text-align:right[^}]*font-family:var\(--pc-mono\)[^}]*font-variant-numeric:tabular-nums/.test(CSS));
  assert.ok(/\.pc-docref\{[^}]*var\(--pc-mono\)/.test(CSS));
});

test('the term and the saving are each their own line, in mono', () => {
  const parts = P('pcLineParts');
  assert.deepEqual(parts({ months: 3, unit: 1200, list_unit: 1500 }, 'USD'),
    { term: '3 months × $1,200.00 a month', off: '20% off the $1,500.00 monthly price' });
  assert.deepEqual(parts({ months: 3, unit: 2400 }, 'USD'), { term: '3 months × $2,400.00 a month', off: '' });
  for (const quiet of [{ months: 1, unit: 3000 }, {}, null, { months: 3, unit: 0 }]) assert.deepEqual(parts(quiet, 'USD'), { term: '', off: '' });
  /* the one-sentence form older callers read is still the two halves joined */
  assert.equal(P('pcLineDetail')({ months: 3, unit: 1200, list_unit: 1500 }, 'USD'),
    '3 months × $1,200.00 a month · 20% off the $1,500.00 monthly price');
  assert.ok(/\.pc-line-term\{font-family:var\(--pc-mono\)/.test(CSS) && /\.pc-line-off\{font-family:var\(--pc-mono\)/.test(CSS));
});

test('the guarantee gets the one warm block, on the invoice and in the agreement', () => {
  const h = P('pcAgreementHtml')({ kind: 'agreement', company: 'Sample Co', status: 'sent', terms: TERMS_V3 });
  /* found by what the clause is called, not by its number */
  assert.equal((h.match(/class="pc-sec pc-sec-warm"/g) || []).length, 1);
  assert.ok(h.indexOf('pc-sec-warm') < h.indexOf('Our guarantee'));
  const none = P('pcAgreementHtml')({ kind: 'agreement', status: 'sent', terms: { sections: [{ h: '1. How we send', body: ['x'] }] } });
  assert.ok(!none.includes('pc-sec-warm'), 'no guarantee clause, no warm block');
  /* Sand with a red rule on the left edge, and never red text on Sand */
  assert.ok(/\.pc-sec-warm\{[^}]*background:var\(--pc-sand\)[^}]*border-left:3px solid var\(--pc-red\)/.test(CSS));
  assert.ok(/\.pc-guarantee\{[^}]*background:var\(--pc-sand\)[^}]*border-left:3px solid var\(--pc-red\)/.test(CSS));
  assert.ok(/\.pc-sec-warm \.pc-num\{color:var\(--pc-ink\)\}/.test(CSS));
  /* a printer that drops backgrounds still shows both blocks as blocks */
  assert.ok(/@media print[\s\S]*\.pc-sec-warm\{[^}]*border-left:2pt solid var\(--pc-red\)/.test(CSS));
  assert.ok(/@media print[\s\S]*\.pc-guarantee\{[^}]*border-left:2pt solid var\(--pc-red\)/.test(CSS));
  assert.ok(/\.pc-guarantee,\n?\s*\.pc-sec-warm\{-webkit-print-color-adjust:exact/.test(CSS));
});

test('the signature block is something you sign: a name on a rule and a date under it', () => {
  const sign = P('pcSignaturesHtml');
  const unsigned = sign({ company: 'Sample Co', status: 'sent', terms: TERMS_V3 });
  assert.ok(unsigned.includes('<p class="pc-sig-date"><span class="pc-tag">Date</span><span class="pc-sig-dv">&nbsp;</span></p>'));
  const signed = sign({ company: 'Sample Co', status: 'signed', signed_name: 'Dana W', signed_at: '2026-11-25T10:00:00Z', terms: TERMS_V3 });
  assert.ok(signed.includes('<span class="pc-sig-dv">November 25, 2026</span>'));
  assert.ok(!/undefined|NaN/.test(sign({ status: 'signed', signed_name: 'Dana W', signed_at: null, terms: TERMS_V3 })));
  assert.ok(/\.pc-sig-dv\{[^}]*border-bottom:1px solid var\(--pc-line\)/.test(CSS), 'the date has a line to sit on');
  assert.ok(/\.pc-signature\{[^}]*border-bottom:1px solid var\(--pc-ink\)/.test(CSS), 'so does the name');
});

test('the palette is the house palette, and the clause column is one width', () => {
  for (const token of ['--pc-ink:#0A0A0C', '--pc-line:#DCDCE0', '--pc-grey:#63636A', '--pc-sand:#F4EFE9', '--pc-red:#E0290F', '--pc-red-text:#C42408']) {
    assert.ok(CSS.includes(token), token);
  }
  /* the clause number and every line of its clause share one column */
  assert.ok(/\.pc-sec h2\{display:grid;grid-template-columns:var\(--pc-clause\) 1fr/.test(CSS));
  assert.ok(/\.pc-sec p\{[^}]*padding-left:var\(--pc-clause\)/.test(CSS));
});

test('the two pages wear the same letterhead as the documents', () => {
  const doc = fs.readFileSync(path.join(root, 'doc.html'), 'utf8');
  const join = fs.readFileSync(path.join(root, 'join.html'), 'utf8');
  assert.ok(doc.includes("pcLetterheadHtml('Welcome'") && doc.includes('pcDocFootHtml('));
  assert.ok(join.includes("pcLetterheadHtml('Set your password'") && join.includes('pcDocFootHtml('));
  /* both pages still build their text with the shared, escaping helpers */
  assert.ok(doc.includes('pcParasHtml(') && doc.includes('pcEsc(') && join.includes('pcEsc('));
  /* the unfilled-placeholder highlight is still the one in portal-client.js */
  assert.ok(P('pcFillHtml')('[YOUR NAME] signs').includes('<mark class="pc-fill">[YOUR NAME]</mark>'));
  assert.equal(P('pcFillHtml')('<b>[5 business days]</b>'), '&lt;b&gt;5 business days&lt;/b&gt;');
});

/* ───────────── what a CLIENT is allowed to read in an error ─────────────
   The person on the other side of this file is paying us. They may be told what
   failed and what to do about it. They may never be shown a Postgres message, a
   table or column name, an error code, a stack, a bare HTTP status, or the word
   "undefined" — none of which they can act on, all of which say we are careless
   with their account. */

test('no client is ever shown the database\'s own words', () => {
  const err = P('pcErr'), plain = P('pcPlain');
  const leaks = /relation |column |constraint|duplicate key|violates|row-level|permission denied|schema cache|PGRST|42501|42P01|23505|pg_|SQLSTATE|outreach_|client_months|channel_messages|\bselect\b|\binsert\b|undefined|\[object/i;
  const cases = [
    {message: 'permission denied for table outreach_campaigns', code: '42501'},
    {message: 'relation "client_months" does not exist', code: '42P01'},
    {message: 'duplicate key value violates unique constraint "invoices_number_key"', code: '23505'},
    {message: 'new row violates row-level security policy for table "channel_messages"'},
    {message: 'Could not find the function public.portal_campaign in the schema cache', code: 'PGRST202'},
    {message: 'JWT expired', code: 'PGRST301'},
    {message: '500'},
    {message: 'TypeError: Cannot read properties of undefined (reading \'id\')\n    at pcSend (portal-client.js:1)'},
    undefined, null, {}, '', 'undefined', 'null', '[object Object]',
  ];
  for (const c of cases) {
    const r = err(c);
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.length > 10, 'there is a real sentence: ' + JSON.stringify(r.error));
    assert.doesNotMatch(r.error, leaks, 'leaked for ' + JSON.stringify(c) + ': ' + r.error);
    /* it ends like a sentence, and tells them something to do */
    assert.match(r.error, /[.!]$/, 'reads as a sentence: ' + r.error);
  }
  /* the four sentences it does use are the ones a person can act on */
  assert.match(plain('permission denied'), /sign in again/i);
  assert.match(plain('JWT expired'), /sign in again/i);
  assert.match(plain('Failed to fetch'), /connection/i);
  assert.match(plain('relation "x" does not exist'), /try again|tell us/i);
});

test('our own sentences, and our own database messages, pass through untouched', () => {
  const err = P('pcErr'), plain = P('pcPlain');
  /* a plpgsql `raise exception` (P0001) is written for the client already */
  assert.equal(plain('That time has just been taken. Pick another.', 'P0001'),
    'That time has just been taken. Pick another.');
  /* and so is anything this file writes itself */
  assert.equal(err('This link is not valid any more. Reply to our email and we will send a new one.').error,
    'This link is not valid any more. Reply to our email and we will send a new one.');
  /* offline is still flagged, so a screen can say "check your connection" its own way */
  assert.equal(err({message: 'Failed to fetch'}).offline, true);
  assert.equal(err({message: 'permission denied'}).offline, false);
});
