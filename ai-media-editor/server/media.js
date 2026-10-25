import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_REMOTE_IMAGE = 10 * 1024 * 1024;
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

// Maps a /uploads/<file> URL back to a path on disk, refusing anything outside the upload folder.
export function uploadPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const file = path.basename(url);
  return path.join(UPLOAD_DIR, file);
}

export async function importImageUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Image URL is not valid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Image URL must be http(s)');
  const res = await fetch(parsed, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download image (${res.status})`);
  const type = (res.headers.get('content-type') || '').split(';')[0];
  if (!IMAGE_EXT[type]) throw new Error(`URL is not a supported image (${type || 'unknown type'})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_REMOTE_IMAGE) throw new Error('Image is larger than 10 MB');
  const id = randomUUID().slice(0, 8);
  const file = `${id}${IMAGE_EXT[type]}`;
  await writeFile(path.join(UPLOAD_DIR, file), buffer);
  return { id: `A-${id}`, url: `/uploads/${file}`, name: parsed.pathname.split('/').pop() || file };
}
