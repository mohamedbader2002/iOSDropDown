// Shared edit model. Runs in the browser (live preview, undo) and in Node (the AI agent).
// A project is plain JSON; every edit is a named operation that returns a new project.

export const EFFECTS = [
  'black_and_white', 'sepia', 'vintage', 'blur', 'zoom_in', 'zoom_out', 'shake', 'flash', 'film_grain',
];
export const TEXT_STYLES = ['plain', 'outline', 'card', 'accent', 'label'];
export const IMAGE_FRAMES = ['none', 'sticker', 'polaroid', 'rounded'];
export const ANIMATIONS = ['pop', 'fade', 'slide', 'none'];
export const BACKGROUND_MODES = ['none', 'blur', 'color', 'image'];

export function emptyProject() {
  return {
    media: null, // { id, url, kind: 'video'|'image', name, width, height, duration }
    assets: [], // extra images the user uploaded: { id, url, name }
    look: { brightness: 100, contrast: 100, saturation: 100, hue: 0, grayscale: 0, sepia: 0, blur: 0, vignette: 0 },
    transform: { rotate: 0, flipH: false, flipV: false, zoom: 1 },
    trim: { start: 0, end: null },
    speed: 1,
    background: { mode: 'none', color: '#1f3b4d', blur: 14, src: null }, // replaces what's behind the people
    layers: [],
    nextId: 1,
  };
}

const LOOK_PRESETS = {
  none: { brightness: 100, contrast: 100, saturation: 100, hue: 0, grayscale: 0, sepia: 0, blur: 0, vignette: 0 },
  cinematic: { brightness: 95, contrast: 120, saturation: 85, hue: 0, grayscale: 0, sepia: 10, blur: 0, vignette: 45 },
  warm: { brightness: 104, contrast: 105, saturation: 115, hue: -8, grayscale: 0, sepia: 22, blur: 0, vignette: 15 },
  cool: { brightness: 100, contrast: 108, saturation: 95, hue: 12, grayscale: 0, sepia: 0, blur: 0, vignette: 15 },
  vivid: { brightness: 104, contrast: 115, saturation: 145, hue: 0, grayscale: 0, sepia: 0, blur: 0, vignette: 0 },
  black_and_white: { brightness: 100, contrast: 125, saturation: 100, hue: 0, grayscale: 100, sepia: 0, blur: 0, vignette: 30 },
  vintage: { brightness: 105, contrast: 90, saturation: 70, hue: 0, grayscale: 0, sepia: 55, blur: 0, vignette: 50 },
  faded: { brightness: 110, contrast: 80, saturation: 75, hue: 0, grayscale: 0, sepia: 10, blur: 0, vignette: 0 },
};

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pick = (v, list, d) => (list.includes(v) ? v : d);
const timeOr = (v, d) => (v === null ? null : num(v, d));

function timing(input, project) {
  const start = Math.max(0, num(input.start, project.trim.start || 0));
  let end = timeOr(input.end, null);
  if (end !== null && end <= start) end = start + 2;
  return { start, end };
}

function nextLayerId(project) {
  return `L${project.nextId++}`;
}

function findLayer(project, id) {
  const layer = project.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`No layer with id ${id}. Existing ids: ${project.layers.map((l) => l.id).join(', ') || 'none'}`);
  return layer;
}

function resolveImage(project, input) {
  if (input.asset_id) {
    const asset = project.assets.find((a) => a.id === input.asset_id);
    if (!asset) throw new Error(`Unknown asset_id ${input.asset_id}`);
    return asset.url;
  }
  if (typeof input.url === 'string' && input.url) return input.url;
  throw new Error('add_image needs asset_id or url');
}

