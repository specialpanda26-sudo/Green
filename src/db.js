// Tiny database layer. Supabase (PostgREST) in production, in memory for tests (DB_MODE=memory).
// Filters: { col: value } or { col: { in:[..], lt:x, gte:x, ne:x, is:null, not_null:true } }.
import crypto from 'node:crypto';

const enc = encodeURIComponent;
const ops = (c) => (c !== null && typeof c === 'object' && !Array.isArray(c) ? c : { eq: c });
const DEFAULT = { bookings: { status: 'pending' }, payments: { status: 'pending' }, support_messages: { status: 'open' } }; // same as the SQL defaults
const UNIQUE = { booked_seats: [['route', 'travel_date', 'seat']], bookings: [['ref']], payments: [['request_id']], settings: [['key']] };

function test(v, op, x) {
  if (op === 'eq') return String(v) === String(x);
  if (op === 'ne') return String(v) !== String(x);
  if (op === 'in') return x.map(String).includes(String(v));
  if (op === 'lt') return v < x;
  if (op === 'lte') return v <= x;
  if (op === 'gt') return v > x;
  if (op === 'gte') return v >= x;
  if (op === 'is') return v === null || v === undefined;
  if (op === 'not_null') return v !== null && v !== undefined;
  throw new Error('bad filter ' + op);
}
const hit = (row, f) => Object.entries(f || {}).every(([col, c]) => Object.entries(ops(c)).every(([op, x]) => test(row[col], op, x)));

function memoryDb() {
  const T = {}, tbl = (n) => (T[n] ||= []);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const dup = (n, row) => (UNIQUE[n] || []).some((cols) => tbl(n).some((r) => cols.every((c) => String(r[c]) === String(row[c]))));
  const sort = (rows, order) => {
    if (!order) return rows;
    const [col, dir] = order.split('.');
    return rows.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
  };
  return {
    async insert(n, rows, o = {}) {
      const made = [];
      for (const r of [].concat(rows)) {
        const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...DEFAULT[n], ...clone(r) };
        if (dup(n, row)) {
          if (o.ignoreDup) continue;
          made.forEach((m) => tbl(n).splice(tbl(n).indexOf(m), 1));
          return { rows: [], conflict: true };
        }
        tbl(n).push(row); made.push(row);
      }
      return { rows: clone(made), conflict: false };
    },
    async select(n, f, o = {}) { const off = o.offset || 0; return clone(sort(tbl(n).filter((r) => hit(r, f)), o.order).slice(off, off + (o.limit || 1000))); },
    async update(n, f, patch) {
      if (!Object.keys(f || {}).length) throw new Error('update needs a filter');
      const rows = tbl(n).filter((r) => hit(r, f));
      rows.forEach((r) => Object.assign(r, clone(patch)));
      return clone(rows);
    },
    async remove(n, f) {
      if (!Object.keys(f || {}).length) throw new Error('remove needs a filter');
      const keep = tbl(n).filter((r) => !hit(r, f)), c = tbl(n).length - keep.length;
      T[n] = keep; return c;
    },
    async upsert(n, row, key) {
      const cur = tbl(n).find((r) => String(r[key]) === String(row[key]));
      if (cur) Object.assign(cur, clone(row)); else tbl(n).push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...clone(row) });
    },
  };
}

function supabaseDb(env) {
  const base = String(env.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/', key = String(env.SUPABASE_SERVICE_KEY);
  async function rest(path, init = {}) {
    const res = await fetch(base + path, { ...init, headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...init.headers } });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    return { ok: res.ok, status: res.status, body };
  }
  const q = (f) => Object.entries(f || {}).flatMap(([col, c]) => Object.entries(ops(c)).map(([op, x]) =>
    op === 'in' ? `${col}=in.(${x.map(enc).join(',')})` : op === 'is' ? `${col}=is.null` : op === 'not_null' ? `${col}=not.is.null` : `${col}=${op}.${enc(x)}`));
  const fail = (what, r) => { throw new Error(`db ${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); };
  return {
    async insert(n, rows, o = {}) {
      const r = await rest(n, { method: 'POST', headers: { Prefer: 'return=representation' + (o.ignoreDup ? ',resolution=ignore-duplicates' : '') }, body: JSON.stringify(rows) });
      if (r.status === 409) return { rows: [], conflict: true };
      if (!r.ok) fail('insert ' + n, r);
      return { rows: r.body || [], conflict: false };
    },
    async select(n, f, o = {}) {
      const p = ['select=*', ...q(f), 'limit=' + (o.limit || 1000)];
      if (o.order) p.push('order=' + o.order);
      if (o.offset) p.push('offset=' + o.offset);
      const r = await rest(n + '?' + p.join('&'));
      if (!r.ok) fail('select ' + n, r);
      return r.body || [];
    },
    async update(n, f, patch) {
      const p = q(f); if (!p.length) throw new Error('update needs a filter');
      const r = await rest(n + '?' + p.join('&'), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      if (!r.ok) fail('update ' + n, r);
      return r.body || [];
    },
    async remove(n, f) {
      const p = q(f); if (!p.length) throw new Error('remove needs a filter');
      const r = await rest(n + '?' + p.join('&'), { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (!r.ok) fail('remove ' + n, r);
      return (r.body || []).length;
    },
    async upsert(n, row, key2) {
      const r = await rest(n + '?on_conflict=' + key2, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
      if (!r.ok) fail('upsert ' + n, r);
    },
  };
}

export function makeDb(env) {
  const db = env.DB_MODE === 'memory' ? memoryDb() : supabaseDb(env);
  // Pages through results (Supabase returns at most 1000 rows per request).
  db.selectAll = async (n, f, o = {}) => {
    const out = [], max = o.max || 5000;
    for (let off = 0; out.length < max; off += 1000) {
      const part = await db.select(n, f, { ...o, limit: 1000, offset: off });
      out.push(...part);
      if (part.length < 1000) break;
    }
    return out;
  };
  return db;
}
