/* Tests for callers.js — the owner's Callers screen: the scoreboard, the
   access code he shows once, and above all the CSV of leads he uploads.

   Run with: npm test. No browser and no network: callers.js runs in a vm with
   esc(), a tiny document whose elements remember their innerHTML, and a fake
   Supabase client that records every rpc and answers what the test says.

   What is checked hardest, in the order it would cost him money:
     1. the CSV parser — headers in any order and in odd capitals, a BOM, CRLF,
        quoted commas, blank rows, a missing phone, a duplicate phone, 2,000
        rows, a row longer than its header — and that bad rows are COUNTED AND
        SHOWN rather than silently dropped;
     2. that nothing reaches the database until he presses Import;
     3. the money column: the bonus, the 2%, and the zero states;
     4. every lead field (company, name, notes) escaped — they come from a file
        a stranger made;
     5. the access code: once, copyable, gone from state when closed, never in
        a toast or a log, and a POST carrying only {staff_id} plus his token;
     6. degrading politely before the migration is applied.
   The render functions are pure (data in, HTML string out), so most of this
   file is plain string checks. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── a fake world: elements, one Supabase, no timers ───────────── */

const els = {};                      // id -> a fake element that keeps its innerHTML
function el(id) {
  return els[id] || (els[id] = {
    id, innerHTML: '', value: '', files: null, clicked: 0, focused: 0,
    focus() { this.focused++; }, click() { this.clicked++; },
    setAttribute() {}, getAttribute: () => null,
  });
}

let calls;                           // every rpc and every fetch, in order
let rpcs;                            // name -> answer
let fetchAnswer;
let toasts;

const fakeSb = {
  from() { throw new Error('callers.js must not touch a table directly'); },
  async rpc(name, args) {
    calls.push({ rpc: name, args });
    const h = rpcs[name];
    if (h instanceof Error) throw h;
    return h ? h(args) : { data: null, error: null };
  },
  auth: { async getSession() { return { data: { session: { access_token: 'owner-jwt' } }, error: null }; } },
};