const handlers = {
  set_look(p, input) {
    if (input.preset) {
      if (!LOOK_PRESETS[input.preset]) throw new Error(`Unknown preset ${input.preset}`);
      p.look = { ...LOOK_PRESETS[input.preset] };
    }
    const ranges = {
      brightness: [0, 300], contrast: [0, 300], saturation: [0, 300], hue: [-180, 180],
      grayscale: [0, 100], sepia: [0, 100], blur: [0, 20], vignette: [0, 100],
    };
    for (const [key, [lo, hi]] of Object.entries(ranges)) {
      if (typeof input[key] === 'number') p.look[key] = clamp(input[key], lo, hi);
    }
    return `Look is now ${JSON.stringify(p.look)}`;
  },

  set_transform(p, input) {
    if (typeof input.rotate === 'number') p.transform.rotate = ((Math.round(input.rotate / 90) * 90) % 360 + 360) % 360;
    if (typeof input.flip_horizontal === 'boolean') p.transform.flipH = input.flip_horizontal;
    if (typeof input.flip_vertical === 'boolean') p.transform.flipV = input.flip_vertical;
    if (typeof input.zoom === 'number') p.transform.zoom = clamp(input.zoom, 1, 4);
    return `Transform is now ${JSON.stringify(p.transform)}`;
  },

  trim(p, input) {
    const duration = p.media?.duration ?? null;
    const start = Math.max(0, num(input.start, p.trim.start));
    let end = timeOr(input.end, p.trim.end);
    if (duration !== null && end !== null) end = Math.min(end, duration);
    if (end !== null && end <= start) throw new Error('Trim end must be after start');
    p.trim = { start, end };
    return `Trimmed to ${start}s – ${end ?? 'end'}`;
  },

  set_speed(p, input) {
    p.speed = clamp(num(input.speed, 1), 0.25, 4);
    return `Playback speed ${p.speed}x`;
  },

  add_text(p, input) {
    if (!input.text) throw new Error('text is required');
    const layer = {
      id: nextLayerId(p), type: 'text', ...timing(input, p),
      text: String(input.text),
      x: clamp(num(input.x, 0.5), 0, 1), y: clamp(num(input.y, 0.15), 0, 1),
      size: clamp(num(input.size, 0.05), 0.01, 0.3),
      style: pick(input.style, TEXT_STYLES, 'card'),
      color: input.color || null, background: input.background || null,
      rotation: clamp(num(input.rotation, 0), -45, 45),
      animation: pick(input.animation, ANIMATIONS, 'pop'),
    };
    p.layers.push(layer);
    return `Added text ${layer.id}`;
  },

  add_caption(p, input) {
    if (!input.text) throw new Error('text is required');
    const layer = {
      id: nextLayerId(p), type: 'caption', ...timing(input, p),
      text: String(input.text),
      highlight: Array.isArray(input.highlight) ? input.highlight.map(String) : [],
      y: clamp(num(input.y, 0.72), 0, 1), size: clamp(num(input.size, 0.032), 0.01, 0.2),
      words: Array.isArray(input.words) ? input.words : null, // [{ text, start, end }] for karaoke
      animation: pick(input.animation, ANIMATIONS, 'fade'),
    };
    p.layers.push(layer);
    return `Added caption ${layer.id}`;
  },

  add_image(p, input) {
    const layer = {
      id: nextLayerId(p), type: 'image', ...timing(input, p),
      src: resolveImage(p, input),
      x: clamp(num(input.x, 0.25), 0, 1), y: clamp(num(input.y, 0.15), 0, 1),
      width: clamp(num(input.width, 0.35), 0.02, 1),
      rotation: clamp(num(input.rotation, 0), -45, 45),
      frame: pick(input.frame, IMAGE_FRAMES, 'sticker'),
      grayscale: input.grayscale === true,
      cutout: input.cutout === true,
      animation: pick(input.animation, ANIMATIONS, 'pop'),
    };
    p.layers.push(layer);
    return `Added image ${layer.id}`;
  },

  set_background(p, input) {
    const mode = pick(input.mode, BACKGROUND_MODES, null);
    if (!mode) throw new Error(`mode must be one of ${BACKGROUND_MODES.join(', ')}`);
    const bg = { ...emptyProject().background, ...p.background, mode };
    if (typeof input.color === 'string') bg.color = input.color;
    if (typeof input.blur === 'number') bg.blur = clamp(input.blur, 2, 40);
    if (mode === 'image') bg.src = resolveImage(p, input);
    p.background = bg;
    return mode === 'none' ? 'Original background restored' : `Background is now ${mode}`;
  },

  add_effect(p, input) {
    const effect = pick(input.effect, EFFECTS, null);
    if (!effect) throw new Error(`effect must be one of ${EFFECTS.join(', ')}`);
    const layer = {
      id: nextLayerId(p), type: 'effect', ...timing(input, p), effect,
      intensity: clamp(num(input.intensity, 1), 0, 1),
      label: input.label ? String(input.label) : null,
    };
    p.layers.push(layer);
    return `Added effect ${layer.id}`;
  },

  add_countdown(p, input) {
    const from = clamp(Math.round(num(input.from, 3)), 1, 10);
    const start = Math.max(0, num(input.start, p.trim.start || 0));
    const layer = { id: nextLayerId(p), type: 'countdown', start, end: start + from, from };
    p.layers.push(layer);
    return `Added countdown ${layer.id}`;
  },

  add_chart(p, input) {
    const points = (input.points || []).map(Number).filter(Number.isFinite);
    if (points.length < 2) throw new Error('points needs at least 2 numbers');
    const layer = {
      id: nextLayerId(p), type: 'chart', ...timing(input, p),
      title: input.title ? String(input.title) : '',
      value: input.value ? String(input.value) : '',
      subtitle: input.subtitle ? String(input.subtitle) : '',
      points, labels: Array.isArray(input.labels) ? input.labels.map(String) : [],
      fullscreen: input.fullscreen !== false,
    };
    p.layers.push(layer);
    return `Added chart ${layer.id}`;
  },

  update_layer(p, input) {
    const layer = findLayer(p, input.id);
    const changes = input.changes && typeof input.changes === 'object' ? input.changes : {};
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'id' || key === 'type') continue;
      layer[key] = value;
    }
    return `Updated ${layer.id}`;
  },

  remove_layers(p, input) {
    const ids = input.all ? p.layers.map((l) => l.id) : input.ids || [];
    const types = input.type ? [input.type] : null;
    const before = p.layers.length;
    p.layers = p.layers.filter((l) => !(ids.includes(l.id) || (types && types.includes(l.type))));
    return `Removed ${before - p.layers.length} layer(s)`;
  },

  reset_all(p) {
    const keep = { media: p.media, assets: p.assets };
    Object.assign(p, emptyProject(), keep);
    return 'Reset all edits';
  },
};

