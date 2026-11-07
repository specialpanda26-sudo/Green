// Payments for tickets. Only the PayHero webhook (or a status check) marks a payment paid or failed.
// A seat is held in booked_seats while the payment is open, so two people can never hold the same seat.
import crypto from 'node:crypto';
import { finoqReady, finoqStkPush, finoqStatus, payRef } from './finoq.js';
import { ago } from './util.js';
import { sendMail, mailReady, ticketEmail } from './mail.js';
import { getSettings } from './settings.js';

const now = () => new Date().toISOString();
const OPEN = { in: ['pending', 'expired'] };
export const holdMs = (env) => Math.max(3, Number(env.HOLD_MINUTES) || 10) * 60e3;
export const failReason = (code) => ({ 1: 'insufficient', 1032: 'cancelled', 1037: 'timeout', 2001: 'wrong_pin', 1001: 'busy', 1019: 'expired' }[Number(code)] || 'other');
export const releaseSeats = (db, bookingId) => db.remove('booked_seats', { booking_id: bookingId });
const takeSeats = (db, b) => db.insert('booked_seats', b.seats.map((seat) => ({ route: b.route, travel_date: b.travel_date, seat, booking_id: b.id })));

export async function startPayment({ db, env }, bk, ip) {
  if (!finoqReady(env)) return { error: 'Payments are not set up yet', status: 503 };
  const id = crypto.randomUUID(), ref = payRef(id);
  const made = await db.insert('payments', { id, booking_id: bk.id, request_id: ref, phone: bk.phone, amount: bk.total, ip: ip || null });
  if (!made.rows.length) return { error: 'Could not save the payment', status: 500 };
  const r = await finoqStkPush(env, { amount: bk.total, phone: bk.phone, ref });
  if (!r || r.error) {
    await db.update('payments', { id, status: 'pending' }, { status: 'failed', fail_reason: 'not_sent' });
    return { error: 'Could not send the M-PESA prompt. Please try again.', status: 502 };
  }
  const d = r.data || {}, prov = String(d.reference || d.Reference || d.CheckoutRequestID || d.checkout_request_id || '').trim();
  if (prov) await db.update('payments', { id, status: 'pending' }, { checkout_id: prov });
  return { id };
}

// cb: { ref, success, failed, amount, phone, receipt, code, note }. Safe to call twice with the same callback.
async function settleCore({ db }, cb) {
  if (!cb.ref) return 'noref';
  const [p] = await db.select('payments', { request_id: cb.ref }, { limit: 1 });
  if (!p) return 'unknown';
  const [bk] = await db.select('bookings', { id: p.booking_id }, { limit: 1 });
  if (!bk) return 'unknown';

  if (cb.success) {
    if (!['pending', 'expired'].includes(p.status)) return 'duplicate';
    if (!(cb.amount > 0)) return 'no_amount'; // a missing amount is never treated as fully paid
    const diff = cb.phone && p.phone && cb.phone.slice(-9) !== String(p.phone).slice(-9) ? 'Paid from a different number: ' + cb.phone : null;
    const note = cb.note || diff || null;
    if (cb.amount < p.amount) {
      const [u] = await db.update('payments', { id: p.id, status: OPEN }, { status: 'underpaid', receipt: cb.receipt || null, note: note || 'Paid KES ' + cb.amount + ' of ' + p.amount });
      if (u) await db.update('bookings', { id: bk.id, status: { in: ['pending', 'expired'] } }, { status: 'review' });
      return 'underpaid';
    }
    const [upd] = await db.update('payments', { id: p.id, status: OPEN }, { status: 'paid', receipt: cb.receipt || null, paid_at: now(), ...(note ? { note } : {}) });
    if (!upd) return 'duplicate';
    try {
      if (bk.status === 'paid') return 'paid';
      if (bk.status === 'pending') { await db.update('bookings', { id: bk.id, status: 'pending' }, { status: 'paid', paid_at: now() }); return 'paid'; }
      // Money arrived after the hold expired: try to get the seats back, otherwise flag it for a refund.
      const re = await takeSeats(db, bk);
      await db.update('bookings', { id: bk.id }, re.conflict ? { status: 'review' } : { status: 'paid', paid_at: now() });
      return re.conflict ? 'seat_lost' : 'paid_late';
    } catch (e) {
      await db.update('payments', { id: p.id, status: 'paid' }, { status: 'expired' }); // reopen so a repeated callback can finish the job
      throw e;
    }
  }

  if (cb.failed) {
    if (p.status !== 'pending') return 'duplicate';
    const [f] = await db.update('payments', { id: p.id, status: 'pending' }, { status: 'failed', fail_reason: failReason(cb.code), fail_code: cb.code ?? null });
    if (!f) return 'duplicate';
    const [b] = await db.update('bookings', { id: bk.id, status: 'pending' }, { status: 'failed' });
    if (b) await releaseSeats(db, bk.id);
    return 'failed';
  }
  return 'waiting';
}

