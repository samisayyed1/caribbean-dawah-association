// Serves photos uploaded from the admin: GET /media/<name>
import { MEDIA, store } from './lib.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,100}\.(jpg|jpeg|png|webp)$/;
const TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  let name = '';
  try { name = decodeURIComponent(new URL(req.url).pathname.replace(/^\/media\//, '')); } catch { name = ''; }
  if (!NAME_RE.test(name)) return new Response('Not found', { status: 404 });
  const hit = await store(MEDIA).getWithMetadata(name, { type: 'stream' });
  if (!hit) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const type = TYPES[hit.metadata?.type] ? hit.metadata.type : 'application/octet-stream';
  return new Response(req.method === 'HEAD' ? null : hit.data, {
    status: 200,
    headers: {
      'Content-Type': type,
      // File names are unique per upload, so they never change: cache them for a long time.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Netlify-CDN-Cache-Control': 'public, max-age=31536000, immutable, durable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
    }
  });
};

export const config = { path: '/media/*' };
