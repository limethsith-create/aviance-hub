/* Copies the machine's journey snapshots (email-distributor tests/fixtures/journey/NN-step.json — its real hub
   answers along one applicant's trial) into this folder, trimmed to what the hub reads and without repeats.
     node tests/fixtures/journey/trim.mjs [path to email-distributor/tests/fixtures/journey]
   Lossless for everything the hub draws, except: detail.profile, detail.trial and detail.virtualNow (the hub never
   reads them) are left out, detail.events keeps its newest 10 (Behind the scenes › History), board.alerts its newest
   15 (Settings › Alerts) and detail.shopping the two fields the hub shows. Repeats are written as markers that tests/journey-fixtures.mjs puts back:
     {"$same":1}            the same value as in the step before, at the same place (a list as long as the step
                            before's is compared item by item)
     {"$append":[…]}        the step before's list plus these at the end   ({"$prepend":[…]}: at the start)
     {"$boardRow":id,"set":{…}}  detail.row = that client's row on the board, with these fields changed
     "$conversation.thread" onboardCall.thread is the conversation's thread (the contract says it is the same list) */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = process.argv[2] || path.join(os.homedir(), 'claude/email-distributor/tests/fixtures/journey');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function trim(s) {
  s = JSON.parse(JSON.stringify(s));
  if (s.board && Array.isArray(s.board.alerts)) s.board.alerts = s.board.alerts.slice(0, 15);
  const d = s.detail;
  if (d) {
    for (const k of ['profile', 'trial', 'virtualNow']) delete d[k];
    if (Array.isArray(d.events)) d.events = d.events.slice(0, 10);
    if (d.shopping && typeof d.shopping === 'object') d.shopping = { chosenDomain: d.shopping.chosenDomain ?? null, total: d.shopping.total ?? null };
  }
  return s;
}
function pack(cur, prev, depth) {
  if (prev === undefined) return cur;
  if (same(cur, prev) && JSON.stringify(cur).length > 80) return { $same: 1 };
  if (cur && prev && typeof cur === 'object' && typeof prev === 'object' && !Array.isArray(cur) && !Array.isArray(prev) && depth < 6) {
    const out = {};
    for (const [k, v] of Object.entries(cur)) out[k] = k in prev ? pack(v, prev[k], depth + 1) : v;
    return out;
  }
  if (Array.isArray(cur) && Array.isArray(prev) && cur.length === prev.length && depth < 6) return cur.map((v, i) => pack(v, prev[i], depth + 1));
  if (Array.isArray(cur) && Array.isArray(prev) && prev.length && cur.length > prev.length) {
    const n = prev.length;
    if (same(cur.slice(0, n), prev)) return { $append: cur.slice(n) };
    if (same(cur.slice(cur.length - n), prev)) return { $prepend: cur.slice(0, cur.length - n) };
  }
  return cur;
}
function boardRow(board, id) {
  for (const st of (board && board.stages) || []) for (const r of st.clients || []) if (r && r.id === id) return r;
  return null;
}

const files = fs.readdirSync(from).filter((f) => /^\d\d-.*\.json$/.test(f)).sort();
let prev, total = 0;
for (const f of files) {
  const full = trim(JSON.parse(fs.readFileSync(path.join(from, f), 'utf8')));
  const out = pack(full, prev, 0);
  if (full.detail && full.detail.row && out.detail && !out.detail.$same) {
    const br = boardRow(full.board, full.detail.row.id);
    if (br) {
      const diff = {};
      for (const k of new Set([...Object.keys(br), ...Object.keys(full.detail.row)])) if (!same(br[k], full.detail.row[k])) diff[k] = full.detail.row[k] === undefined ? null : full.detail.row[k];
      out.detail.row = { $boardRow: br.id, set: diff };
    }
    const oc = full.detail.onboardCall, c = full.detail.conversation;
    if (oc && c && Array.isArray(oc.thread) && same(oc.thread, c.thread) && out.detail.onboardCall && typeof out.detail.onboardCall === 'object' && !out.detail.onboardCall.$same) out.detail.onboardCall.thread = '$conversation.thread';
  }
  const text = JSON.stringify(out) + '\n';
  fs.writeFileSync(path.join(here, f), text);
  total += text.length;
  prev = full;
}
console.log(files.length + ' steps written to ' + here + ' (' + Math.round(total / 1024) + ' KB)');
