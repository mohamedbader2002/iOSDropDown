// Draws one frame of a project onto a canvas: the media with its color grade and
// transform, time-ranged effects, then text, captions, images, charts and countdowns.
import { isLayerActive } from './ops.js';

const ACCENT = '#c4623f';
const FONT = '"Inter", "Noto Sans Arabic", system-ui, sans-serif';
const RTL = /[֐-ࣿיִ-ﻼ]/;

const imageCache = new Map();
export function getImage(src, onLoad) {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = onLoad;
    img.src = src;
    imageCache.set(src, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

export function preloadImages(srcs) {
  return Promise.all(srcs.map((src) => new Promise((resolve) => {
    const img = getImage(src, () => {});
    if (img) return resolve();
    const pending = imageCache.get(src);
    pending.addEventListener('load', resolve, { once: true });
    pending.addEventListener('error', resolve, { once: true });
  })));
}

export function outputSize(project, maxSide = 1280) {
  const m = project.media;
  if (!m) return { width: 720, height: 1280 };
  const swap = project.transform.rotate % 180 !== 0;
  let w = swap ? m.height : m.width;
  let h = swap ? m.width : m.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

const easeOutBack = (x) => 1 + 2.7 * (x - 1) ** 3 + 1.7 * (x - 1) ** 2;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Entrance/exit animation state for a layer at time t.
function animState(layer, t, isImage) {
  if (isImage || layer.animation === 'none') return { alpha: 1, scale: 1, dy: 0 };
  const inP = clamp01((t - layer.start) / 0.3);
  const outP = layer.end === null ? 1 : clamp01((layer.end - t) / 0.2);
  const alpha = Math.min(inP * 1.5, outP, 1);
  switch (layer.animation) {
    case 'pop': return { alpha, scale: 0.5 + 0.5 * easeOutBack(inP), dy: 0 };
    case 'slide': return { alpha, scale: 1, dy: (1 - inP) * 0.05 };
    default: return { alpha, scale: 1, dy: 0 };
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
}

function filterString(look, extra = {}) {
  const g = Math.min(100, look.grayscale + (extra.grayscale || 0));
  const s = Math.min(100, look.sepia + (extra.sepia || 0));
  return [
    `brightness(${look.brightness * (extra.brightness || 1)}%)`,
    `contrast(${look.contrast * (extra.contrast || 1)}%)`,
    `saturate(${look.saturation * (extra.saturation || 1)}%)`,
    `hue-rotate(${look.hue}deg)`,
    `grayscale(${g}%)`,
    `sepia(${s}%)`,
    `blur(${look.blur + (extra.blur || 0)}px)`,
  ].join(' ');
}

function effectMods(project, t, isImage) {
  const mods = { grayscale: 0, sepia: 0, blur: 0, contrast: 1, saturation: 1, brightness: 1, zoom: 1, dx: 0, dy: 0, flash: 0, grain: 0, vignette: 0, labels: [] };
  for (const layer of project.layers) {
    if (layer.type !== 'effect' || !isLayerActive(layer, t, isImage)) continue;
    const k = layer.intensity ?? 1;
    const span = layer.end === null ? null : layer.end - layer.start;
    const p = isImage || !span ? 1 : clamp01((t - layer.start) / span);
    switch (layer.effect) {
      case 'black_and_white': mods.grayscale += 100 * k; mods.contrast *= 1 + 0.2 * k; break;
      case 'sepia': mods.sepia += 80 * k; break;
      case 'vintage': mods.sepia += 50 * k; mods.saturation *= 1 - 0.3 * k; mods.grain += 0.5 * k; mods.vignette += 0.5 * k; break;
      case 'blur': mods.blur += 8 * k; break;
      case 'zoom_in': mods.zoom *= 1 + 0.25 * k * p; break;
      case 'zoom_out': mods.zoom *= 1 + 0.25 * k * (1 - p); break;
      case 'shake': mods.dx += Math.sin(t * 53) * 0.012 * k; mods.dy += Math.cos(t * 47) * 0.012 * k; break;
      case 'flash': mods.flash = Math.max(mods.flash, k * (1 - clamp01((t - layer.start) / 0.35))); break;
      case 'film_grain': mods.grain += k; break;
    }
    if (layer.label) mods.labels.push(layer.label);
  }
  return mods;
}

function drawMedia(ctx, project, source, W, H, mods) {
  const { transform } = project;
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  if (!sw || !sh) return;
  ctx.save();
  ctx.filter = filterString(project.look, mods);
  ctx.translate(W / 2 + mods.dx * W, H / 2 + mods.dy * H);
  ctx.rotate((transform.rotate * Math.PI) / 180);
  const zoom = transform.zoom * mods.zoom;
  ctx.scale((transform.flipH ? -1 : 1) * zoom, (transform.flipV ? -1 : 1) * zoom);
  const swap = transform.rotate % 180 !== 0;
  const dw = swap ? H : W;
  const dh = swap ? W : H;
  // Cover-fit so shake/zoom never shows edges.
  const fit = Math.max(dw / sw, dh / sh) * (mods.dx || mods.dy ? 1.03 : 1);
  ctx.drawImage(source, (-sw * fit) / 2, (-sh * fit) / 2, sw * fit, sh * fit);
  ctx.restore();
}

function drawCover(ctx, img, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const fit = Math.max(w / iw, h / ih);
  ctx.drawImage(img, (w - iw * fit) / 2, (h - ih * fit) / 2, iw * fit, ih * fit);
}

// Puts the people from `source` in front of a new background. Returns a canvas to draw
// instead of the source, or the source itself while the segmentation model loads.
const bgCanvas = document.createElement('canvas');
const personCanvas = document.createElement('canvas');
function composeBackground(project, source, helpers, redraw) {
  const bg = project.background;
  if (!bg || bg.mode === 'none' || !helpers?.personMask) return source;
  const mask = helpers.personMask(source, project.media.kind, redraw);
  if (!mask) return source;
  const sw = source.videoWidth || source.naturalWidth;
  const sh = source.videoHeight || source.naturalHeight;
  const scale = Math.min(1, 1280 / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  for (const c of [bgCanvas, personCanvas]) {
    if (c.width !== w || c.height !== h) Object.assign(c, { width: w, height: h });
  }
  const pctx = personCanvas.getContext('2d');
  pctx.globalCompositeOperation = 'source-over';
  pctx.clearRect(0, 0, w, h);
  pctx.drawImage(source, 0, 0, w, h);
  pctx.globalCompositeOperation = 'destination-in';
  pctx.drawImage(mask, 0, 0, w, h);

  const bctx = bgCanvas.getContext('2d');
  bctx.save();
  if (bg.mode === 'blur') {
    bctx.filter = `blur(${bg.blur * scale}px)`;
    bctx.drawImage(source, -w * 0.05, -h * 0.05, w * 1.1, h * 1.1);
  } else if (bg.mode === 'color') {
    bctx.fillStyle = bg.color;
    bctx.fillRect(0, 0, w, h);
  } else {
    const img = bg.src && getImage(bg.src, redraw);
    if (img) drawCover(bctx, img, w, h);
    else bctx.drawImage(source, 0, 0, w, h);
  }
  bctx.restore();
  bctx.drawImage(personCanvas, 0, 0);
  return bgCanvas;
}

function drawVignette(ctx, W, H, amount) {
  if (amount <= 0) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, amount)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

let grainCanvas;
function drawGrain(ctx, W, H, amount, t) {
  if (amount <= 0) return;
  if (!grainCanvas) {
    grainCanvas = document.createElement('canvas');
    grainCanvas.width = grainCanvas.height = 256;
    const g = grainCanvas.getContext('2d');
    const data = g.createImageData(256, 256);
    for (let i = 0; i < data.data.length; i += 4) {
      const v = Math.random() * 255;
      data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
      data.data[i + 3] = 40;
    }
    g.putImageData(data, 0, 0);
  }
  ctx.save();
  ctx.globalAlpha = Math.min(1, amount);
  ctx.globalCompositeOperation = 'overlay';
  const ox = Math.floor((t * 977) % 256);
  const oy = Math.floor((t * 613) % 256);
  ctx.fillStyle = ctx.createPattern(grainCanvas, 'repeat');
  ctx.translate(-ox, -oy);
  ctx.fillRect(0, 0, W + 256, H + 256);
  ctx.restore();
}

function setFont(ctx, px, weight = 700) {
  ctx.font = `${weight} ${px}px ${FONT}`;
}

function drawText(ctx, layer, W, H, anim) {
  const px = layer.size * H;
  setFont(ctx, px, layer.style === 'label' ? 600 : 800);
  ctx.direction = RTL.test(layer.text) ? 'rtl' : 'ltr';
  const lines = String(layer.text).split('\n');
  const widths = lines.map((l) => ctx.measureText(l).width);
  const lineH = px * 1.25;
  const padX = px * 0.6;
  const padY = px * 0.35;
  const boxW = Math.max(...widths) + padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  ctx.save();
  ctx.globalAlpha = anim.alpha;
  ctx.translate(layer.x * W, (layer.y + anim.dy) * H);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.scale(anim.scale, anim.scale);

  const styles = {
    card: { bg: '#fbf7f2', fg: '#1d1b19' },
    accent: { bg: ACCENT, fg: '#fff' },
    label: { bg: 'rgba(20,20,20,0.82)', fg: '#f3f0ea' },
    plain: { bg: null, fg: '#fff' },
    outline: { bg: null, fg: '#fff' },
  };
  const style = styles[layer.style] || styles.card;
  const bg = layer.background || style.bg;
  if (bg) {
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = px * 0.5;
    ctx.shadowOffsetY = px * 0.12;
    ctx.fillStyle = bg;
    roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, px * 0.35);
    ctx.fill();
    ctx.shadowColor = 'transparent';
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = layer.color || style.fg;
  lines.forEach((line, i) => {
    const y = -boxH / 2 + padY + lineH * (i + 0.5);
    if (layer.style === 'outline') {
      ctx.lineWidth = px * 0.14;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#000';
      ctx.strokeText(line, 0, y);
    } else if (layer.style === 'plain') {
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = px * 0.3;
    }
    ctx.fillText(line, 0, y);
  });
  ctx.restore();
}

const normalize = (w) => w.replace(/[.,!?؟،:;"'«»()]/g, '').toLowerCase();

function drawCaption(ctx, layer, W, H, t, anim, isImage) {
  const px = layer.size * H;
  setFont(ctx, px, 700);
  const words = String(layer.text).split(/\s+/).filter(Boolean);
  const rtl = RTL.test(layer.text);
  ctx.direction = rtl ? 'rtl' : 'ltr';
  const highlights = new Set((layer.highlight || []).map(normalize));
  // Karaoke: the word being spoken right now.
  let activeIndex = -1;
  if (!isImage && Array.isArray(layer.words)) {
    activeIndex = layer.words.findIndex((w) => t >= w.start && t < w.end);
  }

  const space = px * 0.32;
  const maxW = W * 0.86;
  const widths = words.map((w) => ctx.measureText(w).width);
  // Wrap into lines in reading order.
  const lines = [[]];
  let lineW = 0;
  words.forEach((w, i) => {
    const add = widths[i] + (lines[lines.length - 1].length ? space : 0);
    if (lineW + add > maxW && lines[lines.length - 1].length) {
      lines.push([]);
      lineW = 0;
    }
    lines[lines.length - 1].push(i);
    lineW += widths[i] + (lines[lines.length - 1].length > 1 ? space : 0);
  });
  const lineH = px * 1.5;
  const padX = px * 0.7;
  const padY = px * 0.45;
  const lineWidths = lines.map((l) => l.reduce((s, i) => s + widths[i], 0) + space * (l.length - 1));
  const boxW = Math.max(...lineWidths) + padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  ctx.save();
  ctx.globalAlpha = anim.alpha;
  ctx.translate(W / 2, (layer.y + anim.dy) * H);
  ctx.scale(anim.scale, anim.scale);
  ctx.fillStyle = 'rgba(22,22,22,0.86)';
  roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, px * 0.45);
  ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.direction = 'ltr'; // words are placed manually, each shaped on its own
  lines.forEach((line, li) => {
    const y = -boxH / 2 + padY + lineH * (li + 0.5);
    const order = rtl ? [...line].reverse() : line;
    let x = -lineWidths[li] / 2;
    for (const i of order) {
      const isActive = i === activeIndex;
      const isHighlight = highlights.has(normalize(words[i]));
      if (isHighlight || isActive) {
        ctx.fillStyle = isActive && !isHighlight ? 'rgba(255,255,255,0.18)' : ACCENT;
        roundRect(ctx, x - px * 0.15, y - px * 0.62, widths[i] + px * 0.3, px * 1.24, px * 0.22);
        ctx.fill();
      }
      ctx.fillStyle = isHighlight ? '#fff' : isActive ? '#ffd9a8' : '#f4f1ec';
      ctx.fillText(words[i], x, y);
      x += widths[i] + space;
    }
  });
  ctx.restore();
}

function drawImageLayer(ctx, layer, W, H, anim, redraw, helpers) {
  const original = getImage(layer.src, redraw);
  if (!original) return;
  if (layer.cutout) {
    // Until the cut-out is ready nothing is drawn, so the full rectangle never flashes in.
    const cut = helpers?.cutout?.(original, redraw);
    if (!cut) return;
    if (!cut.empty) return drawCutoutSticker(ctx, layer, cut, W, H, anim);
  }
  const img = original;
  const w = layer.width * W;
  const h = (w * img.naturalHeight) / img.naturalWidth;
  const border = layer.frame === 'none' ? 0 : layer.frame === 'rounded' ? 0 : w * 0.035;
  const bottom = layer.frame === 'polaroid' ? w * 0.12 : border;
  ctx.save();
  ctx.globalAlpha = anim.alpha;
  ctx.translate(layer.x * W, (layer.y + anim.dy) * H);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.scale(anim.scale, anim.scale);
  if (layer.frame === 'sticker' || layer.frame === 'polaroid') {
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = w * 0.05;
    ctx.shadowOffsetY = w * 0.015;
    ctx.fillStyle = '#fff';
    roundRect(ctx, -w / 2 - border, -h / 2 - border, w + border * 2, h + border + bottom, layer.frame === 'sticker' ? w * 0.04 : 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
  }
  if (layer.frame === 'rounded' || layer.frame === 'sticker') {
    roundRect(ctx, -w / 2, -h / 2, w, h, w * (layer.frame === 'rounded' ? 0.06 : 0.025));
    ctx.clip();
  }
  if (layer.grayscale) ctx.filter = 'grayscale(100%)';
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

// A person cut out of a photo, with a white outline that follows their shape.
function drawCutoutSticker(ctx, layer, cut, W, H, anim) {
  const w = layer.width * W;
  const h = (w * cut.image.height) / cut.image.width;
  ctx.save();
  ctx.globalAlpha = anim.alpha;
  ctx.translate(layer.x * W, (layer.y + anim.dy) * H);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.scale(anim.scale, anim.scale);
  if (layer.frame !== 'none' && cut.silhouette) {
    const r = w * 0.03;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = w * 0.04;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ctx.drawImage(cut.silhouette, -w / 2 + Math.cos(a) * r, -h / 2 + Math.sin(a) * r, w, h);
      if (i === 0) ctx.shadowColor = 'transparent';
    }
    ctx.restore();
  }
  if (layer.grayscale) ctx.filter = 'grayscale(100%)';
  ctx.drawImage(cut.image, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawCountdown(ctx, layer, W, H, t) {
  const elapsed = t - layer.start;
  const n = Math.max(1, layer.from - Math.floor(elapsed));
  const frac = elapsed % 1;
  const r = Math.min(W, H) * 0.32;
  ctx.save();
  ctx.fillStyle = '#d8d1c4';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  ctx.moveTo(W / 2, H / 2);
  ctx.arc(W / 2, H / 2, Math.hypot(W, H), -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a342c';
  ctx.lineWidth = Math.max(2, W * 0.004);
  for (const rr of [r, r * 0.82]) {
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
  ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.fillStyle = '#2b261f';
  ctx.font = `600 ${r * 1.1}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), W / 2, H / 2 + r * 0.05);
  ctx.restore();
  drawGrain(ctx, W, H, 1, t);
  drawVignette(ctx, W, H, 0.6);
}

function drawChart(ctx, layer, W, H, t, isImage) {
  const span = layer.end === null ? 4 : layer.end - layer.start;
  const p = isImage ? 1 : clamp01((t - layer.start) / Math.max(0.5, span * 0.6));
  ctx.save();
  if (layer.fullscreen) {
    ctx.fillStyle = 'rgba(10,10,10,0.78)';
    ctx.fillRect(0, 0, W, H);
  }
  const cx = W * 0.1, cw = W * 0.8;
  const top = H * 0.3, ch = H * 0.25;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  setFont(ctx, H * 0.022, 500);
  ctx.direction = RTL.test(layer.title) ? 'rtl' : 'ltr';
  if (layer.title) ctx.fillText(layer.title, W / 2, H * 0.12);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${H * 0.07}px Georgia, serif`;
  if (layer.value) ctx.fillText(layer.value, W / 2, H * 0.2);
  if (layer.subtitle) {
    ctx.fillStyle = '#e8a33d';
    setFont(ctx, H * 0.022, 700);
    ctx.fillText(layer.subtitle, W / 2, H * 0.245);
  }
  const pts = layer.points;
  const min = Math.min(...pts), max = Math.max(...pts);
  const toXY = (v, i) => [cx + (i / (pts.length - 1)) * cw, top + ch - ((v - min) / (max - min || 1)) * ch];
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    ctx.beginPath();
    ctx.moveTo(cx, top + (ch * g) / 4);
    ctx.lineTo(cx + cw, top + (ch * g) / 4);
    ctx.stroke();
  }
  const shown = Math.max(2, Math.ceil(p * pts.length));
  ctx.strokeStyle = '#f0a43a';
  ctx.lineWidth = Math.max(2, W * 0.006);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.slice(0, shown).forEach((v, i) => {
    const [x, y] = toXY(v, i);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  const [lx, ly] = toXY(pts[shown - 1], shown - 1);
  ctx.fillStyle = '#f0a43a';
  ctx.beginPath();
  ctx.arc(lx, ly, W * 0.01, 0, Math.PI * 2);
  ctx.fill();
  if (layer.labels.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    setFont(ctx, H * 0.016, 500);
    layer.labels.forEach((label, i) => {
      ctx.fillText(label, cx + (i / Math.max(1, layer.labels.length - 1)) * cw, top + ch + H * 0.03);
    });
  }
  ctx.restore();
}

function drawEffectLabels(ctx, labels, W, H) {
  labels.forEach((label, i) => {
    const px = H * 0.02;
    setFont(ctx, px, 600);
    const w = ctx.measureText(label).width + px * 1.2;
    ctx.fillStyle = 'rgba(20,20,20,0.75)';
    roundRect(ctx, W * 0.04, H * 0.03 + i * px * 2, w, px * 1.6, px * 0.3);
    ctx.fill();
    ctx.fillStyle = '#eee';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, W * 0.04 + px * 0.6, H * 0.03 + i * px * 2 + px * 0.8);
  });
}

/**
 * Renders the project at source time t. `redraw` is called when something loaded lazily
 * (an image, the segmentation model) becomes ready. `helpers` provides person segmentation:
 * { personMask(source, kind, redraw), cutout(image, redraw) }.
 */
export function renderFrame(ctx, project, source, t, redraw = () => {}, helpers = null) {
  const { width: W, height: H } = ctx.canvas;
  const isImage = project.media?.kind === 'image';
  ctx.save();
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  const mods = effectMods(project, t, isImage);
  if (source) drawMedia(ctx, project, composeBackground(project, source, helpers, redraw), W, H, mods);
  drawGrain(ctx, W, H, mods.grain, t);
  drawVignette(ctx, W, H, project.look.vignette / 100 + mods.vignette);

  for (const layer of project.layers) {
    if (layer.type === 'effect' || !isLayerActive(layer, t, isImage)) continue;
    const anim = animState(layer, t, isImage);
    if (layer.type === 'text') drawText(ctx, layer, W, H, anim);
    else if (layer.type === 'caption') drawCaption(ctx, layer, W, H, t, anim, isImage);
    else if (layer.type === 'image') drawImageLayer(ctx, layer, W, H, anim, redraw, helpers);
    else if (layer.type === 'countdown') drawCountdown(ctx, layer, W, H, t);
    else if (layer.type === 'chart') drawChart(ctx, layer, W, H, t, isImage);
  }
  drawEffectLabels(ctx, mods.labels, W, H);
  if (mods.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${mods.flash})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}
