// Person segmentation in the browser (MediaPipe selfie model). Used to replace the
// background behind the speaker and to cut people out of photos for stickers.
import { FilesetResolver, ImageSegmenter } from '/vendor/tasks-vision/vision_bundle.mjs';

const WASM = '/vendor/tasks-vision/wasm';
const MODEL = '/models/selfie_multiclass_256x256.tflite';

let state = 'idle'; // idle | loading | ready | error
let videoSegmenter = null;
let imageSegmenter = null;
const waiting = new Set();

async function create(vision, runningMode) {
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode,
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
  const forced = new URLSearchParams(location.search).get('delegate');
  if (forced) return ImageSegmenter.createFromOptions(vision, options(forced.toUpperCase()));
  try {
    return await ImageSegmenter.createFromOptions(vision, options('GPU'));
  } catch {
    return ImageSegmenter.createFromOptions(vision, options('CPU'));
  }
}

// Starts loading the model once; `onReady` is called when it can be used.
export function ensureSegmenter(onReady) {
  if (state === 'ready') return true;
  if (onReady) waiting.add(onReady);
  if (state === 'idle') {
    state = 'loading';
    (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM);
      [videoSegmenter, imageSegmenter] = await Promise.all([create(vision, 'VIDEO'), create(vision, 'IMAGE')]);
      state = 'ready';
    })()
      .catch((err) => {
        console.error('Segmentation model failed to load', err);
        state = 'error';
      })
      .finally(() => {
        waiting.forEach((fn) => fn());
        waiting.clear();
      });
  }
  return false;
}

export const segmenterState = () => state;

export function segmenterReady() {
  return new Promise((resolve) => {
    if (ensureSegmenter(resolve) || state === 'error') resolve();
  });
}

// Mask alpha = probability of "not background" (person, hair, clothes...), drawn into a canvas.
function maskToCanvas(mask, canvas) {
  const bg = mask.getAsFloat32Array();
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < bg.length; i++) {
    // Keep only confident pixels with a short soft edge: uncertain areas (busy scenery)
    // stay background, while hair and shoulders stay solid.
    const a = Math.min(1, Math.max(0, (1 - bg[i] - 0.5) / 0.3));
    img.data[i * 4 + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

let lastVideoTs = 0;
let lastCost = 0;
let lastMask = null;
const videoMaskCanvas = document.createElement('canvas');

/**
 * Person mask for the current video frame (or a still image), or null while the model loads.
 * During preview on slow devices the previous mask is reused for a moment so playback stays
 * smooth; pass every = true (export) to segment every frame.
 */
export function personMask(source, kind, redraw, every = false) {
  if (!ensureSegmenter(redraw)) return null;
  let out = null;
  if (kind === 'video') {
    const now = performance.now();
    if (!every && lastMask && lastCost > 30 && now - lastVideoTs < lastCost * 2) return lastMask;
    const ts = Math.max(now, lastVideoTs + 1);
    lastVideoTs = ts;
    videoSegmenter.segmentForVideo(source, ts, (result) => {
      out = maskToCanvas(result.confidenceMasks[0], videoMaskCanvas);
    });
    lastCost = performance.now() - now;
    lastMask = out;
  } else {
    out = stillMask(source);
  }
  return out;
}

const stillMasks = new WeakMap();
function stillMask(image) {
  if (!stillMasks.has(image)) {
    let canvas = null;
    imageSegmenter.segment(image, (result) => {
      canvas = maskToCanvas(result.confidenceMasks[0], document.createElement('canvas'));
    });
    stillMasks.set(image, canvas);
  }
  return stillMasks.get(image);
}

/**
 * Cuts the person out of an image: returns { image, silhouette } canvases cropped to the
 * subject, where silhouette is a solid white copy used to draw sticker outlines.
 */
const cutouts = new WeakMap();
export function cutout(img, redraw) {
  if (!ensureSegmenter(redraw)) return null;
  if (!cutouts.has(img)) cutouts.set(img, makeCutout(img));
  return cutouts.get(img);
}

function makeCutout(img) {
  const mask = stillMask(img);
  if (!mask) return null;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const full = document.createElement('canvas');
  full.width = w;
  full.height = h;
  const fctx = full.getContext('2d');
  fctx.drawImage(img, 0, 0);
  fctx.globalCompositeOperation = 'destination-in';
  fctx.drawImage(mask, 0, 0, w, h);

  // Crop to the subject's bounding box.
  const alpha = fctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (alpha[(y * w + x) * 4 + 3] > 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { image: img, silhouette: null, empty: true }; // nobody found: keep the photo
  const cw = x1 - x0 + 2;
  const ch = y1 - y0 + 2;
  const image = document.createElement('canvas');
  image.width = cw;
  image.height = ch;
  image.getContext('2d').drawImage(full, x0, y0, cw, ch, 0, 0, cw, ch);
  const silhouette = document.createElement('canvas');
  silhouette.width = cw;
  silhouette.height = ch;
  const sctx = silhouette.getContext('2d');
  sctx.drawImage(image, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, cw, ch);
  return { image, silhouette };
}