const sandbox = {
  console, Date, Number, Math, Promise, Array, String, Boolean, Object, JSON, RegExp, Error, isFinite,
  setTimeout, clearTimeout, setInterval, clearInterval,
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  toast: (m) => toasts.push(m),
  document: { hidden: false, activeElement: null, getElementById: el },
  navigator: {},
  currentView: 'callers',
  authUser: { id: 'owner', uid: 'owner', role: 'admin', name: 'Limethsith' },
  sb: fakeSb,
  SUPA_URL: 'https://zjbxnkpktbghhudjbxhk.supabase.co',
  SUPA_KEY: 'sb_publishable_test',
  fetch: async (url, opts) => { calls.push({ fetch: url, opts }); if (fetchAnswer instanceof Error) throw fetchAnswer; return fetchAnswer; },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const SRC = fs.readFileSync(path.join(root, 'callers.js'), 'utf8');
vm.runInContext(SRC + `
;globalThis.api={cal,calRpc,calMissing,calPlain,calNum,calCallerRow,calStatRow,calFeedRow,
  calBoardShape,calFetchList,calFetchBoard,calNameProblem,calEmailProblem,calAdd,calSetStatus,
  calCode,calCsvCells,calNorm,calHeaderMap,calCell,calDigits,calRowProblem,calParseCsv,
  calSplitPlan,calFileProblem,calBatchName,calReadFile,calImport,calIsOwner,calStart,calStop,
  calTick,calForgetCode,callersForget,calA,calStatusLabel,calStatusTone,calOutcomeLabel,
  calIsTalk,calMoney,calCount,calTime,calAgo,calRangeWord,calTotals,calRate,calSwitchHTML,
  calStripHTML,calBoardRowHTML,calBoardHTML,calAddFormHTML,calCodeHTML,calAskHTML,
  calPreviewRowHTML,calBadRowHTML,calSplitHTML,calPreviewHTML,calImportDoneHTML,calUploadHTML,
  calFeedRowHTML,calFeedHTML,calScreenHTML,calCtx,viewCallers,calBodyHTML,calPaint,calForcePaint,
  calLoad,calLoadBoard,calLoadAll,calSetRange,calAddOpen,calAddCancel,calAddSave,calAskYes,
  calAskNo,calAskImport,calCodeGo,calCodeHide,calCopyCode,calStatusGo,calUploadOpen,
  calLinkNew,calLinkGo,calLinkHide,calLinkHTML,calForgetLink,CAL_LINK_BASE,
  calUploadClose,calUploadReset,calPick,calBatchIn,calFileIn,calImportGo,calOnRender,
  CAL_OUTCOMES,CAL_TALKED,CAL_FIELDS,CAL_MAX_ROWS,CAL_BONUS_DEFAULT,CAL_DEAL_CUT,
  CAL_NOT_READY,CAL_CODE_NOT_READY,CAL_IMPORT_NOT_READY,CAL_FEED_MAX};`,
  sandbox, { filename: 'callers.js' });
const A = sandbox.api;

/* values made inside the vm carry the vm's prototypes; compare through JSON */
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function reset(over) {
  calls = []; rpcs = {}; toasts = [];
  fetchAnswer = { ok: true, status: 200, json: async () => ({ ok: true, code: 'AVX-4K7M-Q2ZP' }) };
  for (const k of Object.keys(els)) delete els[k];
  A.callersForget();
  sandbox.authUser = Object.assign({ id: 'owner', uid: 'owner', role: 'admin', name: 'Limethsith' }, over || {});
  sandbox.document.activeElement = null;
  sandbox.currentView = 'callers';
}
after(() => { A.callersForget(); });

/* what a stranger's CSV and a stranger's lead name really look like */
const NASTY = 'Stone "Steve" <b>O\'Brien</b> & Sons';
const CALLERS = () => [
  { id: 'c1', name: 'Nour <script>alert(1)</script>', email: 'nour@example.com', status: 'active', code_set: true },
  { id: 'c2', name: 'Mariam', email: 'mariam@example.com', status: 'active', code_set: true },
  { id: 'c3', name: 'Yasmin', email: 'yasmin@example.com', status: 'invited', code_set: true },
];
const BOARD = () => ({
  bonus: 25,
  callers: [
    { caller_id: 'c1', name: 'Nour', status: 'active', dials: 60, conversations: 14, booked: 4, showed: 3, closed: 1, closed_value: 1500 },
    { caller_id: 'c2', name: 'Mariam', status: 'active', dials: 0, conversations: 0, booked: 0, showed: 0, closed: 0, closed_value: 0 },
  ],
  feed: [
    { id: 'f1', caller_name: 'Nour', company: NASTY, lead_name: 'Steve', outcome: 'booked', note: 'wants <b>Thursday</b>', created_at: '2026-11-25T09:00:00Z' },
    { id: 'f2', caller_name: 'Mariam', company: 'Birch Legal', outcome: 'no_answer', note: '', created_at: '2026-11-25T09:05:00Z' },
  ],
});

/* ═════════════════════════ 1. THE CSV PARSER ═════════════════════════ */

test('headers in any order, in odd capitals, with spaces and synonyms', () => {
  reset();
  const csv = [
    ' Notes ,PHONE Number,Company Name,E-Mail,Time Zone,Contact Name',
    'ring after 3,+20 100 555 0101,Stone Roofing,steve@stone.example,Africa/Cairo,Steve Stone',
  ].join('\n');
  const r = A.calParseCsv(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.rows.length, 1);
  assert.deepEqual(plain(r.data.rows[0]), {
    company: 'Stone Roofing', name: 'Steve Stone', phone: '+20 100 555 0101',
    email: 'steve@stone.example', timezone: 'Africa/Cairo', notes: 'ring after 3',
  }, 'every column landed in the right field whatever its order or capitals');
  assert.deepEqual(plain(r.data.bad), []);
  // and he is told which columns were understood
  assert.ok(r.data.headers.indexOf('phone') >= 0 && r.data.headers.indexOf('company') >= 0);
});

test('a BOM, CRLF line endings and a bare CR are all read as one file', () => {
  reset();
  const bom = '﻿';
  const crlf = bom + 'company,phone\r\nStone Roofing,0100 555 0101\r\nBirch Legal,0100 555 0102\r\n';
  const r1 = A.calParseCsv(crlf);
  assert.equal(r1.ok, true, r1.error || '');
  assert.equal(r1.data.rows.length, 2, 'CRLF is one line ending, not two');
  assert.equal(r1.data.rows[0].company, 'Stone Roofing', 'the BOM is not glued to the first header');
  assert.equal(r1.data.blank, 0, 'the trailing CRLF is not counted as a blank row');

  // an old Mac export: bare CR
  const cr = 'company,phone\rStone Roofing,0100 555 0101\rBirch Legal,0100 555 0102';
  const r2 = A.calParseCsv(cr);
  assert.equal(r2.ok, true, r2.error || '');
  assert.equal(r2.data.rows.length, 2);
});

test('a quoted comma, a quoted newline and a doubled quote stay inside one cell', () => {
  reset();
  const csv = 'company,phone,notes\n'
    + '"Stone, Roofing & Co",0100 555 0101,"said ""ring me Thursday"", then hung up"\n'
    + '"Birch\nLegal",0100 555 0102,plain\n';
  const r = A.calParseCsv(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.rows.length, 2);
  assert.equal(r.data.rows[0].company, 'Stone, Roofing & Co', 'the comma did not split the cell');
  assert.equal(r.data.rows[0].notes, 'said "ring me Thursday", then hung up', 'a doubled quote is one quote');
  assert.equal(r.data.rows[1].company, 'Birch\nLegal', 'a newline inside quotes did not end the row');
  assert.equal(r.data.rows[1].phone, '0100 555 0102', 'the row after a quoted newline is still aligned');
});

test('blank rows are ignored, counted, and shown to him', () => {
  reset();
  const csv = 'company,phone\n\nStone Roofing,0100 555 0101\n   ,\n\nBirch Legal,0100 555 0102\n,,,\n';
  const r = A.calParseCsv(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.rows.length, 2, 'only the two real leads are ready to import');
  assert.ok(r.data.blank >= 2, 'the blank lines were counted, not forgotten');
  const html = A.calPreviewHTML(r.data, { list: CALLERS() });
  assert.match(html, /blank line/, 'the preview says how many blank lines were ignored');
});

test('a row with no phone and no email is kept back as bad, with its line number and reason', () => {
  reset();
  const csv = [
    'company,name,phone,email',
    'Stone Roofing,Steve,0100 555 0101,steve@stone.example',
    'No Phone Ltd,Hana,,',                       // line 3: nothing to ring at all
    'Short Ltd,Omar,123,',                       // line 4: too short to dial
    ',,0100 555 0104,',                          // line 5: no company, no name — but dialable
    'Bad Mail Ltd,Sara,,sara@@nope',             // line 6: a broken email and no phone
  ].join('\n');
  const r = A.calParseCsv(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.bad.length, 3, 'the three duds are counted, not dropped in silence');
  assert.deepEqual(plain(r.data.bad).map((b) => b.line), [3, 4, 6], 'the line numbers point at the file he can open');
  assert.match(r.data.bad[0].why, /No phone number and no email/);
  assert.match(r.data.bad[1].why, /too short to dial/);
  assert.match(r.data.bad[2].why, /email address looks wrong/);
  assert.equal(r.data.total, 5, 'the total counts every row read, good or bad');

  /* A number with nobody's name against it is still worth dialling, so it is kept on purpose
     (callers.js says so in a comment). It must still arrive with its empty fields, not undefined. */
  assert.equal(r.data.rows.length, 2);
  assert.deepEqual(plain(r.data.rows[1]), { company: '', name: '', phone: '0100 555 0104', email: '', timezone: '', notes: '' });

  // and every dud is on screen, with its reason
  const html = A.calPreviewHTML(r.data, { list: CALLERS() });
  assert.match(html, /3 rows I would skip/);
  assert.match(html, /Line 3: No phone number and no email/);
  assert.match(html, /Line 6: That email address looks wrong/);
  assert.match(html, /<b>2 leads<\/b> ready to import, 3 that look wrong/);
});

test('a duplicate phone is carried through to the database, which is the one that can know', () => {
  reset();
  const csv = 'company,phone\nStone Roofing,0100 555 0101\nStone Roofing (again),0100 555 0101\n';
  const r = A.calParseCsv(csv);
  assert.equal(r.ok, true, r.error || '');
  /* The browser cannot tell a duplicate from a second site on the same switchboard, and it cannot
     see what is already in `leads`. Both rows go, and leads_import reports `skipped` — which the
     done panel then shows. What must NOT happen is one of them vanishing with nothing said. */
  assert.equal(r.data.rows.length, 2, 'neither row is dropped in the browser');
  assert.equal(r.data.bad.length, 0);
  const done = A.calImportDoneHTML({ added: 1, skipped: 1, assigned: 1 }, { batch: 'Egypt list' });
  assert.match(done, /1 skipped as already in Aviance/, 'what the database skipped is shown to him');
  const none = A.calImportDoneHTML({ added: 0, skipped: 2, assigned: 0 }, {});
  assert.match(none, /Nothing new went in/, 'an import that added nothing says so plainly');
});

test('a row with more columns than the header, and one with fewer, are both read', () => {
  reset();
  const csv = [
    'company,name,phone',
    'Stone Roofing,Steve,0100 555 0101,extra,more,"and, more"',   // longer than the header
    'Birch Legal,Hana',                                            // shorter: no phone column at all
    'Oak Dental,Omar,0100 555 0103',
  ].join('\n');
  const r = A.calParseCsv(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.rows.length, 2, 'the long row is fine; the short one has nothing to ring');
  assert.equal(r.data.rows[0].phone, '0100 555 0101', 'the extra cells did not shift the mapped ones');
  assert.equal(r.data.rows[0].name, 'Steve');
  assert.equal(r.data.bad.length, 1);
  assert.equal(r.data.bad[0].line, 3);
  assert.match(r.data.bad[0].why, /No phone number and no email/);
});

test('extra columns are ignored by name and he is told which ones', () => {
  reset();
  const csv = 'company,phone,linkedin,employees,source\nStone Roofing,0100 555 0101,http://x,12,apollo\n';
  const r = A.calParseCsv(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.rows.length, 1);
  assert.deepEqual(plain(r.data.extra), ['linkedin', 'employees', 'source']);
  assert.match(A.calPreviewHTML(r.data, { list: [] }), /Ignored: linkedin, employees, source/);
});

test('2,000 rows parse, and the cap past that keeps what it read and says what it left', () => {
  reset();
  const lines = ['company,name,phone,notes'];
  for (let i = 0; i < 2000; i++) lines.push(`Company ${i},Person ${i},0100 555 ${String(1000 + i)},note ${i}`);
  const big = lines.join('\r\n');
  const t0 = Date.now();
  const r = A.calParseCsv(big);
  assert.ok(Date.now() - t0 < 4000, 'two thousand rows parse quickly enough to feel instant');
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.rows.length, 2000, 'every one of the 2,000 is ready');
  assert.equal(r.data.bad.length, 0);
  assert.equal(r.data.over, 0);
  assert.equal(r.data.rows[1999].company, 'Company 1999', 'the last row is intact');

  // the same file read with a smaller cap: what is past it is counted and named
  const capped = A.calParseCsv(big, 500);
  assert.equal(capped.data.rows.length, 500);
  assert.equal(capped.data.over, 1500, 'he is told exactly how many were not read');
  assert.match(A.calPreviewHTML(capped.data, { list: CALLERS() }), /1500 more are past the limit/);

  // the split across the three callers who can be given work adds up to the row count, remainder first
  const plan = A.calSplitPlan(2000, CALLERS());
  assert.equal(plan.length, 3, 'every caller who is not revoked gets leads, as the database does it');
  assert.equal(plan.reduce((s, p) => s + p.share, 0), 2000, 'the split loses nobody');
  const odd = A.calSplitPlan(7, CALLERS());
  assert.deepEqual(plain(odd).map((p) => p.share), [3, 2, 2], 'the remainder goes to the first callers');
  assert.equal(odd.reduce((s, p) => s + p.share, 0), 7);
});

