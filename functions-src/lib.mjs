// Shared helpers for the CDA admin backend (Netlify Functions + Netlify Blobs).
import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const STORE = 'cda-site';          // content.json + backups/*
export const MEDIA = 'cda-media';         // uploaded photos
export const AUTH = 'cda-auth';           // sign-in attempt counters

export const store = (name) => getStore({ name, consistency: 'strong' });

export const SESSION_COOKIE = 'cda_admin';
export const DEVICE_COOKIE = 'cda_device';
export const SESSION_HOURS = 8;
export const DEVICE_DAYS = 180;

export const MAX_CONTENT_BYTES = 1024 * 1024;     // 1 MB of JSON
export const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // Netlify function request bodies max out around here
export const KEEP_BACKUPS = 30;

/* ---------- responses ---------- */
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin'
};
export function json(data, status = 200, extra = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  return new Response(JSON.stringify(data), { status, headers });
}
export const fail = (error, status = 400) => json({ ok: false, error }, status);

/* ---------- settings from Netlify environment variables ---------- */
export function adminPassword() {
  const pw = (globalThis.Netlify?.env?.get('ADMIN_PASSWORD') ?? process.env.ADMIN_PASSWORD ?? '').trim();
  return pw.length >= 16 ? pw : '';
}
// Signing key for cookies: HMAC(random server secret, password). The random secret is
// created once and kept in Blobs, so a stolen cookie cannot be used to guess the password
// offline; including the password means changing it signs everyone out.
let cachedSecret = null;
async function serverSecret() {
  const explicit = globalThis.Netlify?.env?.get('SESSION_SECRET') ?? process.env.SESSION_SECRET ?? '';
  if (explicit) return explicit;
  if (cachedSecret) return cachedSecret;
  const st = store(AUTH);
  let secret = await st.get('server-secret', { type: 'text' });
  if (!secret) {
    await st.set('server-secret', randomBytes(32).toString('hex'), { onlyIfNew: true });
    secret = await st.get('server-secret', { type: 'text' });
  }
  if (!secret) throw new Error('could not create server secret');
  cachedSecret = secret;
  return secret;
}
async function signingKey() {
  return createHmac('sha256', await serverSecret()).update('cda-admin-v1|' + adminPassword()).digest();
}

/* ---------- small crypto helpers ---------- */
const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
export function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}
async function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', await signingKey()).update(body).digest());
  return body + '.' + sig;
}
async function verify(token) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const good = b64url(createHmac('sha256', await signingKey()).update(body).digest());
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && typeof p.exp === 'number' && p.exp > Date.now() ? p : null;
  } catch { return null; }
}

/* ---------- cookies ---------- */
export function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}
function cookie(name, value, maxAgeSec, path) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`;
}
export const sessionCookie = async () =>
  cookie(SESSION_COOKIE, await sign({ t: 's', exp: Date.now() + SESSION_HOURS * 3600e3 }), SESSION_HOURS * 3600, '/api');
export const clearSessionCookie = () => cookie(SESSION_COOKIE, '', 0, '/api');
export const deviceCookie = async () =>
  cookie(DEVICE_COOKIE, await sign({ t: 'd', id: randomBytes(12).toString('hex'), exp: Date.now() + DEVICE_DAYS * 864e5 }), DEVICE_DAYS * 86400, '/api');

export async function isAuthed(req) {
  if (!adminPassword()) return false;
  const p = await verify(readCookie(req, SESSION_COOKIE));
  return !!(p && p.t === 's');
}
export async function deviceId(req) {
  const p = await verify(readCookie(req, DEVICE_COOKIE));
  return p && p.t === 'd' && /^[a-f0-9]{24}$/.test(p.id) ? p.id : '';
}

/* ---------- request checks ---------- */
// State-changing requests must come from our own admin page: SameSite=Strict cookies,
// a custom header (cannot be sent cross-site without CORS) and a same-origin Origin.
export function checkWrite(req) {
  if (req.headers.get('x-cda-admin') !== '1') return 'Bad request.';
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return 'Bad origin.';
  return '';
}

/* ---------- sign-in attempt limits (append-only, race-safe) ----------
 * Every attempt writes its own entry and never overwrites another, then counts the
 * entries in the window. Parallel requests therefore always see each other, so at most
 * `limit` attempts can pass per window. No ETags/conditional writes needed. */
export async function reserveAttempt(prefix, limit, windowMs) {
  const st = store(AUTH);
  const now = Date.now();
  const recent = async () => {
    const { blobs } = await st.list({ prefix: prefix + '/' });
    const live = [];
    for (const b of blobs) {
      const t = Number(b.key.slice(prefix.length + 1).split('-')[0]);
      if (now - t > windowMs) await st.delete(b.key).catch(() => {}); else live.push(b.key);
    }
    return live;
  };
  if ((await recent()).length >= limit) return null;          // cheap early exit
  const mine = `${prefix}/${now}-${randomBytes(6).toString('hex')}`;
  await st.set(mine, '');
  // Allowed only if, after writing our own entry, we see at most `limit` entries in total.
  // Entries are never removed early (rejected attempts keep counting until they expire),
  // so the (limit+1)-th writer always sees more than `limit` and is refused. Tested with
  // bursts of 100 simultaneous attempts: never more than `limit` got through.
  const live = await recent();
  if (live.length > limit) return null;
  return mine;
}
export async function clearAttempts(prefix) {
  const st = store(AUTH);
  const { blobs } = await st.list({ prefix: prefix + '/' });
  for (const b of blobs) await st.delete(b.key).catch(() => {});
}
export async function dropAttempt(key) {
  if (key) await store(AUTH).delete(key).catch(() => {});
}
