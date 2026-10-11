// Serves photos uploaded from the admin at /media/<name>. Logic lives in ../lib/media-core.mjs (generated).
import handler from '../lib/media-core.mjs';
export default handler;
export const config = { path: '/media/*' };
