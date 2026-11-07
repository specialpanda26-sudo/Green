import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { parseFinoqWebhook, finoqStatus } from '../src/finoq.js';
import { reconcile, emailTicket } from '../src/payments.js';
import { normPhone, resetHits, nairobiToday, addDays, ago } from '../src/util.js';

const ENV = { DB_MODE: 'memory', ADMIN_KEY: 'admin-secret-1234', PAYHERO_API_KEY: 'k', PAYHERO_API_SECRET: 's', PAYHERO_CHANNEL_ID: '777', PAYHERO_CALLBACK_SECRET: 'sec', CALLBACK_URL: 'https://x.test/api/webhooks/payhero?s=sec', HOLD_MINUTES: '10', WHATSAPP_NUMBER: '254700000001' };
const A = { 'X-Admin-Key': ENV.ADMIN_KEY };
const trip = () => addDays(nairobiToday(), 3);
const body = (o = {}) => ({ to: 'Kisumu', date: trip(), seats: ['10'], pax: { 10: 'Amina Otieno' }, phone: '0712 345 678', email: 'amina@example.com', ...o });
const hook = (ref, o = {}) => ({ response: { ExternalReference: ref, Status: 'Success', Amount: 1300, Phone: '254712345678', MpesaReceiptNumber: 'abc123xyz1', ...o } });

async function boot(t) {
  resetHits();
  const real = globalThis.fetch, seen = [], checks = [], state = { status: { status: 'QUEUED' } };
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).includes('payhero.co.ke')) return real(url, init);
    const isCheck = String(url).includes('/transaction-status');
    (isCheck ? checks : seen).push({ url: String(url), body: JSON.parse(init.body || '{}'), auth: init.headers.Authorization });
    return new Response(JSON.stringify(isCheck ? state.status : { success: true, status: 'QUEUED', reference: 'PH-' + seen.length }), { status: 200 });
  };
  const db = makeDb(ENV), server = createApp(ENV, db);
  await new Promise((ok) => server.listen(0, ok));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { globalThis.fetch = real; server.closeAllConnections(); server.close(); });
  const call = async (method, path, b, headers = {}) => {
    const r = await real(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: b ? JSON.stringify(b) : undefined });
    const text = await r.text(); let data = text; try { data = JSON.parse(text); } catch (e) { /* csv */ }
    return { status: r.status, data };
  };
  const wh = (b, s = 'sec') => call('POST', '/api/webhooks/payhero?s=' + s, b);
  const status = async (id) => (await call('GET', '/api/book/status?id=' + id)).data;
  const taken = async () => (await call('GET', '/api/seats?to=Kisumu&date=' + trip())).data.taken;
  return { db, call, seen, state, wh, status, taken };
}

test('phone numbers and PayHero callbacks are read correctly', () => {
  assert.equal(normPhone('0712 345 678'), '254712345678');
  assert.equal(normPhone('+254 112 345 678'), '254112345678');
  assert.equal(normPhone('12345'), '');
  const ok = parseFinoqWebhook(hook('GL-1'));
  assert.equal(ok.success, true); assert.equal(ok.amount, 1300); assert.equal(ok.receipt, 'ABC123XYZ1'); assert.equal(ok.phone, '254712345678');
  assert.equal(parseFinoqWebhook({ response: { ExternalReference: 'GL-1', Status: 'Failed', ResultCode: 1032 } }).failed, true);
});

test('booking: server sets the price, sends the STK push, webhook issues the ticket once', async (t) => {
  const x = await boot(t);
  const r = await x.call('POST', '/api/book', body({ seats: ['1', '10'], pax: { 1: 'Amina Otieno', 10: 'Brian Mwangi' }, price: 1 }));
  assert.equal(r.status, 200); assert.equal(r.data.amount, 1300 + 500 + 1300);
  const s = x.seen[0];
  assert.equal(s.body.amount, 3100); assert.equal(s.body.phone_number, '0712345678'); assert.equal(s.body.channel_id, 777);
  assert.equal(s.body.callback_url, ENV.CALLBACK_URL); assert.match(s.body.external_reference, /^GL-/); assert.equal(s.auth, 'Basic ' + btoa('k:s'));
  assert.equal((await x.status(r.data.id)).status, 'pending');
  assert.equal((await x.wh(hook(s.body.external_reference, { Amount: 3100 }), 'wrong')).status, 403);
  assert.equal((await x.wh(hook(s.body.external_reference, { Amount: 3100 }))).data.result, 'paid');
  assert.equal((await x.wh(hook(s.body.external_reference, { Amount: 3100 }))).data.result, 'duplicate');
  const st = await x.status(r.data.id);
  assert.equal(st.status, 'paid'); assert.deepEqual(st.ticket.seats, ['1', '10']); assert.equal(st.ticket.receipt, 'ABC123XYZ1');
  assert.ok((await x.taken()).includes('10'));
  assert.equal((await x.call('GET', '/api/ticket?ref=' + r.data.ref + '&phone=0712345678')).data.status, 'paid');
  assert.equal((await x.call('GET', '/api/ticket?ref=' + r.data.ref + '&phone=0799999999')).status, 404);
});

