import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cleanup.js'), 'utf8');
function load(answers) {
  const calls = []; let html = '';
  const ctx = { calls, esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), tkAttr: (v) => JSON.stringify(String(v)).replace(/"/g, '&quot;'),
    openModal: (h) => { html = h; }, closeModal() {}, machineFetch: async (p, o) => { calls.push(o.body); return answers.shift(); } };
  vm.createContext(ctx); vm.runInContext(src + '\nthis.cln=cln;this.openCleanup=openCleanup;this.clnApply=clnApply;this.clnToggle=clnToggle;this.clnAsk=clnAsk;', ctx);
  return { ctx, html: () => html };
}

test('list shows why, escapes, ticks strong ones only; apply sends exactly the ticked ids', async () => {
  const items = { ok: true, clients: [{ id: 'demo-a', kind: 'client', label: '<b>Harbor</b>', reasons: ['Its id starts with "demo-"'], strong: true, detail: 'sending' }, { id: 'zed', kind: 'client', label: 'Test', reasons: ['Its name is just "Test"'], strong: false }], bookings: [], keys: [] };
  const t = load([{ ok: true, data: items }, { ok: true, data: { ok: true, removed: [{ kind: 'client', id: 'demo-a', label: 'Harbor' }], skipped: [] } }]);
  await t.ctx.openCleanup();
  assert.match(t.html(), /Why:/); assert.match(t.html(), /&lt;b&gt;Harbor/); assert.doesNotMatch(t.html(), /<b>Harbor/);
  assert.match(t.html(), /Remove 1 ticked/);
  t.ctx.clnAsk(); assert.match(t.html(), /cannot be undone/);
  await t.ctx.clnApply();
  assert.equal(JSON.stringify(t.ctx.calls[1]), JSON.stringify({ action: 'apply', ids: ['client:demo-a'] }));
  assert.match(t.html(), /1<\/b> removed/);
});

test('nothing found and errors read in plain words', async () => {
  let t = load([{ ok: true, data: { ok: true, clients: [], bookings: [], keys: [] } }]);
  await t.ctx.openCleanup(); assert.match(t.html(), /No test data found/);
  t = load([{ ok: false, error: 'Couldn\'t reach the system.' }]);
  await t.ctx.openCleanup(); assert.match(t.html(), /reach the system/);
});
