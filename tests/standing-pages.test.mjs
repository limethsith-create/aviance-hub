// fnStanding must return EVERY client-month, however many there are. The database
// answers a ranged read one page at a time and says nothing when an unranged read is
// cut short, so this runs the real function against a fake that serves pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load(total, failAtPage) {
  const calls = [];
  const sb = { from() {
    const st = { from: 0, to: Infinity };
    const q = {
      select() { return q; }, eq() { return q; }, order() { return q; },
      range(a, b) { st.from = a; st.to = b; return q; },
      then(res) {
        calls.push([st.from, st.to]);
        if (failAtPage != null && calls.length === failAtPage) return res({ data: null, error: { message: 'Failed to fetch' } });
        const rows = [];
        for (let i = st.from; i <= Math.min(st.to, total - 1); i++) rows.push({ month_id: 'm' + i });
        return res({ data: rows, error: null });
      },
    };
    return q;
  } };
  const ctx = vm.createContext({ sb, console });
  for (const f of ['core.js', 'finance.js'])
    vm.runInContext(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8'), ctx, { filename: f });
  return { run: () => vm.runInContext('fnStanding()', ctx), calls };
}

test('a small book is one read', async () => {
  const t = load(40); const r = await t.run();
  assert.equal(r.ok, true); assert.equal(r.data.length, 40); assert.equal(t.calls.length, 1);
});
test('2,300 months all arrive, in three reads, none dropped and none twice', async () => {
  const t = load(2300); const r = await t.run();
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 2300);
  assert.equal(new Set(r.data.map((x) => x.month_id)).size, 2300);
  assert.equal(t.calls.length, 3);
});
test('exactly one full page asks once more rather than assuming it is finished', async () => {
  const t = load(1000); const r = await t.run();
  assert.equal(r.data.length, 1000); assert.equal(t.calls.length, 2);
});
test('a page that fails fails the whole read — never a part passed off as the whole', async () => {
  const t = load(2300, 2); const r = await t.run();
  assert.equal(r.ok, false);
  assert.ok(!Array.isArray(r.data) || r.data.length === 0, 'no partial list comes back');
});
test('past the ceiling it refuses in words', async () => {
  const t = load(50000); const r = await t.run();
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not showing a part of them as the whole/);
});
