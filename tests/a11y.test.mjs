/* Can this be worked without a mouse, and heard by a screen reader?
   Three kinds of test here, and each one is meant to fail loudly if somebody
   takes the thing back out:
     1. every control has an accessible name, and the fields have real labels;
     2. focus goes somewhere sensible when a panel opens, and comes BACK to
        where it was when it closes;
     3. the colour pairs the design system actually uses are measured against
        WCAG AA, from the hex values — never judged by eye.
   Run with: npm test. No browser, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');
const brand = read('brand.css');
const portalHtml = read('portal.html');
const portalCss = read('portal-client.css');

/* ───────────────────────── contrast, measured ─────────────────────────
   WCAG 2.1 relative luminance, then (lighter + .05) / (darker + .05).
   AA: 4.5 for body text, 3 for large text and for a control's own outline. */
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const INK = '#0A0A0C', PAPER = '#FFFFFF', MUTED = '#63636A', RED = '#C42408',
      RED_BRIGHT = '#E0290F', SAND = '#F4EFE9', MIST = '#F6F7F9', HUB_MUTED = '#5C5C5C';

test('contrast: every pair the client actually reads clears WCAG AA for body text', () => {
  const pairs = [
    ['muted grey on paper', MUTED, PAPER],
    ['muted grey on the sand band', MUTED, SAND],
    ['muted grey on mist', MUTED, MIST],
    ['the red on paper', RED, PAPER],
    ['the red on the sand band', RED, SAND],      // the "BEHIND" stamp and the figure
    ['paper on ink', PAPER, INK],                  // the black bands
    ['ink on the sand band', INK, SAND],
    ['ink on paper', INK, PAPER],
    ['the hub grey on paper', HUB_MUTED, PAPER],
    ['white on the red button', PAPER, RED_BRIGHT],
  ];
  for (const [what, fg, bg] of pairs) {
    const r = ratio(fg, bg);
    assert.ok(r >= 4.5, `${what}: ${fg} on ${bg} measures ${r.toFixed(2)}:1, under AA's 4.5`);
  }
});