test('two people can not hold the same seat', async (t) => {
  const x = await boot(t);
  assert.equal((await x.call('POST', '/api/book', body())).status, 200);
  const r = await x.call('POST', '/api/book', body({ phone: '0722000111', pax: { 10: 'Faith Akinyi' } }));
  assert.equal(r.status, 409); assert.deepEqual(r.data.taken, ['10']); assert.equal(x.seen.length, 1);
  assert.equal((await x.call('POST', '/api/book', body({ seats: ['36'], pax: { 36: 'Crew Seat' } }))).status, 400);
});

test('failed and underpaid payments', async (t) => {
  const x = await boot(t);
  const a = await x.call('POST', '/api/book', body());
  await x.wh({ response: { ExternalReference: x.seen[0].body.external_reference, Status: 'Failed', ResultCode: 1032 } });
  const st = await x.status(a.data.id);
  assert.equal(st.status, 'failed'); assert.equal(st.reason, 'cancelled'); assert.ok(!(await x.taken()).includes('10'));
  const b = await x.call('POST', '/api/book', body({ phone: '0722000111' }));
  assert.equal((await x.wh(hook(x.seen[1].body.external_reference, { Amount: 500 }))).data.result, 'underpaid');
  assert.equal((await x.status(b.data.id)).status, 'review');
});

test('late success after the hold expired gets the seat back, or goes to review if it was resold', async (t) => {
  const x = await boot(t);
  const a = await x.call('POST', '/api/book', body());
  await x.db.update('payments', { booking_id: a.data.id }, { created_at: ago(30 * 60e3) });
  assert.deepEqual(await reconcile({ db: x.db, env: ENV }), { asked: 1, expired: 1 });
  assert.equal((await x.status(a.data.id)).status, 'expired'); assert.ok(!(await x.taken()).includes('10'));
  assert.equal((await x.wh(hook(x.seen[0].body.external_reference))).data.result, 'paid_late');
  assert.equal((await x.status(a.data.id)).status, 'paid');
  const b = await x.call('POST', '/api/book', body({ seats: ['11'], pax: { 11: 'Faith Akinyi' }, phone: '0722000111' }));
  await x.db.update('payments', { booking_id: b.data.id }, { created_at: ago(30 * 60e3) });
  await reconcile({ db: x.db, env: ENV });
  await x.call('POST', '/api/book', body({ seats: ['11'], pax: { 11: 'Joy Wanjiru' }, phone: '0733000222' }));
  assert.equal((await x.wh(hook(x.seen[1].body.external_reference))).data.result, 'seat_lost');
  assert.equal((await x.status(b.data.id)).status, 'review');
});

