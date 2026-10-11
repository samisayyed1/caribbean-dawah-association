// CDA admin API. Routes (all JSON):
//   GET    /api/content            public: content saved from the admin (404 until the first publish)
//   GET    /api/session            { configured, authed }
//   POST   /api/login              { password }
//   POST   /api/logout
//   GET    /api/admin/content      { content|null, version }
//   PUT    /api/admin/content      { content, base }  -> 409 if someone else published meanwhile
//   POST   /api/admin/upload?name= raw JPG/PNG/WebP body -> { path: "media/<name>" }
//   GET    /api/admin/backups
//   POST   /api/admin/restore      { key }
import {
  STORE, MEDIA, store, json, fail, adminPassword, safeEqual, sha256hex,
  sessionCookie, clearSessionCookie, deviceCookie, isAuthed, deviceId, checkWrite,
  reserveAttempt, clearAttempts, dropAttempt,
  MAX_CONTENT_BYTES, MAX_IMAGE_BYTES, KEEP_BACKUPS
} from './lib.mjs';

const CONTENT_KEY = 'content.json';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,100}\.(jpg|jpeg|png|webp)$/;
const BACKUP_RE = /^backups\/\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{6}\.json$/;

// Sign-in limits: 5 failures per browser/IP per 15 minutes; unknown browsers are
// also capped at 50 failures per 15 minutes in total. A browser that has signed in
// before is never locked out by other people's failures.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const MAX_FAILS_UNTRUSTED = 50;

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = req.method;
  try {
    if (route === 'content' && method === 'GET') return publicContent(req);
    if (route === 'session' && method === 'GET') {
      return json({ ok: true, configured: !!adminPassword(), authed: await isAuthed(req) });
    }
    if (route === 'login' && method === 'POST') return login(req, context);
    if (route === 'logout' && method === 'POST') {
      const bad = checkWrite(req); if (bad) return fail(bad, 400);
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    }

    if (route.startsWith('admin/')) {
      if (!(await isAuthed(req))) return fail('Please sign in.', 401);
      if (method !== 'GET') { const bad = checkWrite(req); if (bad) return fail(bad, 400); }
      const sub = route.slice(6);
      if (sub === 'content' && method === 'GET') return adminContent();
      if (sub === 'content' && method === 'PUT') return saveContent(req);
      if (sub === 'upload' && method === 'POST') return upload(req, url);
      if (sub === 'backups' && method === 'GET') return listBackups();
      if (sub === 'restore' && method === 'POST') return restore(req);
    }
    return fail('Not found.', 404);
  } catch (err) {
    console.error(err);
    return fail('Something went wrong on the server. Please try again.', 500);
  }
};

export const config = { path: '/api/*' };