test('contrast: red as TEXT on a dark ground is the bright red, because #E0290F is not AA there', () => {
  /* The measurement that forced the rule — if somebody "simplifies" the dark
     block back to one red, this says why they must not. */
  assert.ok(ratio(RED_BRIGHT, '#101015') < 4.5, '#E0290F on the dark surface is NOT AA');
  assert.ok(ratio(RED_BRIGHT, '#1C1C22') < 4.5, '#E0290F on the darker surface is NOT AA');
  assert.ok(ratio('#FF5C3D', '#101015') >= 4.5, 'the bright red IS AA on the dark surface');
  assert.ok(/--red-bright:#FF5C3D/.test(brand), 'the bright red is still a token');
  const block = brand.slice(brand.indexOf('body.dark :focus-visible'));
  for (const sel of ['body.dark a:hover', 'body.dark .section-head .count', 'body.dark .login-eyebrow', 'body.dark .tab.active'])
    assert.ok(block.includes(sel), sel + ' takes the bright red in the dark theme');
});

test('contrast: the focus ring is never red on red — every red-filled control takes white', () => {
  /* theme.css and polish.css both set the ring to --brand with !important, so
     brand.css has to shout back or the ring vanishes on its own two red grounds.

     This used to pin the exact selector line, which meant it passed while the bug was
     still there: the BASE rule had no !important, so it lost to theme.css, and only
     the few selectors listed with !important were ever really fixed. Four red buttons
     outside that list took a red ring on a red button — 1.0:1 against the control it
     was meant to mark. So this now pins the two things that actually matter. */

  /* 1. the base rule must win, or every control not named below silently goes red */
  assert.match(brand, /(^|\n):focus-visible\{outline:2px solid var\(--text\)!important/,
    'the base :focus-visible must carry !important or theme.css overrides it back to red');

  /* 2. every red-filled control is in the white-ring list. Add a red button to the
        system and add it here, or it gets an invisible ring. */
  const white = /([^\n]*(?:\n[^\n]*)*?):focus-visible\{outline:2px solid #fff!important/.exec(brand);
  assert.ok(white, 'the white-ring rule still exists');
  const list = brand.slice(0, brand.indexOf('{outline:2px solid #fff!important'));
  for (const sel of ['.btn:focus-visible', '.nav-item:focus-visible', '.pt-btn.primary:focus-visible',
                     '.chv-btn.primary:focus-visible', '.chv-send:focus-visible', '.tmc-btn:focus-visible'])
    assert.ok(list.includes(sel), sel + ' is a red-filled control and must take the white ring');

  assert.match(brand, /\.btn\.ghost:focus-visible,\.tb-btn:focus-visible\{outline:2px solid var\(--text\)!important/);
  assert.ok(ratio(PAPER, RED_BRIGHT) >= 3, 'white on the red ground clears the 3:1 a ring needs');
  assert.ok(ratio(INK, PAPER) >= 3, 'ink on paper clears it for the outline buttons');
});

test('the message box on Channels can show a focus ring', () => {
  /* It hides its own border and glow so it reads as part of the card around it, but it
     was hiding its focus ring too — keyboard-only there was nothing at all to say the
     caret was in the compose box. The :focus-visible case must not kill the outline. */
  const chv = read('channels.css');
  const line = chv.split('\n').find((l) => l.includes('.chv-cbox textarea:focus-visible'));
  assert.ok(line, 'the compose box still has its own :focus-visible rule');
  assert.ok(!/outline:\s*0/.test(line),
    'the compose box must not switch its focus ring off: ' + line.trim());
});

test('contrast: nothing important is carried by colour alone on the guarantee band', () => {
  const tracker = read('portal-tracker.js');
  /* "behind" is a word in a box, not a red tint a colour-blind client reads as fine */
  assert.match(tracker, /PCT_STAMP = \{ met: 'Guarantee met', ontrack: 'On track', behind: 'Behind', short: 'Refund due'/);
  assert.match(tracker, /class="pcg-stamp"/);
  assert.match(tracker, /pctStandingNote/);
  /* and the note under it says it in plain words too */
  assert.match(tracker, /We are behind our own pace/);
});

/* ───────────────────────── names and structure ───────────────────────── */

test('every field on the sign-in page has a label tied to it, and its error is tied to the field', () => {
  for (const id of ['loginEmail', 'loginPass', 'suName', 'suEmail', 'suPass', 'npw1', 'npw2']) {
    assert.ok(new RegExp(`<label for="${id}">`).test(html), `${id} has a <label for>`);
    assert.ok(new RegExp(`id="${id}"[^>]*aria-describedby="(login|su|npw)Err"`).test(html), `${id} points at its error line`);
  }
  for (const id of ['loginErr', 'suErr', 'npwErr'])
    assert.ok(new RegExp(`id="${id}"[^>]*role="alert"`).test(html), `${id} is announced when it fills`);
  /* no orphan <label> anywhere in the shell: a label with no control names nothing */
  const orphans = [...html.matchAll(/<label\b([^>]*)>([\s\S]{0,300}?)<\/label>/g)]
    .filter((m) => !/\bfor=/.test(m[1]) && !/<(input|select|textarea)/.test(m[2]));
  assert.deepEqual(orphans.map((m) => m[2].trim()), []);
});

test('every control in the shell has an accessible name, and none of them is a bare div', () => {
  /* the three that used to be divs with onclick, and so were invisible to Tab */
  assert.match(html, /<button type="button" class="search" onclick="openCmdk\(\)"[^>]*aria-label="/);
  assert.match(html, /class="cmdk-item [^"]*" id="cmdkOpt\$\{i\}" role="option" aria-selected=/);
  assert.match(html, /<button type="button" class="notif-item" onclick="runNotif\(\$\{i\}\)"/);
  assert.match(html, /<button type="button" class="forgot-link login-std"/);
  assert.ok(!/<a class="forgot-link/.test(html), 'the forgot link is a button, not an <a> with no href');
  /* nothing left in the shell that takes a click but no Tab */
  const divClicks = [...html.matchAll(/<(div|span|li|tr|td)\b([^>]*\bonclick=[^>]*)>/g)]
    .map((m) => m[0])
    .filter((s) => !/id="cmdkWrap"/.test(s))        // the backdrop: closing it is Escape's job
    .filter((s) => !/role="option"/.test(s));       // an option is not a Tab stop by design — the combobox drives it
  assert.deepEqual(divClicks, []);
  /* every icon-only button in the shell says what it is */
  for (const name of ['Sign out', 'Back', 'What needs you'])
    assert.ok(html.includes(`aria-label="${name}"`), `the ${name} button is named`);
});

test('things that change without a click are announced, not just drawn', () => {
  assert.match(html, /<div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true">/);
  assert.match(html, /<div id="liveSay" class="sr-only" role="status" aria-live="polite"/);
  assert.match(html, /function announce\(msg\)/);
  /* the bell's count: the number lives in the button's name, and a rise is spoken */
  assert.match(html, /attr\(document\.getElementById\('notifBtn'\),'aria-label',name\)/);
  assert.match(html, /n\.length>notifSaid\)announce\(name\)/);
  assert.match(html, /id="notifDot"[^>]*aria-hidden="true"/, 'the dot is decoration; the name carries the count');
  /* the team chat is a log, so a message that arrives is read out */
  assert.match(read('channels.js'), /id="chvThread"[^>]*role="log" aria-live="polite" aria-relevant="additions"/);
});

test('the finder is a dialog with a listbox, not a pile of divs', () => {
  assert.match(html, /<div class="cmdk" role="dialog" aria-modal="true" aria-label="/);
  assert.match(html, /id="cmdkInput"[^>]*role="combobox"[^>]*aria-controls="cmdkList"/);
  assert.match(html, /id="cmdkList" role="listbox"/);
  assert.match(html, /attr\(inp,'aria-activedescendant','cmdkOpt0'\)/);
});

test('a long list can be paged without a mouse', () => {
  /* the team chat used to say "scroll up" and mean it: no control, no keyboard */
  const ch = read('channels.js');
  assert.match(ch, /<button type="button" class="chv-link" onclick="chvLoadOlder\(\)">Load earlier messages<\/button>/);
  assert.ok(!/Scroll up for earlier messages/.test(ch));
});

test('the portal: the tab strip carries its own name, and the panels are reachable', () => {
  assert.match(portalHtml, /<div class="pc-tabs-in" role="tablist" aria-label="Your portal">/);
  /* roving tabindex and arrow keys, as a tablist should */
  assert.match(portalHtml, /role="tab"[\s\S]*?aria-controls="pcPanel-\$\{t\.key\}"[\s\S]*?aria-selected=[\s\S]*?tabindex=/);
  for (const k of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(portalHtml.includes(`e.key === '${k}'`), k + ' moves along the strip');
  /* a panel with nothing focusable in it is reachable itself, so its text can be read and scrolled */
  for (const k of ['campaign', 'calls']) assert.ok(new RegExp(`id="pcPanel-${k}" role="tabpanel" aria-labelledby="pcTab-${k}" tabindex="0"`).test(portalHtml), k + ' panel is reachable');
  assert.match(portalHtml, /id="pcThread" role="log" aria-live="polite"/);
  assert.match(portalHtml, /<label class="pc-sr" for="pcText">/);
  assert.match(portalHtml, /id="pcSendErr" role="alert"/);
  assert.match(portalHtml, /id="pcInErr" role="alert"/);
  assert.match(portalHtml, /id="pcInPw"[^>]*aria-describedby="pcInErr"/);
});

test('motion: a device that asks for less gets no animation, not just no transition', () => {
  for (const [name, css] of [['brand.css', brand], ['polish.css', read('polish.css')]]) {
    const block = /@media\(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n?\}\s*\n/.exec(css);
    assert.ok(block, name + ' has a reduced-motion block');
    assert.match(block[1], /animation:none!important/, name + ' stops animation too');
    assert.match(block[1], /transition:none!important/, name + ' stops transitions');
  }
  /* the floating things animate in; those are the ones that needed covering */
  for (const sel of ['.modal-wrap.open', '.cmdk-wrap.open', '.notif-pop.open'])
    assert.ok(html.includes(sel + '{'), sel + ' still exists, so the block above still matters');
});

test('tap targets: nothing a thumb must hit is under 44px on a phone', () => {
  /* the sizes are declared in the stylesheets; this reads them rather than guessing */
  assert.match(html, /\.tab\{[^}]*min-height:58px/);                 // the phone tab bar
  assert.match(html, /\.more-item\{[^}]*min-height:50px/);           // the More sheet
  assert.match(html, /\.back-btn\{[^}]*width:44px;height:44px/);
  assert.match(portalCss, /\.pc-btn\{[^}]*min-height:52px/);
  assert.match(portalCss, /\.pc-btn-quiet\{[^}]*min-height:44px/);
  assert.match(portalCss, /\.pc-input\{[^}]*min-height:52px/);
  assert.match(portalCss, /\.pc-check\{[^}]*min-height:44px/);
  assert.match(read('portal-tracker.js'), /\.pc-tab\{[^}]*min-height:48px/);
  assert.match(portalCss, /@media \(max-width:560px\)/);             // the phone breakpoint still exists
});

/* ───────────────── focus: does it go in, and does it come back? ─────────────────
   The shell's inline script runs in a vm over a fake page that records every
   focus() call, so "focus returns here" is a test and not a hope. */
function shell() {
  const focusLog = [];
  const els = {};
  const mk = (id) => {
    const e = { id, value: '', innerHTML: '', textContent: '', style: {}, _a: {}, _c: new Set(), scrollTop: 0,
      addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, closest: () => null,
      contains: (x) => x === e, getBoundingClientRect: () => ({ width: 10, height: 10 }),
      focus() { focusLog.push(id); ctx.document.activeElement = e; },
      setAttribute(k, v) { e._a[k] = String(v); }, getAttribute: (k) => (k in e._a ? e._a[k] : null),
      removeAttribute(k) { delete e._a[k]; } };
    e.classList = { add: (c) => e._c.add(c), remove: (c) => e._c.delete(c), contains: (c) => e._c.has(c),
      toggle(c, f) { const on = f === undefined ? !e._c.has(c) : !!f; on ? e._c.add(c) : e._c.delete(c); return on; } };
    return e;
  };
  const el = (id) => (els[id] ||= mk(id));
  const ctx = {
    console, setTimeout, clearTimeout, Promise, URLSearchParams,
    document: { body: mk('body'), documentElement: mk('html'), activeElement: null,
      getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
      contains: () => true },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { removeItem() {} },
    navigator: {}, location: { hash: '', origin: 'https://aviance.store', pathname: '/', search: '', replace() {} },
    history: { replaceState() {} },
    supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }), signOut: async () => {} } }) },
  };
  ctx.window = ctx; ctx.addEventListener = () => {};
  vm.createContext(ctx);
  const core = path.join(root, 'core.js');
  if (fs.existsSync(core)) vm.runInContext(fs.readFileSync(core, 'utf8'), ctx, { filename: 'core.js' });
  const src = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="finance.js">'));
  vm.runInContext(src, ctx, { filename: 'index.html (inline script)' });
  const run = (code) => vm.runInContext(code, ctx);
  run(`authUser={uid:'u1',name:'Owner',role:'admin',email:'o@example.com'}`);
  return { ctx, run, el, focusLog };
}

test('focus returns: closing a modal hands the keyboard back to whatever opened it', () => {
  const { run, el, focusLog } = shell();
  const opener = el('theRowThatOpenedIt');
  run('document.activeElement = document.getElementById("theRowThatOpenedIt")');
  run('openModal("<div class=\\"modal-head\\"><h3>Are you sure?</h3></div>")');
  assert.ok(el('modalWrap').classList.contains('open'));
  assert.equal(el('modal').getAttribute('role'), 'dialog');
  assert.equal(el('modal').getAttribute('aria-modal'), 'true');
  focusLog.length = 0;
  run('closeModal()');
  assert.deepEqual(focusLog, ['theRowThatOpenedIt'], 'focus went back to the opener, not to the top of the page');
  assert.ok(opener);
});

test('focus returns: closing the finder hands the keyboard back, and Escape closes it from anywhere', () => {
  const { run, el, focusLog } = shell();
  run('document.activeElement = document.getElementById("someRow")');
  run('openCmdk()');
  assert.ok(el('cmdkWrap').classList.contains('open'));
  focusLog.length = 0;
  assert.equal(run('closeCmdk()'), true);
  assert.deepEqual(focusLog, ['someRow']);
  /* closeCmdk answers false when nothing was open, so Escape falls through to the rest */
  assert.equal(run('closeCmdk()'), false);
  /* and the shared Escape tries the finder first */
  assert.match(html, /if\(e\.key==='Escape'\)\{if\(closeCmdk\(\)\)return;if\(closeNotif\(\)\)return;closeModal\(\);return;\}/);
});

test('focus returns: closing the bell hands the keyboard back and says the panel is shut', () => {
  const { run, el, focusLog } = shell();
  run('document.activeElement = document.getElementById("notifBtn")');
  run('window.mtNotifs = () => []');
  run('toggleNotif({stopPropagation(){}})');
  assert.ok(el('notifPop').classList.contains('open'));
  assert.equal(el('notifBtn').getAttribute('aria-expanded'), 'true');
  focusLog.length = 0;
  assert.equal(run('closeNotif()'), true);
  assert.equal(el('notifBtn').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(focusLog, ['notifBtn']);
});

test('the bell says how many things need you, in its own name', () => {
  const { run, el } = shell();
  run('window.mtNotifs = () => [{t:"A call needs an outcome"},{t:"Another one"}]');
  run('updateNotifBadge()');
  assert.equal(el('notifBtn').getAttribute('aria-label'), 'What needs you — 2 things');
  run('window.mtNotifs = () => [{t:"A call needs an outcome"}]');
  run('updateNotifBadge()');
  assert.equal(el('notifBtn').getAttribute('aria-label'), 'What needs you — 1 thing');
  run('window.mtNotifs = () => []');
  run('updateNotifBadge()');
  assert.equal(el('notifBtn').getAttribute('aria-label'), 'What needs you — nothing right now');
});

test('Tab cannot walk out of an open panel', () => {
  const { run } = shell();
  /* with nothing focusable inside, Tab is swallowed rather than let out */
  const held = run(`(function(){
    const box={querySelectorAll:()=>[],contains:()=>true,focus(){}};
    let stopped=false;
    return trapTab(box,{key:'Tab',shiftKey:false,preventDefault(){stopped=true}})&&stopped;
  })()`);
  assert.equal(held, true);
  assert.equal(run(`trapTab({querySelectorAll:()=>[],contains:()=>true,focus(){}},{key:'a'})`), false, 'any other key passes through');
  /* and the shell wires it to the three floating things */
  assert.match(html, /trapTab\(document\.querySelector\('\.cmdk'\),e\)/);
  assert.match(html, /trapTab\(document\.getElementById\('modal'\),e\)/);
  assert.match(html, /np\.contains\(e\.target\)&&trapTab\(np,e\)/);
});

test('the keyboard can skip the eleven places and land on the screen', () => {
  assert.match(html, /<a class="skip-link" href="#content" onclick="skipToContent\(event\)">Skip to the screen<\/a>/);
  assert.match(html, /<main class="content" id="content" tabindex="-1"><\/main>/);
  assert.match(html, /\.skip-link\{[^}]*transform:translateY\(-120%\)/);
  assert.match(html, /\.skip-link:focus\{transform:translateY\(0\)\}/);
  const { run, el, focusLog } = shell();
  el('content').querySelectorAll = () => [];
  run('skipToContent({preventDefault(){}})');
  assert.deepEqual(focusLog, ['content'], 'with nothing in it yet, the screen itself takes the focus');
});

test('the white ring on red buttons is drawn INSIDE the button, whatever the screen says', () => {
  /* Per-screen rules like `.chv button:focus-visible{…outline-offset:1px}` are more
     specific than the shared rule, so without !important on the offset the white ring
     was pushed outside the red button onto a white page — white on white, 1:1. Found
     by measuring in a browser, not by reading. */
  assert.match(brand, /outline:2px solid #fff!important;outline-offset:-4px!important\}/);
});
