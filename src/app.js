import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicRoutes } from './public.js';
import { adminRoutes } from './admin.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const PAGES = { '/': 'index.html', '/admin': 'admin.html' };

function readBody(req, max = 64 * 1024) {
  return new Promise((ok, no) => {
    let n = 0; const parts = [];
    req.on('data', (d) => { n += d.length; if (n > max) { no(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else parts.push(d); });
    req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { ok({}); } });
    req.on('error', no);
  });
}

async function serveFile(req, res, pathname) {
  let rel; try { rel = decodeURIComponent(pathname); } catch (e) { return false; }
  rel = PAGES[rel] || rel.replace(/^\/+/, '');
  if (!rel || rel.split('/').some((x) => x.startsWith('.') || x.includes('\\'))) return false;
  const file = path.join(DIR, rel);
  if (!file.startsWith(DIR + path.sep)) return false;
  let st; try { st = await fs.promises.stat(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

export function createApp(env, db) {
  const origins = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return http.createServer(async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    const url = new URL(req.url, 'http://localhost');
    const head = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) Object.assign(head, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' });
    const send = (status, data, extra = {}) => {
      if (typeof data === 'string') { res.writeHead(status, { ...head, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + extra.csv + '"', 'Cache-Control': 'no-store' }); return res.end(data); }
      res.writeHead(status, { ...head, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, head); return res.end(); }
      if (url.pathname === '/healthz') return send(200, { ok: true });
      if (url.pathname.startsWith('/api/')) {
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        const c = { req, url, db, env, ip, body };
        const out = (await publicRoutes(c)) || (await adminRoutes(c));
        return out ? send(out[0], out[1], out[2]) : send(404, { error: 'Not found' });
      }
      if (await serveFile(req, res, url.pathname)) return;
      if (url.pathname === '/') return send(200, { ok: true, service: 'Greenline Buses API. Add frontend/index.html to show the website.' });
      return send(404, { error: 'Not found' });
    } catch (e) {
      if (e && e.status && e.status < 500) return send(e.status, { error: e.message });
      console.error('request failed', req.method, url.pathname, e && e.stack || e);
      return send(500, { error: 'Something went wrong. Please try again.' });
    }
  });
}