test('a file with no headings we know, or with no way to ring anyone, is refused in plain words', () => {
  reset();
  const nothing = A.calParseCsv('');
  assert.equal(nothing.ok, false);
  assert.match(nothing.error, /empty/);

  const junk = A.calParseCsv('col1,col2\na,b\n');
  assert.equal(junk.ok, false);
  assert.match(junk.error, /none of the headings I know/);
  assert.match(junk.error, /company, name, phone, email, timezone and notes/, 'it says what to name them');

  const noPhone = A.calParseCsv('company,notes\nStone Roofing,hello\n');
  assert.equal(noPhone.ok, false);
  assert.match(noPhone.error, /no phone column and no email column/);
  assert.ok(!/[{}<>]|undefined|null|error:/i.test(noPhone.error), 'plain English, no jargon');
});

test('the file he picks is checked before it is read', () => {
  reset();
  assert.match(A.calFileProblem(null), /Pick a file first/);
  assert.match(A.calFileProblem({ name: 'leads.xlsx', size: 10 }), /Pick a CSV file/);
  assert.match(A.calFileProblem({ name: 'leads.csv', size: 20 * 1024 * 1024 }), /bigger than 8 MB/);
  assert.equal(A.calFileProblem({ name: 'leads.csv', size: 1000 }), '');
  assert.equal(A.calFileProblem({ name: 'LEADS.TXT', size: 1000 }), '', 'a .txt export is allowed too');
  // and the batch label is built from the file name plus the date, never blank
  assert.match(A.calBatchName('egypt_list.csv', new Date('2026-11-25T10:00:00')), /^egypt list — 2026-11-25$/);
  assert.match(A.calBatchName('', new Date('2026-11-25T10:00:00')), /^Leads 2026-11-25$/);
});

/* ═════════════════════════ 2. NOTHING LEAVES UNTIL IMPORT ═════════════════════════ */

