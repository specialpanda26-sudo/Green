import crypto from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const tsEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// 0712 345 678, +254712345678, 712345678 -> 254712345678. Anything else -> ''.
export function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  return /^254[17]\d{8}$/.test(d) ? d : '';
}

// Dates are Nairobi dates (UTC+3), written YYYY-MM-DD.
export const nairobiToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
export const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const nairobiStart = (d) => new Date(d + 'T00:00:00+03:00').toISOString();
export const dayOf = (iso) => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 10);
export const ago = (ms) => new Date(Date.now() - ms).toISOString();
export function validDate(s) {
  try { return /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; } catch (e) { return false; }
}

// In-memory rate limit (one server). bump() returns false once the limit is passed.
const hits = new Map();
export function bump(key, max, windowMs = 86400e3) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) h = { n: 0, reset: now + windowMs };
  h.n++; hits.set(key, h);
  if (hits.size > 20000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  return h.n <= max;
}
export const peek = (key) => { const h = hits.get(key); return h && h.reset > Date.now() ? h.n : 0; };
export const resetHits = () => hits.clear();

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeRef = () => 'GL' + Array.from(crypto.randomBytes(6), (b) => ALPHA[b % 32]).join('');
