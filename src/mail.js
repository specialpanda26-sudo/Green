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
  const wa = String(S.whatsapp || '').replace(/\D/g, '');
  const waShow = wa.length === 12 && wa.startsWith('254') ? '+' + wa.slice(0, 3) + ' ' + wa.slice(3, 6) + ' ' + wa.slice(6, 9) + ' ' + wa.slice(9) : (wa ? '+' + wa : '');
  const waLink = wa ? 'https://wa.me/' + wa + '?text=' + encodeURIComponent('Hello Greenline Buses, my ticket code is ' + b.ref) : '';
  const names = (b.seats || []).map((s) => pax[s] || '').filter(Boolean).join(', ');
  const rows = [['Seats', (b.seats || []).join(', ')], ['Passengers', names], ['Paid', kes(b.total) + ' by M-PESA' + (receipt ? ' (' + receipt + ')' : '')]].filter((r) => r[1]);
  const note = 'Be at the boarding point 30 minutes before departure. Carry the ID or passport used to book. Tickets are non-refundable.';
  const text = 'Greenline Buses: your e-ticket (payment confirmed)\n\nTicket code: ' + b.ref + '\nRoute: Nairobi to ' + b.route + '\nTravel date: ' + b.travel_date + '\nDeparts: ' + (S.departure || '')
    + '\n' + rows.map((r) => r[0] + ': ' + r[1]).join('\n') + '\n\nShow the ticket code ' + b.ref + ' at boarding.\n' + note
    + (waLink ? '\n\nQuestions? Chat with us on WhatsApp: ' + waLink : '') + (site ? '\nLost this email? Get your ticket again: ' + site + '/#ticket' : '') + '\n';
  const F = 'font-family:Arial,Helvetica,sans-serif;';
  const btn = (href, label, bg, fg, border) => '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 10px"><tr><td align="center" bgcolor="' + bg + '" style="border-radius:12px;border:2px solid ' + border + '"><a href="' + esc(href) + '" style="display:block;padding:13px 26px;' + F + 'font-size:15px;font-weight:bold;color:' + fg + ';text-decoration:none">' + label + '</a></td></tr></table>';
  const detail = rows.map((r) => '<tr><td style="padding:11px 0;border-bottom:1px solid #eaeee6;' + F + 'font-size:13px;color:#6a7a6f;width:105px;vertical-align:top">' + esc(r[0]) + '</td><td style="padding:11px 0;border-bottom:1px solid #eaeee6;' + F + 'font-size:15px;font-weight:bold;color:#10231a">' + esc(r[1]) + '</td></tr>').join('');
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#e9eee6">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your ticket ' + esc(b.ref) + ' to ' + esc(b.route) + ' on ' + esc(b.travel_date) + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:20px;overflow:hidden">'
    + '<tr><td bgcolor="#14502b" style="background:#14502b;padding:20px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
    + (site ? '<td width="76" valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:12px;padding:5px 6px"><img src="' + esc(site) + '/logo.webp" width="56" alt="GL" style="display:block;border:0;height:auto"></td></tr></table></td>' : '')
    + '<td valign="middle"><div style="' + F + 'font-size:20px;font-weight:bold;color:#ffffff;letter-spacing:.3px">Greenline Buses</div><div style="' + F + 'font-size:12px;color:#bfe0c6;margin-top:3px;letter-spacing:1px;text-transform:uppercase">E-ticket</div></td>'
    + '<td align="right" valign="middle"><span style="display:inline-block;background:#e3f6e8;color:#14502b;' + F + 'font-size:12px;font-weight:bold;padding:7px 12px;border-radius:20px">&#10003; PAID</span></td>'
    + '</tr></table></td></tr>'
    + '<tr><td bgcolor="#d4a72c" style="background:#d4a72c;height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>'
    + '<tr><td style="padding:24px 24px 6px"><div style="' + F + 'font-size:11px;color:#6a7a6f;letter-spacing:1.4px;text-transform:uppercase">Route</div>'
    + '<div style="' + F + 'font-size:26px;font-weight:bold;color:#10231a;margin-top:4px">Nairobi &rarr; ' + esc(b.route) + '</div></td></tr>'
    + '<tr><td style="padding:10px 24px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
    + '<td width="50%" valign="top"><div style="' + F + 'font-size:11px;color:#6a7a6f;letter-spacing:1.4px;text-transform:uppercase">Date</div><div style="' + F + 'font-size:16px;font-weight:bold;color:#10231a;margin-top:3px">' + esc(b.travel_date) + '</div></td>'
    + '<td width="50%" valign="top"><div style="' + F + 'font-size:11px;color:#6a7a6f;letter-spacing:1.4px;text-transform:uppercase">Departs</div><div style="' + F + 'font-size:16px;font-weight:bold;color:#10231a;margin-top:3px">' + esc(S.departure || '') + '</div></td>'
    + '</tr></table></td></tr>'
    + '<tr><td style="padding:18px 24px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#f1f6ee" style="background:#f1f6ee;border:2px dashed #a9c4ab;border-radius:14px;padding:16px 10px">'
    + '<div style="' + F + 'font-size:11px;color:#6a7a6f;letter-spacing:1.4px;text-transform:uppercase">Ticket code</div>'
    + '<div style="font-family:Consolas,Menlo,monospace;font-size:34px;font-weight:bold;color:#14502b;letter-spacing:5px;margin:6px 0 4px">' + esc(b.ref) + '</div>'
    + '<div style="' + F + 'font-size:12px;color:#6a7a6f">Show this code at boarding</div></td></tr></table></td></tr>'
    + '<tr><td style="padding:8px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + detail + '</table></td></tr>'
    + '<tr><td style="padding:18px 24px 8px"><div style="background:#fff7e6;border:1px solid #f1dba6;border-left:4px solid #d4a72c;border-radius:10px;padding:12px 14px;' + F + 'font-size:13px;line-height:1.55;color:#5b4410">' + esc(note) + '</div></td></tr>'
    + '<tr><td align="center" style="padding:14px 24px 6px">'
    + (waLink ? btn(waLink, 'Chat with us on WhatsApp', '#128c7e', '#ffffff', '#128c7e') : '')
    + (site ? btn(site + '/#ticket', 'View my ticket online', '#ffffff', '#14502b', '#14502b') : '')
    + '</td></tr>'
    + '<tr><td bgcolor="#f6f8f4" style="background:#f6f8f4;padding:16px 24px;text-align:center;' + F + 'font-size:12px;line-height:1.7;color:#6a7a6f">'
    + (waLink ? 'Questions? <a href="' + esc(waLink) + '" style="color:#14502b;font-weight:bold;text-decoration:none">' + esc(waShow) + '</a><br>' : '')
    + (site ? 'Lost this email? Get your ticket again with your ticket code and M-PESA number.<br>' : '')
    + 'Greenline Buses Limited</td></tr>'
    + '</table></td></tr></table></body></html>';
  return { subject: 'Your Greenline ticket ' + b.ref + ': Nairobi to ' + b.route + ', ' + b.travel_date, text, html };
}
