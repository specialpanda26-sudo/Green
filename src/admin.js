// Admin API. Every call needs the ADMIN_KEY in the X-Admin-Key header.
import { tsEqual, bump, peek, UUID, validDate, addDays, nairobiToday, nairobiStart, dayOf } from './util.js';
import { getSettings, saveSettings, ROUTES, ALL_SEATS } from './settings.js';
import { settle, releaseSeats, emailTicket } from './payments.js';
import { mailReady, mailDiagnosis, validEmail } from './mail.js';
import { finoqReady, finoqStatus, finoqCallback } from './finoq.js';

const bad = (error, status = 400) => [status, { error }];
const PAY_STATUS = ['pending', 'paid', 'failed', 'expired', 'underpaid'];
const csvCell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function byIds(db, table, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 60) out.push(...(await db.select(table, { id: { in: ids.slice(i, i + 60) } }, { limit: 100 })));
  return out;
}

async function listPayments({ db, url }) {
  const q = url.searchParams, f = {}, st = q.get('status'), from = q.get('from'), to = q.get('to');
  if (PAY_STATUS.includes(st)) f.status = st;
  if (validDate(from) || validDate(to)) {
    f.created_at = {};
    if (validDate(from)) f.created_at.gte = nairobiStart(from);
    if (validDate(to)) f.created_at.lt = nairobiStart(addDays(to, 1));
  }
  const rows = await db.select('payments', f, { order: 'created_at.desc', limit: Math.min(Number(q.get('limit')) || 300, 1000) });
  const bks = new Map((await byIds(db, 'bookings', [...new Set(rows.map((r) => r.booking_id))])).map((b) => [b.id, b]));
  let out = rows.map((r) => ({ ...r, booking: bks.get(r.booking_id) || null }));
  const s = String(q.get('q') || '').trim().toLowerCase();
  if (s) out = out.filter((r) => [r.phone, r.receipt, r.request_id, r.booking && r.booking.ref, r.booking && Object.values(r.booking.pax || {}).join(' ')].join(' ').toLowerCase().includes(s));
  return out;
}

async function summary({ db, env }) {
  const today = nairobiToday(), from30 = addDays(today, -29);
  const paid = await db.selectAll('payments', { status: 'paid', paid_at: { gte: nairobiStart(from30) } }, { order: 'paid_at.desc', max: 5000 });
  const sum = (rows) => ({ revenue: rows.reduce((a, r) => a + r.amount, 0), count: rows.length });
  const daily = [];
  for (let i = 13; i >= 0; i--) { const d = addDays(today, -i); daily.push({ date: d, ...sum(paid.filter((r) => dayOf(r.paid_at) === d)) }); }
  const [pending, review, failed, support, upcoming] = await Promise.all([
    db.select('payments', { status: 'pending' }, { limit: 200 }),
    db.select('bookings', { status: 'review' }, { limit: 200 }),
    db.select('payments', { status: { in: ['failed', 'expired', 'underpaid'] }, created_at: { gte: nairobiStart(today) } }, { limit: 1000 }),
    db.select('support_messages', { status: 'open' }, { limit: 1000 }),
    db.select('bookings', { status: 'paid', travel_date: { gte: today, lt: addDays(today, 8) } }, { limit: 1000 }),
  ]);
  const trips = {};
  for (const b of upcoming) { const k = b.travel_date + '|' + b.route; trips[k] = (trips[k] || 0) + b.seats.length; }
  return {
    today: sum(paid.filter((r) => dayOf(r.paid_at) === today)), week: sum(paid.filter((r) => dayOf(r.paid_at) >= addDays(today, -6))), month: sum(paid), daily,
    pending: pending.length, review: review.length, failed_today: failed.length, support_open: support.length,
    upcoming: Object.entries(trips).map(([k, seats]) => ({ date: k.split('|')[0], route: k.split('|')[1], seats })).sort((a, b) => (a.date + a.route).localeCompare(b.date + b.route)),
    config: { mail: mailReady(env), mail_notes: mailDiagnosis(env).notes, payhero: finoqReady(env), callback: !!finoqCallback(env) && !!env.PAYHERO_CALLBACK_SECRET, whatsapp: !!(await getSettings(db, env)).whatsapp },
  };
}

