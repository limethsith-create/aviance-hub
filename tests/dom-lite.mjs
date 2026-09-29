/* A tiny HTML → node tree for tests that need to walk a rendered screen (Ava reading the page out loud). Enough of the
   DOM for ava.js's reader: nodeType, tagName / nodeName, childNodes, parentNode, getAttribute, className, id, hidden,
   open, textContent, nodeValue. The hub's markup is generated and well formed; this is not a general HTML parser. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsaquo: '›', mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×' };
export function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
}
function textNode(v, parent) { return { nodeType: 3, nodeName: '#text', nodeValue: v, parentNode: parent, get textContent() { return this.nodeValue; } }; }
function elNode(tag, attrs, parent) {
  const n = {
    nodeType: 1, tagName: tag.toUpperCase(), nodeName: tag.toUpperCase(), attrs, childNodes: [], parentNode: parent,
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    setAttribute(k, v) { attrs[k] = String(v); },
    get className() { return attrs.class || ''; },
    get id() { return attrs.id || ''; },
    get hidden() { return Object.prototype.hasOwnProperty.call(attrs, 'hidden'); },
    get open() { return Object.prototype.hasOwnProperty.call(attrs, 'open'); },
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); },
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); },
  };
  return n;
}
/* parse(html) → a DIV node (id = rootId) holding the parsed children. */
export function parse(html, rootId) {
  const root = elNode('div', rootId ? { id: rootId } : {}, null);
  const stack = [root]; const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0, m;
  const addText = (s) => { if (s) top().childNodes.push(textNode(decode(s), top())); };
  while ((m = re.exec(html))) {
    addText(html.slice(last, m.index)); last = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {   // a closing tag: pop to the matching open one (a stray one is ignored)
      const t = m[1].toUpperCase(); for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === t) { stack.length = i; break; }
      continue;
    }
    const tag = m[2].toLowerCase(); const attrs = {};
    const ar = /([^\s=>\/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g; let a;
    while ((a = ar.exec(m[3] || ''))) { let v = a[2] == null ? '' : a[2]; if (/^["']/.test(v)) v = v.slice(1, -1); attrs[a[1].toLowerCase()] = decode(v); }
    const n = elNode(tag, attrs, top()); top().childNodes.push(n);
    if (VOID.has(tag) || m[4]) continue;
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf('</' + tag, last); const body = end < 0 ? html.slice(last) : html.slice(last, end);
      if (body) n.childNodes.push(textNode(decode(body), n));
      last = end < 0 ? html.length : html.indexOf('>', end) + 1; re.lastIndex = last; continue;
    }
    stack.push(n);
  }
  addText(html.slice(last));
  return root;
}
/* Every element in the tree, depth first. */
export function walk(n, fn) { if (!n || n.nodeType !== 1) return; fn(n); n.childNodes.forEach((c) => walk(c, fn)); }
