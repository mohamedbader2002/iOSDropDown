import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_DIR, importImageUrl } from './media.js';

// Image generation for AI backgrounds and overlays. Any service exposing the common
// POST /v1/images/generations endpoint (returning b64_json or url) works.
const URL_ = process.env.IMAGE_GEN_URL;
const KEY = process.env.IMAGE_GEN_API_KEY;
const MODEL = process.env.IMAGE_GEN_MODEL;
const SIZE = process.env.IMAGE_GEN_SIZE;

export function imageGenConfigured() {
  return Boolean(URL_);
}

export async function generateImage(prompt) {
  if (!URL_) {
    throw new Error('Image generation is not set up on this server (IMAGE_GEN_URL is missing). Offer a blurred or solid color background instead, or ask the user to upload a background image.');
  }
  const body = { prompt, n: 1 };
  if (MODEL) body.model = MODEL;
  if (SIZE) body.size = SIZE;
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Image generation failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const image = (await res.json()).data?.[0];
  if (image?.url) return { ...(await importImageUrl(image.url)), name: prompt.slice(0, 40) };
  if (!image?.b64_json) throw new Error('Image generation returned no image');
  const id = randomUUID().slice(0, 8);
  const file = `${id}.png`;
  await writeFile(path.join(UPLOAD_DIR, file), Buffer.from(image.b64_json, 'base64'));
  return { id: `A-${id}`, url: `/uploads/${file}`, name: prompt.slice(0, 40) };
}