// Emails the e-ticket once. The conditional update claims the send, so two callbacks at the same moment can not send twice.
export async function emailTicket({ db, env }, bookingId) {
  if (!mailReady(env)) return 'not_set_up';
  const [claim] = await db.update('bookings', { id: bookingId, status: 'paid', emailed_at: { is: null }, email: { not_null: true } }, { emailed_at: now() });
  if (!claim) return 'skipped';
  try {
    const [pay] = await db.select('payments', { booking_id: bookingId, status: 'paid' }, { limit: 1 });
    const r = await sendMail(env, { to: claim.email, ...ticketEmail(env, claim, await getSettings(db, env), pay && pay.receipt) });
    if (r.ok) return 'sent';
  } catch (e) { console.error('ticket email failed', e && e.message); }
  await db.update('bookings', { id: bookingId }, { emailed_at: null }); // let the next reconcile run try again
  return 'failed';
}

// Settles a payment, then emails the ticket if it just became paid. The email never holds up the answer for more than 4 seconds.
export async function settle(c, cb) {
  const out = await settleCore(c, cb);
  if ((out === 'paid' || out === 'paid_late') && c.env && mailReady(c.env)) {
    try {
      const [p] = await c.db.select('payments', { request_id: cb.ref }, { limit: 1 });
      if (p) await Promise.race([emailTicket(c, p.booking_id), new Promise((ok) => setTimeout(ok, 4000))]);
    } catch (e) { console.error('ticket email failed', e && e.message); }
  }
  return out;
}

// Runs every minute: ask PayHero about open payments (a missed webhook must never lose a paid ticket), then expire old holds.
export async function reconcile({ db, env }) {
  let asked = 0, expired = 0;
  try {
    const open = await db.select('payments', { status: OPEN, checkout_id: { not_null: true }, created_at: { gte: ago(6 * 3600e3), lte: ago(90e3) } }, { order: 'created_at.asc', limit: 25 });
    for (const p of open) {
      const st = await finoqStatus(env, p.checkout_id);
      if (!st.ok) continue;
      asked++;
      if (st.success) await settle({ db, env }, { ref: p.request_id, success: true, amount: p.amount, phone: '', receipt: st.receipt || p.checkout_id });
      else if (st.failed) await settle({ db }, { ref: p.request_id, failed: true, code: null });
    }
  } catch (e) { console.error('reconcile: status check failed', e && e.message); }
  try {
    const old = await db.select('payments', { status: 'pending', created_at: { lt: ago(holdMs(env)) } }, { limit: 100 });
    for (const p of old) {
      const [x] = await db.update('payments', { id: p.id, status: 'pending' }, { status: 'expired', fail_reason: 'no_response' });
      if (!x) continue;
      const [b] = await db.update('bookings', { id: p.booking_id, status: 'pending' }, { status: 'expired' });
      if (b) await releaseSeats(db, b.id);
      expired++;
    }
  } catch (e) { console.error('reconcile: expiry failed', e && e.message); }
  try { // tickets whose email did not go out (provider down, bad key): try again for a day
    if (mailReady(env)) for (const b of await db.select('bookings', { status: 'paid', emailed_at: { is: null }, email: { not_null: true }, paid_at: { gte: ago(24 * 3600e3) } }, { limit: 20 })) await emailTicket({ db, env }, b.id);
  } catch (e) { console.error('reconcile: email retry failed', e && e.message); }
  return { asked, expired };
}