export async function adminRoutes(c) {
  const { req, url, db, env, body, ip } = c, m = req.method, p = url.pathname;
  if (!p.startsWith('/api/admin')) return null;
  if (peek('adminfail:' + ip) >= 10) return bad('Too many wrong keys. Try again in 15 minutes.', 429);
  const key = String(req.headers['x-admin-key'] || '');
  if (!env.ADMIN_KEY || !key || !tsEqual(key, env.ADMIN_KEY)) { bump('adminfail:' + ip, 10, 900e3); return bad('Wrong admin key', 401); }

  if (p === '/api/admin/ping') return [200, { ok: true }];
  if (p === '/api/admin/summary' && m === 'GET') return [200, await summary(c)];

  if (p === '/api/admin/payments' && m === 'GET') return [200, { payments: await listPayments(c) }];
  if (p === '/api/admin/payments.csv' && m === 'GET') {
    const rows = await listPayments(c), head = ['Date (Nairobi)', 'Ticket', 'Route', 'Travel date', 'Seats', 'Passengers', 'Phone', 'Amount KES', 'Status', 'M-PESA receipt', 'Note'];
    const lines = rows.map((r) => { const b = r.booking || {}; return [new Date(Date.parse(r.created_at) + 3 * 3600e3).toISOString().replace('T', ' ').slice(0, 16), b.ref, b.route, b.travel_date, (b.seats || []).join(' '), Object.values(b.pax || {}).join(' / '), r.phone, r.amount, r.status, r.receipt, r.note || r.fail_reason].map(csvCell).join(','); });
    return [200, [head.join(','), ...lines].join('\n'), { csv: 'greenline-transactions.csv' }];
  }

  const pm = p.match(/^\/api\/admin\/payments\/([0-9a-f-]{36})\/(recheck|approve)$/i);
  if (pm && m === 'POST') {
    const [pay] = UUID.test(pm[1]) ? await db.select('payments', { id: pm[1] }, { limit: 1 }) : [];
    if (!pay) return bad('Payment not found', 404);
    if (pm[2] === 'recheck') {
      const st = await finoqStatus(env, pay.checkout_id || pay.request_id);
      if (!st.ok) return bad('PayHero did not answer. Try again in a minute.', 502);
      let result = 'waiting';
      if (st.success) result = await settle(c, { ref: pay.request_id, success: true, amount: pay.amount, phone: '', receipt: st.receipt || pay.checkout_id || null, note: 'Confirmed by admin re-check' });
      else if (st.failed) result = await settle(c, { ref: pay.request_id, failed: true, code: null });
      return [200, { result, provider_status: st.status || 'unknown' }];
    }
    // Manual approval: only when PayHero's own dashboard shows the money. Needs the M-PESA receipt code.
    const receipt = String((body || {}).receipt || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8,12}$/.test(receipt)) return bad('Enter the M-PESA receipt code from the PayHero dashboard');
    return [200, { result: await settle(c, { ref: pay.request_id, success: true, amount: pay.amount, phone: '', receipt, note: 'Approved by admin by hand' }) }];
  }

  if (p === '/api/admin/bookings' && m === 'GET') {
    const q = url.searchParams, f = {};
    if (validDate(q.get('date'))) f.travel_date = q.get('date');
    if (ROUTES.includes(q.get('to'))) f.route = q.get('to');
    if (['pending', 'paid', 'failed', 'expired', 'cancelled', 'review'].includes(q.get('status'))) f.status = q.get('status');
    return [200, { bookings: await db.select('bookings', f, { order: 'created_at.desc', limit: 500 }) }];
  }
  if (p === '/api/admin/manifest' && m === 'GET') {
    const date = url.searchParams.get('date'), to = url.searchParams.get('to');
    if (!validDate(date) || !ROUTES.includes(to)) return bad('Pick a route and a date');
    const bks = await db.select('bookings', { travel_date: date, route: to, status: 'paid' }, { limit: 200 });
    const rows = bks.flatMap((b) => b.seats.map((seat) => ({ seat, name: b.pax[seat] || '', phone: b.phone, ref: b.ref })));
    return [200, { rows: rows.sort((a, b) => (parseInt(a.seat, 10) || 0) - (parseInt(b.seat, 10) || 0) || a.seat.localeCompare(b.seat)) }];
  }
  const em = p.match(/^\/api\/admin\/bookings\/([0-9a-f-]{36})\/email$/i);
  if (em && m === 'POST' && UUID.test(em[1])) {
    const [bk] = await db.select('bookings', { id: em[1] }, { limit: 1 });
    if (!bk || bk.status !== 'paid') return bad('Only paid bookings have a ticket', 404);
    const to = String((body || {}).email || bk.email || '').trim().toLowerCase();
    if (!validEmail(to)) return bad('Enter a valid email address');
    if (!mailReady(env)) return bad('Email is not set up yet. Add RESEND_API_KEY and MAIL_FROM on Render.', 503);
    await db.update('bookings', { id: bk.id }, { email: to, emailed_at: null });
    const r = await emailTicket(c, bk.id);
    return r === 'sent' ? [200, { ok: true, sent_to: to }] : bad('The email did not go out. Check the Resend key and that MAIL_FROM is on a domain verified in Resend.', 502);
  }
  const bm = p.match(/^\/api\/admin\/bookings\/([0-9a-f-]{36})\/cancel$/i);
  if (bm && m === 'POST' && UUID.test(bm[1])) {
    const [bk] = await db.update('bookings', { id: bm[1], status: { in: ['pending', 'paid', 'review', 'expired'] } }, { status: 'cancelled' });
    if (!bk) return bad('Booking not found or already closed', 404);
    await releaseSeats(db, bk.id);
    return [200, { ok: true, refund_needed: bk.total }]; // refunds are sent by hand from the PayHero dashboard
  }

  if (p === '/api/admin/support' && m === 'GET') {
    const st = url.searchParams.get('status'), f = ['open', 'replied', 'closed'].includes(st) ? { status: st } : {};
    return [200, { messages: await db.select('support_messages', f, { order: 'created_at.desc', limit: 300 }) }];
  }
  const sm = p.match(/^\/api\/admin\/support\/([0-9a-f-]{36})$/i);
  if (sm && m === 'PATCH' && UUID.test(sm[1])) {
    const b = body || {}, patch = { handled_at: new Date().toISOString() };
    if (b.status !== undefined) { if (!['open', 'replied', 'closed'].includes(b.status)) return bad('Bad status'); patch.status = b.status; }
    if (b.admin_note !== undefined) patch.admin_note = String(b.admin_note).slice(0, 1000);
    const [row] = await db.update('support_messages', { id: sm[1] }, patch);
    return row ? [200, { message: row }] : bad('Message not found', 404);
  }

  if (p === '/api/admin/settings' && m === 'GET') return [200, { settings: await getSettings(db, env), routes: ROUTES, seats: ALL_SEATS }];
  if (p === '/api/admin/settings' && m === 'PUT') return [200, { settings: await saveSettings(db, env, body) }];
  return bad('Not found', 404);
}