/* ---------------- public content ---------------- */
async function publicContent(req) {
  const hit = await store(STORE).getWithMetadata(CONTENT_KEY, { type: 'text' });
  // Nothing published from the admin yet: the page uses the content shipped with the site.
  if (!hit) return json({ ok: true, empty: true });
  const etag = '"' + (hit.etag || sha256hex(hit.data)).replace(/"/g, '') + '"';
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(hit.data, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      // Netlify's CDN may reuse this for up to a minute, so most visits don't run the function.
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

/* ---------------- sign in ---------------- */
async function login(req, context) {
  const bad = checkWrite(req); if (bad) return fail(bad, 400);
  const password = adminPassword();
  if (!password) return fail('The admin password has not been set up yet. Add ADMIN_PASSWORD (16+ characters) in Netlify, then redeploy.', 503);

  let body;
  try { body = await req.json(); } catch { return fail('Bad request.'); }
  const attempt = typeof body?.password === 'string' ? body.password.slice(0, 200) : '';

  const device = await deviceId(req);
  const key = device ? 'dev-' + device : 'ip-' + sha256hex('cda|' + (context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown')).slice(0, 32);
  const tooMany = () => fail('Too many attempts. Please wait 15 minutes and try again.', 429);

  // Each attempt is recorded before the password is checked, so parallel guesses cannot slip through.
  const mine = await reserveAttempt(key, MAX_FAILS, WINDOW_MS);
  if (!mine) return tooMany();
  let shared = null;
  if (!device) {
    shared = await reserveAttempt('untrusted', MAX_FAILS_UNTRUSTED, WINDOW_MS);
    if (!shared) return tooMany();
  }

  if (!safeEqual(attempt, password)) {
    await new Promise((r) => setTimeout(r, 600));
    return fail('That password is not correct.', 401);
  }

  // Success: forget this browser's failures and give back its share of the global allowance.
  await clearAttempts(key);
  await dropAttempt(shared);
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', await sessionCookie());
  headers.append('Set-Cookie', await deviceCookie());
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/* ---------------- content ---------------- */
// The content version is our own hash of the saved text (independent of storage ETags).
const versionOf = (text) => (text ? sha256hex(text) : '');

async function adminContent() {
  const text = await store(STORE).get(CONTENT_KEY, { type: 'text' });
  return json({ ok: true, content: text ? JSON.parse(text) : null, version: versionOf(text) });
}

function validContent(c) {
  return c && typeof c === 'object' && !Array.isArray(c) && c.hero && typeof c.hero === 'object' && c.donate && typeof c.donate === 'object';
}

async function backupCurrent(st) {
  const cur = await st.get(CONTENT_KEY, { type: 'text' });
  if (!cur) return;
  const key = 'backups/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + sha256hex(cur + Math.random()).slice(0, 6) + '.json';
  await st.set(key, cur);
  const { blobs } = await st.list({ prefix: 'backups/' });
  const keys = blobs.map((b) => b.key).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_BACKUPS))) await st.delete(old);
}

async function saveContent(req) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_CONTENT_BYTES * 1.2) return fail('Content is too large.', 413);
  let body;
  try { body = await req.json(); } catch { return fail('Content is not valid.'); }
  const content = body?.content;
  if (!validContent(content)) return fail('Content is not valid.');
  const text = JSON.stringify(content, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_CONTENT_BYTES) return fail('Content is too large.', 413);

  const st = store(STORE);
  const base = typeof body.base === 'string' ? body.base : '';
  const conflict = () => fail('Someone else published changes while you were editing. Copy anything you need, then reload the admin to get the latest version.', 409);
  // Refuse to overwrite a version this editor has not seen (someone else published meanwhile).
  const currentText = await st.get(CONTENT_KEY, { type: 'text' });
  if (versionOf(currentText) !== base) return conflict();
  // Every uploaded photo the new content uses must really exist (e.g. after a half-failed publish).
  const live = mediaNames(currentText);
  for (const name of mediaNames(text)) {
    if (live.has(name)) continue;
    if (!(await store(MEDIA).getMetadata(name))) return fail('A photo did not finish uploading (' + name + '). Please remove it and add it again, then publish.', 400);
  }
  await backupCurrent(st);
  await st.set(CONTENT_KEY, text);
  await cleanUpMedia(st).catch((e) => console.error('media clean-up failed', e));
  return json({ ok: true, version: versionOf(text) });
}

// Delete uploaded photos that neither the live content nor any kept backup uses.
// Photos uploaded in the last hour are kept (someone may be about to publish them).
function mediaNames(text) {
  const names = new Set();
  for (const m of String(text || '').matchAll(/"media\/([a-z0-9][a-z0-9-]{0,100}\.(?:jpg|jpeg|png|webp))"/g)) names.add(m[1]);
  return names;
}
async function cleanUpMedia(st) {
  const used = new Set();
  const collect = (text) => { for (const n of mediaNames(text)) used.add(n); };
  collect(await st.get(CONTENT_KEY, { type: 'text' }));
  const { blobs: backups } = await st.list({ prefix: 'backups/' });
  for (const b of backups) collect(await st.get(b.key, { type: 'text' }));
  const media = store(MEDIA);
  const { blobs } = await media.list();
  const hourAgo = Date.now() - 3600e3;
  for (const b of blobs) {
    if (used.has(b.key)) continue;
    const meta = await media.getMetadata(b.key);
    if (Number(meta?.metadata?.uploadedAt || 0) > hourAgo) continue;
    await media.delete(b.key);
  }
}

/* ---------------- photos ---------------- */
function sniff(bytes) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return '';
}

async function upload(req, url) {
  const name = url.searchParams.get('name') || '';
  if (!NAME_RE.test(name)) return fail('Invalid file name.');
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_IMAGE_BYTES) return fail('That photo is too large (4.5 MB maximum).', 413);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return fail('That photo is too large (4.5 MB maximum).', 413);
  const type = sniff(bytes);
  if (!type) return fail('Only JPG, PNG and WebP photos are allowed.');

  const st = store(MEDIA);
  const sha = sha256hex(Buffer.from(bytes));
  const existing = await st.getMetadata(name);
  if (existing) {
    // A retry of a photo that already arrived is fine; a different file with the same name is not.
    if (existing.metadata?.sha !== sha) return fail('A different photo with that name already exists.', 409);
    return json({ ok: true, path: 'media/' + name });
  }
  await st.set(name, bytes, { metadata: { type, size: bytes.byteLength, sha, uploadedAt: Date.now() } });
  return json({ ok: true, path: 'media/' + name });
}

/* ---------------- history ---------------- */
async function listBackups() {
  const { blobs } = await store(STORE).list({ prefix: 'backups/' });
  const items = blobs.map((b) => b.key).filter((k) => BACKUP_RE.test(k)).sort().reverse().map((key) => {
    const iso = key.slice(8, 32).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
    return { key, savedAt: iso };
  });
  return json({ ok: true, backups: items });
}

async function restore(req) {
  let body;
  try { body = await req.json(); } catch { return fail('Bad request.'); }
  const key = typeof body?.key === 'string' ? body.key : '';
  if (!BACKUP_RE.test(key)) return fail('Invalid backup.');
  const st = store(STORE);
  const text = await st.get(key, { type: 'text' });
  if (!text) return fail('That backup no longer exists.', 404);
  let parsed;
  try { parsed = JSON.parse(text); } catch { return fail('That backup is damaged.'); }
  if (!validContent(parsed)) return fail('That backup is damaged.');
  await backupCurrent(st);
  await st.set(CONTENT_KEY, text);
  await cleanUpMedia(st).catch((e) => console.error('media clean-up failed', e));
  return json({ ok: true, version: versionOf(text), content: parsed });
}
