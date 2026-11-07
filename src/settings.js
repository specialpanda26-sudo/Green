// Fares and site settings. Defaults come from the demo site; the admin panel saves changes to the settings table.
import { normPhone } from './util.js';

export const ROUTES = ['Bondo', 'Bungoma', 'Eldoret', 'Kakamega', 'Kapsabet', 'Kisumu', 'Kitale', 'Lwakhakha', 'Malaba', 'Mombasa', 'Mumias', 'Nakuru', 'Port Victoria', 'Siaya'];
// Seat ids on the coach: 1x, then 1 to 66. "ss" is the crew seat and can never be booked.
export const ALL_SEATS = ['1x', ...Array.from({ length: 66 }, (_, i) => String(i + 1))];
export const DEFAULTS = {
  fares: Object.fromEntries(ROUTES.map((r) => [r, r === 'Mombasa' || r === 'Siaya' ? 1600 : 1300])),
  vip_extra: 500, departure: '10:00 PM', whatsapp: '',
  vip_seats: ['1x', '1', '2', '3', '4'], blocked_seats: ['36', '37'],
  max_seats: 5, days_ahead: 60, sales_open: true,
};

const cache = new WeakMap();
export async function getSettings(db, env = {}) {
  const c = cache.get(db);
  if (c && c.t > Date.now() - 10e3) return c.v;
  const [row] = await db.select('settings', { key: 'site' }, { limit: 1 });
  const saved = (row && row.value) || {};
  const v = { ...DEFAULTS, ...saved, fares: { ...DEFAULTS.fares, ...(saved.fares || {}) } };
  if (!v.whatsapp) v.whatsapp = String(env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
  cache.set(db, { t: Date.now(), v });
  return v;
}

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const int = (v, lo, hi, what) => { const n = Math.floor(Number(v)); if (!(n >= lo && n <= hi)) throw bad(what + ' must be between ' + lo + ' and ' + hi); return n; };
const seatList = (v, what) => { if (!Array.isArray(v)) throw bad(what + ' must be a list'); const s = [...new Set(v.map(String))]; if (s.some((x) => !ALL_SEATS.includes(x))) throw bad(what + ' has an unknown seat'); return s; };

export async function saveSettings(db, env, input) {
  const i = input && typeof input === 'object' ? input : {}, cur = await getSettings(db, env), next = { ...cur, fares: { ...cur.fares } };
  if (i.fares && typeof i.fares === 'object') for (const r of ROUTES) if (i.fares[r] !== undefined) next.fares[r] = int(i.fares[r], 1, 50000, 'Fare for ' + r);
  if (i.vip_extra !== undefined) next.vip_extra = int(i.vip_extra, 0, 20000, 'VIP extra');
  if (i.max_seats !== undefined) next.max_seats = int(i.max_seats, 1, 10, 'Seats per booking');
  if (i.days_ahead !== undefined) next.days_ahead = int(i.days_ahead, 1, 365, 'Days ahead');
  if (i.departure !== undefined) { const d = String(i.departure).trim(); if (!d || d.length > 20) throw bad('Departure time looks wrong'); next.departure = d; }
  if (i.sales_open !== undefined) next.sales_open = !!i.sales_open;
  if (i.vip_seats !== undefined) next.vip_seats = seatList(i.vip_seats, 'VIP seats');
  if (i.blocked_seats !== undefined) next.blocked_seats = seatList(i.blocked_seats, 'Blocked seats');
  if (i.whatsapp !== undefined) {
    const raw = String(i.whatsapp).trim(), d = raw.replace(/\D/g, '');
    if (!d) next.whatsapp = '';
    else { const n = normPhone(raw) || d; if (n.length < 9 || n.length > 15) throw bad('WhatsApp number looks wrong'); next.whatsapp = n; }
  }
  await db.upsert('settings', { key: 'site', value: next, updated_at: new Date().toISOString() }, 'key');
  cache.delete(db);
  return next;
}
