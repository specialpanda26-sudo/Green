// Public API: config, seats, booking, ticket lookup, support messages, PayHero webhook.
// Every handler returns [status, data] or null when the path is not ours.
import crypto from 'node:crypto';
import { getSettings, ROUTES, ALL_SEATS } from './settings.js';
import { normPhone, nairobiToday, addDays, validDate, bump, makeRef, UUID, tsEqual } from './util.js';
import { startPayment, settle, releaseSeats } from './payments.js';
import { validEmail } from './mail.js';
import { parseFinoqWebhook, finoqReady } from './finoq.js';

const bad = (error, status = 400, extra = {}) => [status, { error, ...extra }];
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const ticketOf = (b, pay, S) => ({ ref: b.ref, route: b.route, date: b.travel_date, seats: b.seats, pax: b.pax, total: b.total, phone: b.phone, coach: b.coach, departure: S.departure, receipt: pay ? pay.receipt : null });

export async function publicRoutes(c) {
  const { req, url, db, env, body, ip } = c, m = req.method, p = url.pathname;

  if (p === '/api/config' && m === 'GET') {
    const S = await getSettings(db, env);
    return [200, { routes: ROUTES.map((name) => ({ name, fare: S.fares[name] })), vip_extra: S.vip_extra, vip_seats: S.vip_seats, blocked: S.blocked_seats, departure: S.departure, whatsapp: S.whatsapp, max_seats: S.max_seats, days_ahead: S.days_ahead, sales_open: S.sales_open, today: nairobiToday(), pay_ready: finoqReady(env) }];
  }

  if (p === '/api/seats' && m === 'GET') {
    const to = url.searchParams.get('to'), date = url.searchParams.get('date');
    if (!ROUTES.includes(to) || !validDate(date)) return bad('Pick a route and a date');
    const S = await getSettings(db, env), rows = await db.select('booked_seats', { route: to, travel_date: date }, { limit: 1000 });
    return [200, { taken: [...new Set([...S.blocked_seats, ...rows.map((r) => r.seat)])] }];
  }

  if (p === '/api/book' && m === 'POST') {
    const S = await getSettings(db, env), b = body || {};
    if (!S.sales_open) return bad('Bookings are closed right now. Please try again later.', 503);
    const to = String(b.to || '');
    if (!ROUTES.includes(to)) return bad('Pick where you are travelling to');
    const date = String(b.date || ''), today = nairobiToday();
    if (!validDate(date) || date < today || date > addDays(today, S.days_ahead)) return bad('Pick a travel date from today up to ' + S.days_ahead + ' days ahead');
    const seats = Array.isArray(b.seats) ? [...new Set(b.seats.map(String))] : [];
    if (!seats.length || seats.length > S.max_seats) return bad('Choose 1 to ' + S.max_seats + ' seats');
    if (seats.some((s) => !ALL_SEATS.includes(s) || S.blocked_seats.includes(s))) return bad('One of those seats cannot be booked');
    const pax = {};
    for (const s of seats) {
      const n = String((b.pax || {})[s] || '').replace(/\s+/g, ' ').trim();
      if (n.length < 3 || n.length > 60) return bad('Enter the full name for seat ' + s);
      pax[s] = n;
    }
    const phone = normPhone(b.phone);
    if (!phone) return bad('Enter a valid M-PESA number, for example 0712 345 678');
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) return bad('Enter the email where we should send your ticket');
    if (!finoqReady(env)) return bad('Payments are not set up yet', 503);
    if (!bump('book:ip:' + ip, num(env.BOOK_PER_IP_DAY, 40)) || !bump('book:ph:' + phone, num(env.BOOK_PER_PHONE_DAY, 10))) return bad('Too many attempts today. Please try again tomorrow.', 429);
    // The price is always worked out here. The browser's total is never trusted.
    const fare = S.fares[to], total = seats.reduce((a, s) => a + fare + (S.vip_seats.includes(s) ? S.vip_extra : 0), 0);
    const id = crypto.randomUUID();
    let made = null, ref = '';
    for (let i = 0; i < 4 && !made; i++) {
      ref = makeRef();
      const r = await db.insert('bookings', { id, ref, route: to, travel_date: date, seats, pax, phone, email, coach: String(b.coach || '').slice(0, 60) || null, total });
      if (!r.conflict) made = r.rows[0];
    }
    if (!made) return bad('Could not save the booking. Please try again.', 500);
    const held = await db.insert('booked_seats', seats.map((seat) => ({ route: to, travel_date: date, seat, booking_id: id })));
    if (held.conflict) {
      await db.remove('bookings', { id });
      const gone = await db.select('booked_seats', { route: to, travel_date: date, seat: { in: seats } }, { limit: 100 });
      return bad('Sorry, ' + (gone.length ? 'seat ' + gone.map((r) => r.seat).join(', ') + ' was' : 'a seat was') + ' just taken. Please pick another.', 409, { taken: gone.map((r) => r.seat) });
    }
    const pay = await startPayment(c, made, ip);
    if (pay.error) { await db.update('bookings', { id }, { status: 'failed' }); await releaseSeats(db, id); return bad(pay.error, pay.status); }
    return [200, { id, ref, amount: total }];
  }

  if (p === '/api/book/status' && m === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!UUID.test(id)) return bad('bad id');
    const [bk] = await db.select('bookings', { id }, { limit: 1 });
    if (!bk) return [200, { status: 'unknown' }];
    const [pay] = await db.select('payments', { booking_id: id }, { order: 'created_at.desc', limit: 1 });
    const out = { status: bk.status, ref: bk.ref };
    if (pay && pay.fail_reason) out.reason = pay.fail_reason;
    if (bk.status === 'paid') out.ticket = ticketOf(bk, pay, await getSettings(db, env));
    return [200, out];
  }

  // Lost your ticket? Ticket code plus the M-PESA number you paid with.
  if (p === '/api/ticket' && m === 'GET') {
    const ref = String(url.searchParams.get('ref') || '').toUpperCase().trim(), phone = normPhone(url.searchParams.get('phone'));
    if (!/^GL[A-Z0-9]{6}$/.test(ref) || !phone) return bad('Enter your ticket code and the M-PESA number you paid with');
    if (!bump('ticket:' + ip, 20, 3600e3)) return bad('Too many tries. Please wait a while.', 429);
    const [bk] = await db.select('bookings', { ref }, { limit: 1 });
    if (!bk || bk.phone !== phone) return bad('No ticket found for that code and number', 404);
    if (bk.status !== 'paid') return [200, { status: bk.status, ref }];
    const [pay] = await db.select('payments', { booking_id: bk.id, status: 'paid' }, { limit: 1 });
    return [200, { status: 'paid', ref, ticket: ticketOf(bk, pay, await getSettings(db, env)) }];
  }

  if (p === '/api/support' && m === 'POST') {
    const b = body || {};
    if (b.website) return [200, { ok: true }]; // hidden field only bots fill in
    const message = String(b.message || '').trim(), name = String(b.name || '').trim().slice(0, 60);
    const rawPhone = String(b.phone || '').trim(), phone = rawPhone ? normPhone(rawPhone) : '', email = String(b.email || '').trim().slice(0, 100);
    if (message.length < 5 || message.length > 1500) return bad('Write your message (5 to 1500 characters)');
    if (rawPhone && !phone) return bad('Check the phone number');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('Check the email address');
    if (!phone && !email) return bad('Add a phone number or an email so we can reply');
    if (!bump('support:ip:' + ip, 5, 3600e3) || !bump('support:day:' + ip, 20)) return bad('Too many messages. Please try again later.', 429);
    const ref = String(b.ref || '').toUpperCase().trim();
    await db.insert('support_messages', { name: name || null, phone: phone || null, email: email || null, message, booking_ref: /^GL[A-Z0-9]{6}$/.test(ref) ? ref : null });
    return [200, { ok: true }];
  }

  // PayHero calls this. The secret in ?s= is required, otherwise anyone could fake a payment.
  if (p === '/api/webhooks/payhero' && m === 'POST') {
    if (!env.PAYHERO_CALLBACK_SECRET || !tsEqual(url.searchParams.get('s') || '', env.PAYHERO_CALLBACK_SECRET)) return [403, { error: 'no' }];
    const cb = parseFinoqWebhook(body);
    console.log('payhero webhook:', cb.ref || '(no ref)', cb.status || '?', 'amount', cb.amount || '?');
    db.insert('payhero_events', { ref: cb.ref || null, status: cb.status || null, payload: body || {} }).catch(() => {});
    if (!cb.ref) return [200, { ok: true }];
    try { return [200, { ok: true, result: await settle(c, cb) }]; }
    catch (e) { console.error('payhero webhook: settle failed', cb.ref, e && e.message); return [500, { ok: false, error: 'retry' }]; }
  }
  return null;
}
