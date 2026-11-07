// Sends e-tickets by email with Resend (https://resend.com). Needs RESEND_API_KEY and MAIL_FROM,
// e.g. "Greenline Buses <tickets@yourdomain.co.ke>" (a domain verified in Resend).
// Never logs the recipient or the message.
const has = (v) => !!String(v || '').trim();
export const mailReady = (env) => has(env.RESEND_API_KEY) && has(env.MAIL_FROM);
export const validEmail = (v) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()) && String(v).length <= 100;
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kes = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE');

// Returns { ok, status, detail }. detail is Resend's own explanation when it refuses.
export async function sendMail(env, { to, subject, text, html }) {
  if (!mailReady(env)) return { ok: false, status: 0, detail: 'Email is not set up: RESEND_API_KEY and MAIL_FROM must both be set' };
  let r;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(env.RESEND_API_KEY).trim() },
      body: JSON.stringify({ from: String(env.MAIL_FROM).trim(), to: [to], subject, text, html }),
    });
  } catch (e) { console.error('mail: request failed', e && e.message); return { ok: false, status: 0, detail: 'Could not reach Resend: ' + (e && e.message) }; }
  let detail = '';
  if (!r.ok) { try { const d = await r.json(); detail = String(d.message || d.error || d.name || JSON.stringify(d)).slice(0, 300); } catch (e) { detail = ''; } }
  console.log('mail: resend answered ' + r.status + (detail ? ' (' + detail + ')' : ''));
  return { ok: r.ok, status: r.status, detail };
}

// Tells the admin why mail may not arrive.
export function mailDiagnosis(env) {
  const m = String(env.MAIL_FROM || '').match(/<([^>]+)>/), from = (m ? m[1] : String(env.MAIL_FROM || '')).trim(), dom = from.split('@')[1] || '';
  const notes = [];
  if (!has(env.RESEND_API_KEY)) notes.push('RESEND_API_KEY is missing.');
  if (!has(env.MAIL_FROM)) notes.push('MAIL_FROM is missing.');
  if (/^(gmail|googlemail|yahoo|outlook|hotmail|icloud)\./i.test(dom)) notes.push('MAIL_FROM uses a free-mail address. Use an address on your own domain, verified in Resend.');
  if (/^resend\.dev$/i.test(dom)) notes.push('onboarding@resend.dev can only send to the email that owns the Resend account. Verify your own domain in Resend before going live.');
  return { ready: mailReady(env), from_domain: dom || null, notes };
}

export function ticketEmail(env, b, S, receipt) {
  const site = String(env.SITE_URL || '').replace(/\/+$/, ''), pax = b.pax || {};
  const rows = [['Ticket code', b.ref], ['Route', 'Nairobi to ' + b.route], ['Travel date', b.travel_date], ['Departs', S.departure || ''],
    ['Seats', (b.seats || []).join(', ')], ['Passengers', (b.seats || []).map((s) => pax[s] || '').filter(Boolean).join(', ')], ['Paid', kes(b.total) + ' by M-PESA' + (receipt ? ' (' + receipt + ')' : '')]];
  const wa = String(S.whatsapp || '').replace(/\D/g, '');
  const note = 'Be at the boarding point 30 minutes before departure. Carry the ID or passport used to book. Tickets are non-refundable.';
  const text = 'Greenline Buses: your ticket\n\n' + rows.map((r) => r[0] + ': ' + r[1]).join('\n') + '\n\nShow the ticket code ' + b.ref + ' at boarding.\n' + note + (wa ? '\nQuestions? WhatsApp +' + wa : '') + '\n';
  const tr = rows.map((r) => '<tr><td style="padding:8px 0;color:#5a6b60;font:13px Arial,sans-serif;width:110px;vertical-align:top">' + esc(r[0]) + '</td><td style="padding:8px 0;color:#10231a;font:bold 14px Arial,sans-serif">' + esc(r[1]) + '</td></tr>').join('');
  const html = '<!doctype html><html><body style="margin:0;padding:0;background:#eef1ec"><div style="display:none;max-height:0;overflow:hidden;opacity:0">Your ticket ' + esc(b.ref) + ' to ' + esc(b.route) + ' on ' + esc(b.travel_date) + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden">'
    + '<tr><td style="background:#1f6b3a;padding:22px 24px"><div style="font:bold 20px Arial,sans-serif;color:#ffffff">Greenline Buses</div><div style="font:14px Arial,sans-serif;color:#d6ecd9;margin-top:4px">E-ticket, payment confirmed</div></td></tr>'
    + '<tr><td style="padding:22px 24px 6px"><div style="font:bold 28px Arial,sans-serif;color:#10231a;letter-spacing:2px">' + esc(b.ref) + '</div><div style="font:13px Arial,sans-serif;color:#5a6b60;margin-top:4px">Show this code at boarding</div></td></tr>'
    + '<tr><td style="padding:6px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e3e6de">' + tr + '</table></td></tr>'
    + '<tr><td style="padding:8px 24px 22px"><div style="background:#fff6e5;border:1px solid #f3dca8;border-radius:10px;padding:12px 14px;font:13px/1.5 Arial,sans-serif;color:#5b4410">' + esc(note) + '</div>'
    + '<p style="font:12px/1.6 Arial,sans-serif;color:#5a6b60;margin:14px 0 0">' + (wa ? 'Questions? WhatsApp <a href="https://wa.me/' + esc(wa) + '" style="color:#1f6b3a">+' + esc(wa) + '</a>.<br>' : '') + (site ? 'Lost this email? Get your ticket again at <a href="' + esc(site) + '/#ticket" style="color:#1f6b3a">' + esc(site.replace(/^https?:\/\//, '')) + '/#ticket</a> with your ticket code and M-PESA number.' : '') + '</p></td></tr>'
    + '</table></td></tr></table></body></html>';
  return { subject: 'Your Greenline ticket ' + b.ref + ': Nairobi to ' + b.route + ', ' + b.travel_date, text, html };
}
