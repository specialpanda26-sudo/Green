// PayHero (FinoQ) v2. Same wiring as ComradeConnect: STK push, status check, webhook parser. No database writes here.
export const finoqBase = (env) => String(env.PAYHERO_BASE_URL || 'https://backend.payhero.co.ke').replace(/\/+$/, '');
export const finoqChannel = (env) => { const n = Number(String(env.PAYHERO_CHANNEL_ID || '').trim()); return Number.isFinite(n) && n > 0 ? n : 0; };
export const finoqProvider = (env) => (String(env.PAYHERO_PROVIDER || '').trim().toLowerCase() === 'sasapay' ? 'sasapay' : 'm-pesa');
export const finoqReady = (env) => !!(String(env.PAYHERO_API_KEY || '').trim() && String(env.PAYHERO_API_SECRET || '').trim() && finoqChannel(env));
export const finoqHead = (env) => ({ 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(String(env.PAYHERO_API_KEY || '').trim() + ':' + String(env.PAYHERO_API_SECRET || '').trim()) });
export const finoqCallback = (env) => String(env.CALLBACK_URL || env.PAYHERO_CALLBACK_URL || '').trim();
export const payRef = (id) => 'GL-' + String(id).replace(/[^0-9a-f-]/gi, '').toUpperCase();
const localPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.startsWith('254') ? '0' + d.slice(3) : d; };

export async function finoqStkPush(env, { amount, phone, ref }) {
  const body = { amount: Math.floor(Number(amount)), phone_number: localPhone(phone), channel_id: finoqChannel(env), provider: finoqProvider(env), external_reference: ref };
  if (String(env.PAYHERO_ACCOUNT_ID || "").trim()) body.account_id = Number(String(env.PAYHERO_ACCOUNT_ID).trim());
  if (body.provider === 'sasapay') body.network_code = '63902';
  const cb = finoqCallback(env); if (cb) body.callback_url = cb;
  let r;
  try { r = await fetch(finoqBase(env) + '/api/v2/payments', { method: 'POST', headers: finoqHead(env), body: JSON.stringify(body) }); }
  catch (e) { console.error('finoq: STK push failed to send', e && e.message); return { error: 'no response', status: 0, data: {} }; }
  const raw = await r.text().catch(() => '');
  let t = {}; try { t = raw ? JSON.parse(raw) : {}; } catch (e) { t = { raw: raw.slice(0, 300) }; }
  if (!r.ok) { console.error('finoq: STK push refused', r.status, JSON.stringify(t).slice(0, 300)); return { error: t.error_message || t.message || t.error || 'refused', status: r.status, data: t }; }
  return { ok: true, data: t };
}

// POST /api/global/transaction-status { request_id }. An unknown status is never treated as failure.
export async function finoqStatus(env, reference) {
  const none = { ok: false, status: '', success: false, failed: false, receipt: '', amount: 0, data: {} };
  if (!String(reference || '').trim()) return none;
  const docs = /payhero\.co\.ke/i.test(finoqBase(env)), base = finoqBase(env), ref = String(reference);
  const viaGet = () => fetch(base + '/api/v2/transaction-status?reference=' + encodeURIComponent(ref), { method: 'GET', headers: finoqHead(env) });
  const viaPost = () => fetch(base + '/api/global/transaction-status', { method: 'POST', headers: finoqHead(env), body: JSON.stringify({ request_id: ref }) });
  // PayHero documents the GET form; the POST form also exists. Try the documented one first and fall back if it is refused.
  let r = null;
  for (const go of docs ? [viaGet, viaPost] : [viaPost, viaGet]) {
    try { r = await go(); } catch (e) { console.error('finoq: status request failed', e && e.message); r = null; continue; }
    if (r.ok) break;
  }
  if (!r) return none;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('finoq: status refused', r.status, JSON.stringify(data).slice(0, 300)); return { ...none, data }; }
  const x = parseFinoqWebhook(data);
  return { ok: true, status: x.status, success: x.success, failed: x.failed, receipt: x.receipt, amount: x.amount, data };
}

// Reads nested {response:{...}} and flat snake_case callbacks.
export function parseFinoqWebhook(body) {
  const b = body && typeof body === 'object' ? body : {};
  const norm = (o) => { const m = {}; if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) m[k.toLowerCase().replace(/_/g, '')] = v; return m; };
  const nested = [b.response, b.data, b.transaction].find((x) => x && typeof x === 'object');
  const inner = norm(nested), outer = norm(b);
  const get = (...keys) => { for (const src of [inner, outer]) for (const k of keys) { const v = src[k]; if (v !== undefined && v !== null && v !== '' && typeof v !== 'boolean') return v; } return undefined; };
  const status = String(get('status', 'transactionstatus', 'state') || '').trim().toUpperCase();
  return {
    status,
    ref: String(get('externalreference', 'externalref') || '').trim(),
    amount: Number(get('amount', 'value') || 0),
    phone: String(get('phonenumber', 'phone', 'msisdn') || '').replace(/\D/g, ''),
    receipt: String(get('providerreference', 'mpesareceiptnumber', 'mpesareceipt', 'transactionid', 'reference', 'receipt', 'checkoutrequestid') || '').trim().toUpperCase(),
    code: Number(get('resultcode', 'failedcode') || 0) || null,
    success: ['SUCCESS', 'COMPLETE', 'COMPLETED', 'PAID', 'CONFIRMED'].includes(status),
    failed: ['FAILED', 'FAILURE', 'CANCELED', 'CANCELLED', 'REJECTED', 'DECLINED', 'TIMEOUT'].includes(status),
  };
}