test('picking, parsing and previewing a file sends NOTHING to the database', async () => {
  reset();
  rpcs.callers_list = () => ({ data: CALLERS(), error: null });
  rpcs.callers_board = () => ({ data: BOARD(), error: null });
  await A.calLoad(true);
  await A.calLoadBoard(true);
  const before = calls.length;

  const text = 'company,name,phone,notes\nStone Roofing,Steve,0100 555 0101,hello\nNo Phone,Hana,,\n';
  A.calUploadOpen();
  await A.calFileIn({ files: [{ name: 'egypt.csv', size: text.length, text: async () => text }] });

  assert.equal(A.cal.parsed.rows.length, 1, 'the file is parsed and held in the page');
  assert.equal(A.cal.parsed.bad.length, 1);
  assert.equal(calls.length, before, 'not one rpc and not one fetch happened while previewing');
  assert.ok(!calls.some((c) => c.rpc === 'leads_import'), 'leads_import was never called');

  // the inline "are you sure" is still not a send
  A.calAskImport();
  assert.equal(A.cal.ask, 'import:1');
  assert.equal(calls.length, before, 'asking him to confirm sends nothing either');
  assert.match(A.calPreviewHTML(A.cal.parsed, A.calCtx()), /Yes, import them/);

  // only now, when he presses Import
  rpcs.leads_import = (args) => ({ data: { added: args.p_rows.length, skipped: 0, assigned: 1 }, error: null });
  await A.calImportGo();
  const imp = calls.filter((c) => c.rpc === 'leads_import');
  assert.equal(imp.length, 1, 'exactly one import call');
  assert.equal(imp[0].args.p_rows.length, 1, 'only the good row was sent');
  assert.deepEqual(plain(imp[0].args.p_rows[0]), {
    company: 'Stone Roofing', name: 'Steve', phone: '0100 555 0101', email: '', timezone: '', notes: 'hello',
  });
  assert.ok(imp[0].args.p_batch, 'the batch label travels with it');
  assert.equal(A.cal.importDone.added, 1);
  assert.equal(A.cal.parsed, null, 'the parsed file is let go once it is in');

  // closing the panel instead drops the file without sending it
  reset();
  A.cal.parsed = { rows: [{ phone: '1' }], bad: [], blank: 0, total: 1, headers: ['phone'], extra: [] };
  A.calUploadClose();
  assert.equal(A.cal.parsed, null);
  assert.equal(A.cal.up, false);
  assert.ok(!calls.some((c) => c.rpc));
});

test('Import is refused with nothing good to send, and a huge list is refused before the call', async () => {
  reset();
  const none = await A.calImport([], 'batch');
  assert.equal(none.ok, false);
  assert.match(none.error, /no good rows/i);
  assert.ok(!calls.some((c) => c.rpc === 'leads_import'));

  const toomany = await A.calImport(new Array(A.CAL_MAX_ROWS + 1).fill({ phone: '0100 555 0101' }), 'b');
  assert.equal(toomany.ok, false);
  assert.match(toomany.error, /Split the file/);
  assert.ok(!calls.some((c) => c.rpc === 'leads_import'), 'nothing that big is ever sent');
});

/* ═════════════════════════ 3. THE MONEY COLUMN ═════════════════════════ */

test('the money is the bonus per meeting that showed plus 2% of the closed deal', () => {
  reset();
  // the database sends no `owed`, so we work it out: 3 showed x $25 + 2% of $1,500 = $105
  const r = A.calStatRow({ caller_id: 'c1', name: 'Nour', dials: 60, conversations: 14, booked: 4, showed: 3, closed: 1, closed_value: 1500 }, 25);
  assert.equal(r.showed, 3);
  assert.equal(r.closedValue, 1500);
  assert.equal(r.owed, 3 * 25 + 1500 * 0.02);
  assert.equal(r.owed, 105);
  assert.equal(A.calMoney(r.owed), '$105');

  // a different bonus from biz_settings is used, not the default
  assert.equal(A.calStatRow({ showed: 4, closed_value: 0 }, 40).owed, 160);
  // the database's own figure wins over our arithmetic, so his money never depends on this file
  assert.equal(A.calStatRow({ showed: 3, closed_value: 1500, owed: 99.5 }, 25).owed, 99.5);
  assert.equal(A.calStatRow({ showed: 3, closed_value: 1500, owed_cents: 12345 }, 25).owed, 123.45);
  // and a nonsense figure never shows as a negative debt
  assert.equal(A.calStatRow({ showed: -5, closed_value: -100, owed: -7 }, 25).owed, 0);

  assert.equal(A.CAL_DEAL_CUT, 0.02, 'the 2% is the 2% the spec promised');
  assert.equal(A.CAL_BONUS_DEFAULT, 25);
});

test('the zero states read as honest zeros, not as a blank or a dash', () => {
  reset();
  const quiet = A.calStatRow({ caller_id: 'c2', name: 'Mariam', status: 'active' }, 25);
  assert.equal(quiet.dials, 0);
  assert.equal(quiet.owed, 0);
  const row = A.calBoardRowHTML(quiet, {});
  assert.match(row, /\$0/, 'nothing owed shows as $0');
  assert.match(row, /class="cal-r quiet"/, 'a caller who has not dialled is marked quiet, not hidden');
  assert.match(row, />—</, 'booked-per-dial with no dials is a dash, not a division by zero');
  assert.equal(A.calRate(0, 0), '—');
  assert.equal(A.calRate(4, 60), '6.7%');
  assert.equal(A.calRate(0, 60), '0%');

  // the whole board with nobody producing still adds up, and the strip shows $0 twice
  const board = A.calBoardShape({ bonus: 25, callers: [{ caller_id: 'c2', name: 'Mariam', status: 'active' }], feed: [] });
  assert.equal(A.calTotals(board).owed, 0);
  const strip = A.calStripHTML(board, board);
  assert.match(strip, /Bonus owed/);
  assert.match(strip, /\$0/);
  // and an empty board invites the one useful next step instead of saying "no data"
  const blank = A.calBoardHTML({ callers: [] }, { range: 'day' });
  assert.match(blank, /No calls today/);
  assert.match(blank, /Add a caller/);
  assert.match(A.calBoardHTML({ callers: [] }, { range: 'week' }), /No calls this week/);
});

test('money is written the way he reads it, pennies only when they matter', () => {
  reset();
  assert.equal(A.calMoney(0), '$0');
  assert.equal(A.calMoney(25), '$25');
  assert.equal(A.calMoney(1240), '$1,240');
  assert.equal(A.calMoney(1240.5), '$1,240.50');
  assert.equal(A.calMoney(1234567.89), '$1,234,567.89');
  assert.equal(A.calMoney(30 + 0.02 * 1500), '$60');
  assert.equal(A.calMoney('nonsense'), '$0', 'a bad figure is $0, never NaN on his screen');
  assert.equal(A.calMoney(null), '$0');
  assert.equal(A.calMoney(-12.5), '-$12.50');
});