export const OP_NAMES = Object.keys(handlers);

// Returns { project, result } and never mutates the input project.
export function applyOp(project, name, input = {}) {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown edit ${name}`);
  const next = structuredClone(project);
  const result = handler(next, input || {});
  return { project: next, result };
}

export function isLayerActive(layer, t, isImage) {
  if (isImage) return true;
  if (t < layer.start) return false;
  return layer.end === null || t < layer.end;
}

// A compact view of the project for the model: everything except long word timings.
export function describeProject(project) {
  const layers = project.layers.map((l) => {
    const { words, ...rest } = l;
    return words ? { ...rest, words: `${words.length} timed words` } : rest;
  });
  return JSON.stringify({ ...project, layers }, null, 1);
}

// Tool definitions for Claude, one per operation (auto_captions is handled by the server).
const timeProps = {
  start: { type: 'number', description: 'Start time in seconds (source video time). Default: start of the clip.' },
  end: { type: ['number', 'null'], description: 'End time in seconds; null or omitted = until the end.' },
};
const posProps = {
  x: { type: 'number', description: 'Horizontal center, 0 = left edge, 1 = right edge.' },
  y: { type: 'number', description: 'Vertical center, 0 = top edge, 1 = bottom edge.' },
};

export const TOOLS = [
  {
    name: 'set_look',
    description: 'Change the global color grade of the whole video/photo. Use a preset and/or individual values. 100 = unchanged for brightness/contrast/saturation.',
    input_schema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: Object.keys(LOOK_PRESETS) },
        brightness: { type: 'number' }, contrast: { type: 'number' }, saturation: { type: 'number' },
        hue: { type: 'number', description: 'Degrees, -180..180' },
        grayscale: { type: 'number', description: '0..100' }, sepia: { type: 'number', description: '0..100' },
        blur: { type: 'number', description: 'Pixels, 0..20' }, vignette: { type: 'number', description: '0..100' },
      },
    },
  },
  {
    name: 'set_transform',
    description: 'Rotate (multiples of 90), flip, or zoom/crop into the center of the frame.',
    input_schema: {
      type: 'object',
      properties: {
        rotate: { type: 'number' }, flip_horizontal: { type: 'boolean' }, flip_vertical: { type: 'boolean' },
        zoom: { type: 'number', description: '1 = no zoom, 2 = 2x crop' },
      },
    },
  },
  {
    name: 'trim',
    description: 'Keep only part of the video.',
    input_schema: { type: 'object', properties: { ...timeProps } },
  },
  {
    name: 'set_speed',
    description: 'Playback speed of the exported video, 0.25..4.',
    input_schema: { type: 'object', properties: { speed: { type: 'number' } }, required: ['speed'] },
  },
  {
    name: 'add_text',
    description: 'Add a title, label or sticker-like text. Styles: plain (white with shadow), outline (white with black stroke), card (dark text on white card), accent (white text on terracotta card), label (small dark pill, e.g. a date tag).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, ...timeProps, ...posProps,
        size: { type: 'number', description: 'Font size as a fraction of frame height. 0.05 = title, 0.03 = small.' },
        style: { type: 'string', enum: TEXT_STYLES },
        color: { type: 'string', description: 'CSS color override for the text' },
        background: { type: 'string', description: 'CSS color override for the card' },
        rotation: { type: 'number', description: 'Degrees, small tilts like -4 look playful' },
        animation: { type: 'string', enum: ANIMATIONS },
      },
      required: ['text'],
    },
  },
  {
    name: 'add_caption',
    description: 'Add one subtitle line in a dark rounded box near the bottom. Words listed in highlight get an accent background.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, ...timeProps,
        highlight: { type: 'array', items: { type: 'string' }, description: 'Words from text to emphasize' },
        y: { type: 'number' }, size: { type: 'number' },
      },
      required: ['text'],
    },
  },
  {
    name: 'auto_captions',
    description: 'Transcribe the speech in the video and add timed captions for all of it. Replaces existing captions. Returns the caption ids and text so you can then highlight keywords with update_layer.',
    input_schema: {
      type: 'object',
      properties: {
        words_per_caption: { type: 'number', description: 'Default 4' },
        karaoke: { type: 'boolean', description: 'Highlight each word as it is spoken. Default true.' },
        language: { type: 'string', description: 'ISO code like en or ar, if known' },
      },
    },
  },
  {
    name: 'add_image',
    description: 'Overlay an image (photo cut-out, logo, sticker, B-roll picture). Use asset_id for images the user uploaded, or a direct https image URL.',
    input_schema: {
      type: 'object',
      properties: {
        asset_id: { type: 'string' }, url: { type: 'string' }, ...timeProps, ...posProps,
        width: { type: 'number', description: 'Width as a fraction of the frame width. 1 = full width (B-roll).' },
        rotation: { type: 'number' },
        frame: { type: 'string', enum: IMAGE_FRAMES, description: 'sticker = white cut-out border, polaroid = photo print' },
        grayscale: { type: 'boolean' },
        cutout: { type: 'boolean', description: 'Remove the photo background and keep only the person (best with frame sticker for a white outline)' },
        animation: { type: 'string', enum: ANIMATIONS },
      },
    },
  },
  {
    name: 'set_background',
    description: 'Replace everything behind the people in the video/photo: blur it, use a solid color, or an image (uploaded asset, URL, or one made with generate_image). mode none restores the original.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: BACKGROUND_MODES },
        color: { type: 'string', description: 'CSS color for mode color' },
        blur: { type: 'number', description: 'Blur strength in pixels for mode blur, default 14' },
        asset_id: { type: 'string' }, url: { type: 'string' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'generate_image',
    description: 'Create a new image with an AI image model from a detailed prompt. purpose background sets it as the background behind the people right away; purpose overlay returns an asset_id to use with add_image. To restyle the current room, describe the room from the snapshot (layout, furniture, light) plus the requested style.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        purpose: { type: 'string', enum: ['background', 'overlay'] },
      },
      required: ['prompt', 'purpose'],
    },
  },
  {
    name: 'add_effect',
    description: 'Apply a visual effect for a time range, e.g. black_and_white for a flashback, zoom_in for a punch-in, flash for a transition. Optional label shows a small tag in the corner (like a year, "1944").',
    input_schema: {
      type: 'object',
      properties: {
        effect: { type: 'string', enum: EFFECTS }, ...timeProps,
        intensity: { type: 'number', description: '0..1, default 1' },
        label: { type: 'string' },
      },
      required: ['effect'],
    },
  },
  {
    name: 'add_countdown',
    description: 'Old film-leader countdown (3, 2, 1) covering the frame.',
    input_schema: { type: 'object', properties: { start: { type: 'number' }, from: { type: 'number' } } },
  },
  {
    name: 'add_chart',
    description: 'Animated line chart with a big headline value, e.g. a price over time.',
    input_schema: {
      type: 'object',
      properties: {
        ...timeProps,
        title: { type: 'string' }, value: { type: 'string', description: 'Big number, e.g. "$601"' },
        subtitle: { type: 'string' },
        points: { type: 'array', items: { type: 'number' } },
        labels: { type: 'array', items: { type: 'string' }, description: 'x-axis labels, a few evenly spaced' },
        fullscreen: { type: 'boolean', description: 'Default true: dims the video behind the chart' },
      },
      required: ['points'],
    },
  },
  {
    name: 'update_layer',
    description: 'Change fields of an existing layer by id (position, timing, text, highlight, style...).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, changes: { type: 'object' } },
      required: ['id', 'changes'],
    },
  },
  {
    name: 'remove_layers',
    description: 'Remove layers by id, by type (text, caption, image, effect, countdown, chart), or all.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, type: { type: 'string' }, all: { type: 'boolean' } },
    },
  },
  {
    name: 'reset_all',
    description: 'Undo every edit and go back to the original media.',
    input_schema: { type: 'object', properties: {} },
  },
];
