/* Tests for seats.js (people limit per plan + the client's People page). Run with: npm test. No browser, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const calls = [];
const sandbox = {
  console, Date, Number, Math, Promise, Array, String, Boolean,
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  document: { getElementById: () => null }, authUser: { clientId: 'oak', uid: 'u1' }, location: { origin: 'https://aviance.store' },
  toast: () => {}, tkPortalToken: () => 'T'.repeat(43), tkSha256Hex: async () => 'hash', calls,
  sb: { from: (t) => ({ upsert: async (row, o) => { calls.push([t, row, o]); return { error: null }; } }) },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'seats.js'), 'utf8') + '\n;globalThis.api={seatsForPlan,seatsUpsert,seatsPlain,peopleRender,peopleClientView,sp};', sandbox, { filename: 'seats.js' });
const A = sandbox.api;

test('plans: starter 2, growth 4, scale 6, unknown reads as starter', () => {
  assert.deepEqual(['starter', 'Growth', 'SCALE', 'trial', '', undefined].map(A.seatsForPlan), [2, 4, 6, 2, 2, 2]);
});
test('the owner\'s invite stores the limit for that client', async () => {
  assert.equal(await A.seatsUpsert('oak', 'growth'), '');
  assert.equal(calls[0][0], 'client_seats');
  assert.equal(calls[0][1].client_id, 'oak'); assert.equal(calls[0][1].seats, 4);
  assert.equal(calls[0][2].onConflict, 'client_id');
});
test('People page: count, joined and waiting rows, escaped; full = plain message and no add box', () => {
  A.sp.rows = [{ kind: 'person', name: '<b>Sam</b>', email: 's@oak.com' }, { kind: 'invited', email: 'p@oak.com' }];
  A.sp.seats = 4;
  let h = A.peopleRender();
  assert.ok(h.includes('2 of 4 used') && h.includes('Add a person') && h.includes('&lt;b&gt;Sam') && !h.includes('<b>Sam</b>'));
  assert.ok(h.includes('Invited, not joined yet') && h.includes('Joined'));
  A.sp.seats = 2; h = A.peopleRender();
  assert.ok(h.includes("You&#39;ve reached") || h.includes("You've reached the limit for your plan (2 people)"));
  assert.ok(!h.includes('id="spEmail"'));
});
test('the database refusal is shown as is; other errors get a fallback', () => {
  assert.equal(A.seatsPlain("You've reached the limit for your plan (2 people)."), "You've reached the limit for your plan (2 people).");
  assert.equal(A.seatsPlain(''), 'Something went wrong. Try again.');
});
test('wired in: script tag, nav item for clients, check script', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('<script src="seats.js"></script>') && html.includes("CLIENT_VIEWS=['channels','numbers','clientPeople']"));
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.check.includes('node --check seats.js'));
});