test('the totals row and the strip add the columns up, and the board sorts by who is dialling', () => {
  reset();
  const board = A.calBoardShape(BOARD());
  assert.equal(board.callers[0].name, 'Nour', 'the busiest caller is first');
  const t = A.calTotals(board);
  assert.equal(t.dials, 60);
  assert.equal(t.booked, 4);
  assert.equal(t.showed, 3);
  assert.equal(t.owed, 105);
  assert.equal(t.callers, 2);
  const html = A.calBoardHTML(board, { range: 'day' });
  assert.match(html, /All 2 callers/);
  assert.match(html, /\$105/);
  assert.match(html, /\$25\s*\n?\s*a meeting that showed up, plus 2% of a closed deal/, 'the rule is spelled out under the table');
});

/* ═════════════════════════ 4. ESCAPING ═════════════════════════ */

test("every lead field and every caller name is escaped — the CSV came from a stranger", () => {
  reset();
  const lead = { company: NASTY, name: 'Steve <img src=x onerror=alert(1)>', phone: '"><script>x</script>', email: 'a"b@x.example', timezone: '<tz>', notes: '<script>alert(1)</script> & "quoted"' };
  const prevRow = A.calPreviewRowHTML(lead);
  assert.doesNotMatch(prevRow, /<script>/, 'no script tag survives the preview');
  assert.doesNotMatch(prevRow, /<img/);
  assert.match(prevRow, /Stone &quot;Steve&quot; &lt;b&gt;/);
  assert.match(prevRow, /&lt;tz&gt;/);

  const parsed = { rows: [lead], bad: [{ line: 2, why: 'That phone number is too short to dial', company: '', name: '<script>x</script>' }], blank: 0, total: 2, headers: ['company', 'name', 'phone'], extra: ['<b>odd</b>'] };
  const prev = A.calPreviewHTML(parsed, { list: CALLERS(), batch: '<b>batch</b>' });
  assert.doesNotMatch(prev, /<script>/, 'not in the bad-row list either');
  assert.doesNotMatch(prev, /<b>batch<\/b>/, 'nor in the batch box he typed into');
  assert.doesNotMatch(prev, /<b>odd<\/b>/, 'nor in an ignored column name');
  assert.match(A.calBadRowHTML(parsed.bad[0]), /&lt;script&gt;/);

  // the notes field reaches the page through the preview table and the feed
  const feed = A.calFeedHTML(A.calBoardShape(BOARD()).feed, {});
  assert.doesNotMatch(feed, /<b>Thursday<\/b>/, 'a note from the caller is escaped in the feed');
  assert.match(feed, /wants &lt;b&gt;Thursday&lt;\/b&gt;/);
  assert.match(feed, /Stone &quot;Steve&quot; &lt;b&gt;/);

  // the caller's own name, everywhere it appears
  const board = A.calBoardShape({ bonus: 25, callers: [{ caller_id: 'c1', name: '<script>alert(1)</script>', status: 'active', dials: 1 }], feed: [] });
  const row = A.calBoardRowHTML(board.callers[0], {});
  assert.doesNotMatch(row, /<script>/);
  assert.match(row, /&lt;script&gt;/);
  assert.doesNotMatch(A.calCodeHTML('AVX-1', { name: '"><script>x</script>' }), /<script>/);
  assert.doesNotMatch(A.calAskHTML('revoke:c1', { id: 'c1', name: '<script>x</script>' }), /<script>/);
  assert.doesNotMatch(A.calAddFormHTML({ addName: '"><script>x</script>', addEmail: '<b>e</b>', addErr: '<i>no</i>' }), /<script>|<b>e<\/b>|<i>no<\/i>/);

  // an id that reaches an onclick goes through calA(), so a quote cannot break out
  const dodgy = A.calBoardRowHTML({ id: `c1","x`, name: 'x', dials: 0 }, {});
  assert.doesNotMatch(dodgy, /onclick="cal\w+\('c1","x'\)"/);
  assert.match(A.calA(`c1","x`), /^&quot;/, 'ids are JSON-quoted and then escaped');
});

test('a lead field the owner never sees is still escaped in the whole screen', async () => {
  reset();
  const board = BOARD();
  board.callers[0].name = '<script>alert(1)</script>';
  rpcs.callers_list = () => ({ data: CALLERS(), error: null });
  rpcs.callers_board = () => ({ data: board, error: null });
  await A.calLoad(true);
  await A.calLoadBoard(true);
  const screen = A.calScreenHTML(A.calCtx());
  assert.doesNotMatch(screen, /<script>alert\(1\)<\/script>/, "a name out of the database is escaped on the whole screen");
  assert.match(screen, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(screen, /<b>Thursday<\/b>/, 'and so is the note in the feed under it');
});

/* ═════════════════════════ 5. THE ACCESS CODE ═════════════════════════ */

test('the code is shown once, is copyable, and is gone from state when the panel closes', async () => {
  reset();
  rpcs.callers_list = () => ({ data: CALLERS(), error: null });
  await A.calLoad(true);

  await A.calCodeGo('c1');
  assert.deepEqual(plain(A.cal.code), { staffId: 'c1', code: 'AVX-4K7M-Q2ZP' });
  const html = A.calCodeHTML(A.cal.code.code, { id: 'c1', name: 'Nour' });
  assert.match(html, /AVX-4K7M-Q2ZP/, 'it really is on screen');
  assert.match(html, /shown once and will not be shown again/);
  assert.match(html, /onclick="calCopyCode\(\)"/, 'there is a copy button');
  assert.match(html, /aviance\.store\/callers/, 'and it says where she signs in');

  // the copy button uses the clipboard and never puts the code in the toast
  let copied = null;
  sandbox.navigator = { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } };
  A.calCopyCode();
  await tick();
  assert.equal(copied, 'AVX-4K7M-Q2ZP');
  assert.ok(toasts.length, 'he is told it worked');
  assert.ok(!toasts.some((t) => String(t).indexOf('AVX-4K7M-Q2ZP') >= 0), 'the code itself is never in a toast');
  sandbox.navigator = {};

  // closing it drops the code
  A.calCodeHide();
  assert.equal(A.cal.code, null);
  assert.equal(A.calCodeHTML(null, { name: 'Nour' }), '', 'and nothing is drawn with no code');
  assert.doesNotMatch(A.calScreenHTML(A.calCtx()), /AVX-4K7M-Q2ZP/, 'it is nowhere on the screen afterwards');

  // leaving the screen and signing out drop it too
  await A.calCodeGo('c1');
  assert.ok(A.cal.code);
  A.calOnRender('clients');
  assert.equal(A.cal.code, null, 'walking away from the screen drops it');
  await A.calCodeGo('c1');
  A.callersForget();
  assert.equal(A.cal.code, null, 'and so does signing out');
  assert.equal(A.cal.list.length, 0);
  assert.equal(A.cal.parsed, null);
  assert.equal(A.cal.timer, null, 'nothing is left ticking');
});

