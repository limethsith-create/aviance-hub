/* The machine's journey snapshots, as the hub's tests use them: one applicant (Dana Whitfield, Ridgeline IT) from the
   website form to the paid invoice — 29 real answers of GET /api/mc/hub (`board`) and GET /api/mc/hub/{id} (`detail`),
   plus `extra.calendar` (GET /api/mc/calendar), `extra.cheapinboxes` and `extra.warmupSettings` where the machine saved
   them. tests/fixtures/journey/trim.mjs copied them here without repeats; loadJourney() puts the repeats back. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOURNEY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'journey');
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function unpack(v, prev) {
  if (isObj(v)) {
    if (v.$same === 1 && Object.keys(v).length === 1) return clone(prev);
    if (Array.isArray(v.$append) && Object.keys(v).length === 1) return clone(prev).concat(unpack(v.$append));
    if (Array.isArray(v.$prepend) && Object.keys(v).length === 1) return unpack(v.$prepend).concat(clone(prev));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = unpack(x, isObj(prev) ? prev[k] : undefined);
    return out;
  }
  if (Array.isArray(v)) return v.map((x, i) => unpack(x, Array.isArray(prev) && prev.length === v.length ? prev[i] : undefined));
  return v;
}
function boardRow(board, id) {
  for (const st of (board && board.stages) || []) for (const r of st.clients || []) if (r && r.id === id) return r;
  return null;
}

/* → [{step, what, at, check, board, detail, extra?}] oldest first, each a fresh copy. */
export function loadJourney(dir = JOURNEY_DIR) {
  const files = fs.readdirSync(dir).filter((f) => /^\d\d-.*\.json$/.test(f)).sort();
  const out = [];
  let prev;
  for (const f of files) {
    const s = unpack(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), prev);
    const d = s.detail;
    if (d && isObj(d.row) && d.row.$boardRow != null) {
      const base = boardRow(s.board, d.row.$boardRow);
      if (!base) throw new Error(f + ': detail.row points at a board row that is not there');
      d.row = Object.assign(clone(base), clone(d.row.set || {}));
    }
    if (d && isObj(d.onboardCall) && d.onboardCall.thread === '$conversation.thread') d.onboardCall.thread = clone((d.conversation || {}).thread || []);
    out.push(s);
    prev = s;
  }
  return out.map(clone);
}