test('admin: transactions, re-check when the webhook never came, support inbox, settings', async (t) => {
  const x = await boot(t);
  assert.equal((await x.call('GET', '/api/admin/summary', null, { 'X-Admin-Key': 'nope' })).status, 401);
  const a = await x.call('POST', '/api/book', body());
  x.state.status = { status: 'SUCCESS', provider_reference: 'qwe123rty4' };
  const pay = (await x.call('GET', '/api/admin/payments?q=amina', null, A)).data.payments[0];
  assert.equal(pay.booking.ref, a.data.ref);
  assert.equal((await x.call('POST', '/api/admin/payments/' + pay.id + '/recheck', {}, A)).data.result, 'paid');
  assert.equal((await x.status(a.data.id)).status, 'paid');
  assert.match((await x.call('GET', '/api/admin/payments.csv', null, A)).data, /QWE123RTY4/);
  assert.equal((await x.call('GET', '/api/admin/manifest?to=Kisumu&date=' + trip(), null, A)).data.rows[0].name, 'Amina Otieno');
  const sm = await x.call('POST', '/api/support', { message: 'My ticket has the wrong date' });
  assert.equal(sm.status, 400);
  assert.equal((await x.call('POST', '/api/support', { message: 'My ticket has the wrong date', phone: '0712345678', ref: a.data.ref })).status, 200);
  assert.equal((await x.call('GET', '/api/admin/summary', null, A)).data.support_open, 1);
  const msg = (await x.call('GET', '/api/admin/support', null, A)).data.messages[0];
  assert.equal(msg.booking_ref, a.data.ref);
  assert.equal((await x.call('PATCH', '/api/admin/support/' + msg.id, { status: 'replied', admin_note: 'Called' }, A)).data.message.status, 'replied');
  assert.equal((await x.call('GET', '/api/admin/summary', null, A)).data.support_open, 0);
  assert.equal((await x.call('PUT', '/api/admin/settings', { fares: { Kisumu: 1500 }, whatsapp: '0700 111 222' }, A)).status, 200);
  assert.equal((await x.call('PUT', '/api/admin/settings', { vip_extra: -5 }, A)).status, 400);
  const cfg = (await x.call('GET', '/api/config')).data;
  assert.equal(cfg.routes.find((r) => r.name === 'Kisumu').fare, 1500); assert.equal(cfg.whatsapp, '254700111222');
  assert.equal((await x.call('POST', '/api/book', body({ seats: ['12'], pax: { 12: 'Joy Wanjiru' }, phone: '0733000222' }))).data.amount, 1500);
});

test('status check uses the documented GET on the PayHero host', async () => {
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, init = {}) => { seen.push({ url: String(url), method: init.method }); return new Response(JSON.stringify({ success: true, status: 'SUCCESS', reference: 'TX1' }), { status: 200 }); };
  try {
    const st = await finoqStatus({ ...ENV, PAYHERO_BASE_URL: 'https://backend.payhero.co.ke' }, 'TX1');
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, 'https://backend.payhero.co.ke/api/v2/transaction-status?reference=TX1');
    assert.equal(st.success, true);
  } finally { globalThis.fetch = real; }
});

test('ticket email: sent once after payment, retried if Resend fails, admin can resend', async (t) => {
  const { call, wh, db } = await boot(t);
  const env2 = { ...ENV, RESEND_API_KEY: 're_test', MAIL_FROM: 'Greenline <tickets@greenline.test>' };
  const real = globalThis.fetch, mails = []; let fail = false;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.resend.com')) { mails.push(JSON.parse(init.body)); return fail ? new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 }) : new Response('{"id":"1"}', { status: 200 }); }
    return real(url, init);
  };
  t.after(() => { globalThis.fetch = real; });
  const r = await call('POST', '/api/book', body({ email: 'not-an-email' }));
  assert.equal(r.status, 400);
  const ok = await call('POST', '/api/book', body({ seats: ['30'], pax: { 30: 'Faith <b>Akinyi</b>' }, email: 'Faith@Example.com' }));
  assert.equal(ok.status, 200);
  const [pay] = await db.select('payments', { booking_id: ok.data.id }, { limit: 1 });
  // the running server has no Resend keys, so no mail yet: pay, then send with the keys
  await wh(hook(pay.request_id));
  assert.equal(mails.length, 0);
  assert.equal(await emailTicket({ db, env: env2 }, ok.data.id), 'sent');
  assert.equal(await emailTicket({ db, env: env2 }, ok.data.id), 'skipped');
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['faith@example.com']);
  assert.ok(mails[0].subject.includes(ok.data.ref));
  assert.ok(!mails[0].html.includes('<b>Akinyi</b>'), 'names are escaped in the email');
  assert.ok(mails[0].text.includes('Seats: 30'));
  // Resend refuses: the claim is released so reconcile retries it
  const b2 = await call('POST', '/api/book', body({ seats: ['31'], pax: { 31: 'Brian Mwangi' }, phone: '0722 111 222' }));
  const [p2] = await db.select('payments', { booking_id: b2.data.id }, { limit: 1 });
  await wh(hook(p2.request_id)); fail = true;
  assert.equal(await emailTicket({ db, env: env2 }, b2.data.id), 'failed');
  fail = false;
  await reconcile({ db, env: env2 });
  assert.equal(mails.length, 3);
  const [row] = await db.select('bookings', { id: b2.data.id }, { limit: 1 });
  assert.ok(row.emailed_at);
});
