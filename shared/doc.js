// Every data file is a set of tables: { tasks: { id: record }, courses: {...}, ... }.
// Each record remembers when each of its fields was last written (`_t`), so two copies
// edited on different devices merge field by field: the newer write of each field wins,
// and edits to different fields of the same task both survive. Merging is commutative,
// so it does not matter which side saves first. Deletes are a `deleted: true` field.

export function now() {
  return Date.now();
}

/** Return a copy of rec with patch applied and stamped. Undefined values delete the field. */
export function stamp(rec, patch, t = now()) {
  const out = { ...(rec || {}), _t: { ...((rec && rec._t) || {}) } };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '_t') continue;
    if (v === undefined) delete out[k];
    else out[k] = v;
    out._t[k] = t;
  }
  return out;
}

function same(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function mergeRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = a._t || {}, tb = b._t || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(ta), ...Object.keys(tb)]);
  keys.delete('_t');
  const out = { _t: {} };
  for (const k of keys) {
    const xa = ta[k] || 0, xb = tb[k] || 0;
    let pick;
    if (xa > xb) pick = 'a';
    else if (xb > xa) pick = 'b';
    else pick = JSON.stringify(a[k]) >= JSON.stringify(b[k]) ? 'a' : 'b'; // deterministic tie-break
    const src = pick === 'a' ? a : b;
    if (k in src) out[k] = src[k];
    const t = Math.max(xa, xb);
    if (t) out._t[k] = t;
  }
  return out;
}

export function mergeTable(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, rb] of Object.entries(b)) out[id] = id in a ? mergeRecord(a[id], rb) : rb;
  return out;
}

export function mergeDocs(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = a[k], vb = b[k];
    if (isTable(va) || isTable(vb)) out[k] = mergeTable(va || {}, vb || {});
    else out[k] = vb !== undefined ? vb : va;
  }
  return out;
}

function isTable(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function docEquals(a, b) {
  return same(a, b);
}

/** Records of a table that are not deleted. */
export function live(table) {
  return Object.values(table || {}).filter((r) => !r.deleted);
}

/** Drop `_t` stamps and deleted records, for showing data to a model or a person. */
export function plain(rec) {
  if (!rec) return rec;
  const { _t, ...rest } = rec;
  return rest;
}

export function uid(prefix = 't') {
  const r = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  return `${prefix}:${r}`;
}