test('the code POST carries only {staff_id}, his bearer token and the key — nothing else', async () => {
  reset();
  await A.calCodeGo('c1');
  const posts = calls.filter((c) => c.fetch);
  assert.equal(posts.length, 1);
  assert.match(posts[0].fetch, /\/functions\/v1\/staff-code$/);
  assert.equal(posts[0].opts.method, 'POST');
  assert.equal(posts[0].opts.headers.Authorization, 'Bearer owner-jwt');
  assert.equal(posts[0].opts.headers.apikey, 'sb_publishable_test');
  assert.deepEqual(JSON.parse(posts[0].opts.body), { staff_id: 'c1' }, 'the body is the staff id and nothing more');
  assert.ok(!/code|password/i.test(posts[0].opts.body), 'no code and no password is ever sent up');
});

test('the code failing says what to do, and tells him plainly when the function is not deployed', async () => {
  reset();
  fetchAnswer = { ok: false, status: 404, json: async () => ({}) };
  let r = await A.calCode('c1');
  assert.equal(r.ok, false);
  assert.equal(r.error, A.CAL_CODE_NOT_READY);
  assert.equal(r.missing, true);

  fetchAnswer = { ok: false, status: 401, json: async () => ({}) };
  r = await A.calCode('c1');
  assert.match(r.error, /sign-in has run out/);

  fetchAnswer = { ok: false, status: 403, json: async () => ({}) };
  r = await A.calCode('c1');
  assert.match(r.error, /don't have access/);

  fetchAnswer = new Error('Failed to fetch');
  r = await A.calCode('c1');
  assert.match(r.error, /Can't reach Aviance/);

  r = await A.calCode('');
  assert.match(r.error, /Pick a caller first/);
  assert.ok(!calls.some((c) => c.fetch && /staff-code/.test(c.fetch) && JSON.parse(c.opts.body).staff_id === ''),
    'no id, no call');

  // a failure leaves no half-code lying around
  reset();
  fetchAnswer = { ok: true, status: 200, json: async () => ({ ok: false, error: 'nope' }) };
  await A.calCodeGo('c1');
  assert.equal(A.cal.code, null);
  assert.ok(A.cal.codeErr);
});

/* ═════════════════════════ 6. DEGRADING BEFORE THE MIGRATION ═════════════════════════ */

test("before the migration the screen says 'not switched on yet' and stops polling", async () => {
  reset();
  const notThere = { message: 'Could not find the function public.callers_list in the schema cache', code: 'PGRST202' };
  rpcs.callers_list = () => ({ data: null, error: notThere });
  rpcs.callers_board = () => ({ data: null, error: notThere });
  assert.equal(A.calMissing(notThere), true);
  assert.equal(A.calPlain(notThere, 'fallback'), A.CAL_NOT_READY);

  A.calStart();
  assert.ok(A.cal.timer, 'it was polling');
  await A.calLoad(true);
  await A.calLoadBoard(true);

  assert.equal(A.cal.missing, true);
  assert.equal(A.cal.loaded, false);
  assert.equal(A.cal.timer, null, 'it stopped asking a question the database cannot answer');
  const body = A.calBodyHTML();
  assert.match(body, /Not switched on yet/);
  assert.match(body, /Once the database update is applied/);
  assert.doesNotMatch(body, /PGRST202|schema cache|function public/, 'he is never shown the raw error');
  assert.doesNotMatch(body, /Try again/, 'and is not asked to retry something that cannot work yet');

  // the feed and the board say the same thing rather than looking broken
  assert.match(A.calFeedHTML([], { boardMissing: true }), /isn't switched on yet/);
  assert.match(A.calBoardHTML(null, { boardErr: A.CAL_NOT_READY, boardMissing: true }), /Not switched on yet/);

  // an import before the migration is a plain sentence, not a stack trace
  rpcs.leads_import = () => ({ data: null, error: notThere });
  const imp = await A.calImport([{ company: 'Stone', phone: '0100 555 0101' }], 'b');
  assert.equal(imp.ok, false);
  assert.equal(imp.error, A.CAL_IMPORT_NOT_READY);
  assert.equal(imp.missing, true);

  // and the other outages each get their own sentence
  assert.match(A.calPlain({ message: 'Failed to fetch' }, 'f'), /Check your connection/);
  assert.match(A.calPlain({ code: 'PGRST301', message: 'JWT expired' }, 'f'), /sign-in has run out/);
  assert.match(A.calPlain({ code: '42501', message: 'permission denied for table leads' }, 'f'), /don't have access/);
  assert.equal(A.calPlain({ code: 'P0001', message: 'That time has gone.' }, 'f'), 'That time has gone.');
});

test('a real failure (not a missing migration) offers Try again and keeps the screen', async () => {
  reset();
  rpcs.callers_list = () => ({ data: null, error: { message: 'boom', code: '08006' } });
  await A.calLoad(true);
  assert.equal(A.cal.missing, false);
  const body = A.calBodyHTML();
  assert.match(body, /didn’t load/);
  assert.match(body, /onclick="calLoadAll\(true\)"/);
  assert.doesNotMatch(body, /boom/, 'the database\'s own words are not put in front of him');
});

/* ═════════════════════════ 7. THE REST OF THE SCREEN ═════════════════════════ */

test('only the owner polls, and the seven outcomes are exactly the seven', () => {
  reset();
  assert.equal(A.calIsOwner(), true);
  reset({ role: 'staff' });
  assert.equal(A.calIsOwner(), false);
  A.calTick();
  assert.equal(A.cal.timer, null, 'a non-owner never starts the poll');

  const keys = Object.keys(A.CAL_OUTCOMES);
  assert.deepEqual(keys.slice().sort(), ['bad_fit', 'booked', 'callback', 'no_answer', 'not_interested', 'voicemail', 'wrong_number']);
  assert.equal(keys.length, 7);
  keys.forEach((k) => assert.ok(A.calOutcomeLabel(k) && A.calOutcomeLabel(k) !== 'Logged', k + ' has a word of its own'));
  assert.equal(A.calOutcomeLabel('made_up'), 'Logged', 'anything else is not invented into a label');
  // "talked" is the four that mean a human answered
  assert.deepEqual(plain(A.CAL_TALKED).slice().sort(), ['bad_fit', 'booked', 'callback', 'not_interested']);
  assert.equal(A.calIsTalk('no_answer'), false);
  assert.equal(A.calIsTalk('booked'), true);
});

test('Add a caller checks the name and email here, before anything is sent', async () => {
  reset();
  assert.match(A.calNameProblem(''), /Type her name/);
  assert.match(A.calNameProblem('N'), /too short/);
  assert.match(A.calNameProblem('x'.repeat(81)), /under 80/);
  assert.equal(A.calNameProblem('Nour Hassan'), '');
  assert.match(A.calEmailProblem(''), /Type her email/);
  assert.match(A.calEmailProblem('nour@'), /doesn't look like an email/);
  assert.equal(A.calEmailProblem('nour@example.com'), '');

  const bad = await A.calAdd('N', 'nour@example.com');
  assert.equal(bad.ok, false);
  assert.ok(!calls.some((c) => c.rpc === 'caller_add'), 'a bad form never reaches the database');

  rpcs.caller_add = () => ({ data: { staff_id: 'c9' }, error: null });
  const ok = await A.calAdd('Nour Hassan', '  NOUR@Example.COM ');
  assert.equal(ok.ok, true);
  const sent = calls.filter((c) => c.rpc === 'caller_add')[0];
  assert.deepEqual(plain(sent.args), { p_name: 'Nour Hassan', p_email: 'nour@example.com' }, 'trimmed and lower-cased');

  // and a status change is one of three words only
  const nope = await A.calSetStatus('c1', 'deleted');
  assert.equal(nope.ok, false);
  assert.ok(!calls.some((c) => c.rpc === 'caller_set_status'));
  rpcs.caller_set_status = () => ({ data: true, error: null });
  assert.equal((await A.calSetStatus('c1', 'revoked')).ok, true);
});

test('the feed, the day/week switch and the empty states all behave', async () => {
  reset();
  const board = A.calBoardShape(BOARD());
  assert.equal(board.feed.length, 2);
  const feed = A.calFeedHTML(board.feed, {});
  assert.match(feed, /Booked a meeting/);
  assert.match(feed, /No answer/);
  assert.match(feed, /Nour → Stone/);
  assert.match(A.calFeedHTML([], {}), /Nothing logged yet/);
  // the feed never grows past the last fifty
  const many = A.calBoardShape({ callers: [], feed: new Array(120).fill({ id: 'f', outcome: 'no_answer' }) });
  assert.equal(many.feed.length, A.CAL_FEED_MAX);

  A.calSetRange('week');
  assert.equal(A.cal.range, 'week');
  assert.equal(A.calRangeWord('week'), 'this week');
  A.calSetRange('nonsense');
  assert.equal(A.cal.range, 'day', 'anything that is not the week is today');
  assert.match(A.calSwitchHTML({ range: 'day' }), /class="cal-seg on"[^>]*onclick="calSetRange\(&quot;day&quot;\)"/);

  // a board that arrives as a bare array, or as nonsense, does not break the screen
  assert.equal(A.calBoardShape([{ caller_id: 'c1', name: 'Nour', dials: 2 }]).callers.length, 1);
  assert.equal(A.calBoardShape(null).callers.length, 0);
  assert.equal(A.calBoardShape({ callers: 'not an array' }).callers.length, 0);
  assert.equal(A.calBoardShape({}).bonus, A.CAL_BONUS_DEFAULT, 'with no bonus from the database we use the default');
});

test('the upload panel tells him the rules before he picks, and warns when there is no caller', () => {
  reset();
  const shut = A.calUploadHTML({ up: false });
  assert.match(shut, /Upload leads/);
  const open = A.calUploadHTML({ up: true });
  assert.match(open, /company, name, phone, email, timezone, notes/);
  assert.match(open, /in any order/);
  assert.match(open, /Nothing is sent until you press Import/);
  assert.match(open, /accept="\.csv,\.txt,\.tsv,text\/csv"/);

  // no caller at all: say where the leads will land rather than failing
  const warn = A.calSplitHTML([], 40);
  assert.match(warn, /No caller has been added yet/);
  assert.match(warn, /40 leads/);
  const split = A.calSplitHTML(A.calSplitPlan(40, CALLERS()), 40);
  assert.match(split, /<b>14<\/b> · Mariam <b>13<\/b> · Yasmin <b>13<\/b>/,
    'all three who can be given work share the forty, the remainder to the first');
  assert.doesNotMatch(split, /<script>/, "and her name is escaped where it is shown");
  // the done panel after an import with nobody to hand them to
  assert.match(A.calImportDoneHTML({ added: 10, skipped: 0, assigned: 0 }, {}), /waiting unassigned/);
});

/* ═════════════════════════ 8. WHAT THE BROWSER PROMISES vs WHAT THE DATABASE DOES ═════════════════════════
   These pin the browser's half of the contract with `leads_import` (20261126_callers.sql). Where the two
   disagree the preview over-promises: the row is sent, the database skips it, and the done panel blames
   "already in Aviance". Both gaps are in the report for the lead. */

test('the rows the browser would send are exactly the shape leads_import reads', async () => {
  reset();
  const csv = 'company,name,phone,email,timezone,notes\n'
    + 'Stone Roofing,Steve,0100 555 0101,steve@stone.example,Africa/Cairo,hello\n'
    + ',,0100 555 0104,,,\n';                     // no company: the database will skip this one
  const p = A.calParseCsv(csv);
  rpcs.leads_import = (args) => ({ data: { added: 1, skipped: 1, assigned: 1 }, error: null });
  const r = await A.calImport(p.data.rows, 'Egypt list');
  assert.equal(r.ok, true);
  const sent = calls.filter((c) => c.rpc === 'leads_import')[0];
  // the six keys leads_import reads out of each row, and no others
  sent.args.p_rows.forEach((row) => assert.deepEqual(Object.keys(plain(row)).slice().sort(),
    ['company', 'email', 'name', 'notes', 'phone', 'timezone']));
  assert.equal(sent.args.p_batch, 'Egypt list');
  // KNOWN GAP 1: the browser sends the company-less row; leads_import skips it (company is required there)
  assert.equal(sent.args.p_rows.length, 2, 'the browser sends both rows');
  assert.equal(sent.args.p_rows[1].company, '', 'one of them has no company at all');
  // whatever the database decides, his screen reports its numbers and not the browser's
  assert.equal(r.data.added, 1);
  assert.equal(r.data.skipped, 1);
});

test('the split shown before Import matches what leads_import actually does', () => {
  reset();
  /* The preview and leads_import must agree on who can be given work: 'new', 'invited' and
     'active'. A caller who holds her code but has not signed in yet is 'invited', and the
     server does hand her leads, so the preview has to say so. */
  const list = [
    { id: 'c1', name: 'Nour', status: 'active' },
    { id: 'c2', name: 'Mariam', status: 'invited' },
    { id: 'c3', name: 'Yasmin', status: 'revoked' },
  ];
  const plan = A.calSplitPlan(10, list);
  assert.deepEqual(plain(plan), [
    { id: 'c1', name: 'Nour', share: 5 },
    { id: 'c2', name: 'Mariam', share: 5 },
  ]);
  assert.match(A.calSplitHTML(plan, 10), /Nour <b>5<\/b>/);
  // a revoked caller never appears in a split, whatever else changes
  assert.ok(!plan.some((p) => p.id === 'c3'));
  assert.deepEqual(plain(A.calSplitPlan(10, null)), []);
  assert.deepEqual(plain(A.calSplitPlan(0, list)).map((p) => p.share), [0, 0]);

  // one caller is the normal case at the start: no talk of splitting, and her name is on it
  const alone = A.calSplitPlan(30, [{ id: 'c9', name: 'Vera', status: 'invited' }]);
  assert.deepEqual(plain(alone), [{ id: 'c9', name: 'Vera', share: 30 }]);
  const html = A.calSplitHTML(alone, 30);
  assert.match(html, /All 30 leads go to Vera\./);
  assert.ok(!/will split/i.test(html), 'with one caller he is never told about a split');
});

/* ═════════════════════════ 10. THE ONE-CLICK INVITE LINK ═════════════════════════
   One URL he can send her on WhatsApp. She taps it and lands on her calling screen,
   signed in: no email to type, no code to copy. The token is shown here once and
   only its hash is kept, exactly like the access code. */

test('a link is made from the token the database hands back, on our own domain', async () => {
  reset();
  rpcs.staff_link_new = (args) => {
    assert.deepEqual(plain(args), { p_staff: 'c1', p_days: 14 }, 'fourteen days, and the caller it is for');
    return { data: { ok: true, token: 'tok+en/with==junk', expires_at: '2026-12-09T00:00:00Z' }, error: null };
  };
  const r = await A.calLinkNew('c1');
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.url, 'https://aviance.store/go?k=tok%2Ben%2Fwith%3D%3Djunk',
    'the token is escaped, and the link is an aviance.store one');
  assert.equal(r.data.url.indexOf('supabase'), -1, 'she is never sent to a Supabase address');
  assert.equal(A.CAL_LINK_BASE, 'https://aviance.store/go?k=');

  // no caller, no link
  assert.equal((await A.calLinkNew('')).ok, false);
  // a reply with no token in it is a failure, not a broken link
  rpcs.staff_link_new = () => ({ data: { ok: true }, error: null });
  const empty = await A.calLinkNew('c1');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /could not make a link/);
});

test('the link panel shows it once, says what it is, and is dropped on sign-out', async () => {
  reset();
  rpcs.staff_link_new = () => ({ data: { ok: true, token: 'abc123' }, error: null });
  rpcs.callers_list = () => ({ data: CALLERS(), error: null });
  await A.calLinkGo('c1');
  assert.equal(A.cal.link.url, 'https://aviance.store/go?k=abc123');

  const html = A.calLinkHTML(A.cal.link.url, { name: NASTY });
  assert.match(html, /https:\/\/aviance\.store\/go\?k=abc123/);
  assert.match(html, /shown once and will not be shown again/);
  assert.match(html, /14 days/, 'he is told it runs out');
  assert.match(html, /send it to her and nobody\s+else/, 'and that it is a key, not a page');
  assert.doesNotMatch(html, /<script>/, "a caller's name is escaped here like everywhere else");
  assert.match(html, /already signed in/, 'what she gets is spelled out');

  // it never lingers: his own "done" button and a sign-out both clear it
  A.calLinkHide();
  assert.equal(A.cal.link, null);
  A.cal.link = { staffId: 'c1', url: 'https://aviance.store/go?k=abc123' };
  A.callersForget();
  assert.equal(A.cal.link, null, 'a sign-out leaves no link on screen');
  assert.equal(A.calLinkHTML('', { name: 'Nour' }), '', 'and with no link there is no panel');
});

test('a refused link says why, and leaves nothing half-shown', async () => {
  reset();
  /* a plpgsql `raise exception` arrives with code P0001, and its words are shown as they are */
  rpcs.staff_link_new = () => ({ data: null, error: { code: 'P0001', message: 'Only the owner can make an invite link.' } });
  await A.calLinkGo('c1');
  assert.equal(A.cal.link, null);
  assert.match(String(A.cal.codeErr), /owner/);
  assert.ok(toasts.some((t) => /owner/.test(String(t))), 'he is told out loud, not just in the panel');
});

