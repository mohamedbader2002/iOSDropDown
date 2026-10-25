import { applyOp, emptyProject } from './ops.js';
import { outputSize, preloadImages, renderFrame } from './renderer.js';
import { createVoiceInput, speak } from './voice.js';
import { cutout, personMask, segmenterReady } from './segment.js';

const segmentation = { personMask, cutout };
const exportSegmentation = { cutout, personMask: (source, kind, redraw) => personMask(source, kind, redraw, true) };

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d');
const video = $('video');

let project = emptyProject();
let undoStack = [];
let redoStack = [];
let chatHistory = []; // [{ role, text }] sent back to the AI for context
let imageSource = null;
let busy = false;
let recording = false; // exporting; the preview loop must not move the playhead

// ---------- project state ----------

function commit(next) {
  undoStack.push(project);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  project = next;
  onProjectChanged();
}

function onProjectChanged() {
  const { width, height } = outputSize(project);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  video.playbackRate = project.speed;
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
  $('exportBtn').disabled = !project.media;
  renderTimeline();
  renderAssets();
  if (project.media?.kind === 'video') clampToTrim();
  draw();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(project);
  project = undoStack.pop();
  onProjectChanged();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(project);
  project = redoStack.pop();
  onProjectChanged();
}

// ---------- rendering ----------

const currentTime = () => (project.media?.kind === 'video' ? video.currentTime : 0);
const trimEnd = () => project.trim.end ?? project.media?.duration ?? 0;

function draw() {
  const source = project.media?.kind === 'video' ? video : imageSource;
  renderFrame(ctx, project, project.media ? source : null, currentTime(), draw, segmentation);
  updateTransport();
}

function loop() {
  if (!video.paused && project.media?.kind === 'video') {
    if (video.currentTime >= trimEnd()) {
      if (!recording) video.currentTime = project.trim.start; // loop the preview
    }
    draw();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function clampToTrim() {
  if (video.currentTime < project.trim.start || video.currentTime > trimEnd()) video.currentTime = project.trim.start;
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function updateTransport() {
  if (project.media?.kind !== 'video') return;
  const scrub = $('scrubber');
  scrub.max = project.media.duration || 1;
  if (document.activeElement !== scrub) scrub.value = video.currentTime;
  $('timeLabel').textContent = `${fmt(video.currentTime)} / ${fmt(project.media.duration || 0)}`;
  $('playBtn').textContent = video.paused ? '▶' : '❚❚';
}

function togglePlay() {
  if (project.media?.kind !== 'video') return;
  if (video.paused) {
    clampToTrim();
    video.play();
  } else video.pause();
}

// ---------- timeline + assets ----------

const LAYER_LABEL = {
  text: (l) => `T  ${l.text}`,
  caption: (l) => `CC ${l.text}`,
  image: (l) => (l.cutout ? 'Image · cut-out' : 'Image'),
  effect: (l) => `FX ${l.effect.replace(/_/g, ' ')}${l.label ? ` · ${l.label}` : ''}`,
  countdown: (l) => `Countdown ${l.from}`,
  chart: (l) => `Chart ${l.value || l.title}`,
};

function renderTimeline() {
  const el = $('timeline');
  el.innerHTML = '';
  const duration = project.media?.duration || 0;
  const isImage = project.media?.kind === 'image';
  for (const layer of project.layers) {
    const track = document.createElement('div');
    track.className = 'track';
    const bar = document.createElement('div');
    bar.className = `bar ${layer.type}`;
    const start = isImage || !duration ? 0 : layer.start / duration;
    const end = isImage || !duration ? 1 : (layer.end ?? duration) / duration;
    bar.style.left = `${start * 100}%`;
    bar.style.width = `max(${(end - start) * 100}%, 90px)`;
    bar.style.maxWidth = `${(1 - start) * 100}%`;
    bar.title = `${layer.id} · ${LAYER_LABEL[layer.type](layer)}`;
    bar.textContent = LAYER_LABEL[layer.type](layer);
    bar.dir = 'auto';
    bar.onclick = () => {
      if (!isImage) {
        video.currentTime = layer.start;
        draw();
      }
    };
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.onclick = (e) => {
      e.stopPropagation();
      commit(applyOp(project, 'remove_layers', { ids: [layer.id] }).project);
    };
    bar.append(remove);
    track.append(bar);
    el.append(track);
  }
}

function renderAssets() {
  const el = $('assetList');
  el.innerHTML = '';
  for (const asset of project.assets) {
    const item = document.createElement('div');
    item.className = 'asset';
    item.innerHTML = `<img alt="" /><span></span>`;
    item.querySelector('img').src = asset.url;
    item.querySelector('span').textContent = `${asset.id} · ${asset.name}`;
    el.append(item);
  }
}

// ---------- uploads ----------

async function uploadFile(file) {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
  return res.json();
}

async function openMedia(file) {
  setBusy(true, 'Uploading…');
  try {
    const info = await uploadFile(file);
    const media = { ...info };
    if (info.kind === 'video') {
      video.src = info.url;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error('This video format is not supported by your browser.'));
      });
      Object.assign(media, { width: video.videoWidth, height: video.videoHeight, duration: video.duration });
      video.onseeked = draw;
      imageSource = null;
    } else {
      imageSource = await loadImage(info.url);
      Object.assign(media, { width: imageSource.naturalWidth, height: imageSource.naturalHeight, duration: null });
    }
    const fresh = emptyProject();
    fresh.assets = project.assets;
    fresh.media = media;
    undoStack = [];
    redoStack = [];
    project = fresh;
    $('emptyState').hidden = true;
    $('transport').hidden = info.kind !== 'video';
    onProjectChanged();
    addMessage('ai', info.kind === 'video'
      ? `Loaded ${info.name} (${fmt(media.duration)}). What should I change?`
      : `Loaded ${info.name}. What should I change?`);
  } catch (err) {
    addMessage('ai error', err.message);
  } finally {
    setBusy(false);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = url;
  });
}

async function addAssets(files) {
  for (const file of files) {
    try {
      const info = await uploadFile(file);
      const next = structuredClone(project);
      next.assets.push({ id: `A-${info.id}`, url: info.url, name: info.name });
      commit(next);
      addMessage('ai', `Added image ${info.name}. Ask me to place it, e.g. “put this image top-left as a sticker”.`);
    } catch (err) {
      addMessage('ai error', err.message);
    }
  }
}

// ---------- chat ----------

function addMessage(kind, text, actions = []) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.dir = 'auto';
  el.textContent = text;
  if (actions.length) {
    const ops = document.createElement('div');
    ops.className = 'ops';
    for (const a of actions) {
      const chip = document.createElement('span');
      chip.textContent = a.name.replace(/_/g, ' ');
      chip.title = a.result;
      ops.append(chip);
    }
    el.append(ops);
  }
  $('messages').append(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function setBusy(on, label = 'Editing…') {
  busy = on;
  $('busy').hidden = !on;
  $('busy').lastChild.textContent = ` ${label}`;
}

// A small snapshot of what the user is looking at, so the AI can place things sensibly.
function snapshot() {
  if (!project.media) return null;
  const w = 384;
  const h = Math.round((canvas.height / canvas.width) * w);
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  small.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return small.toDataURL('image/jpeg', 0.7);
}

async function send(message) {
  message = message.trim();
  if (!message || busy) return;
  if (!project.media) {
    addMessage('ai', 'Open a video or photo first, then tell me what to do with it.');
    return;
  }
  addMessage('user', message);
  $('promptInput').value = '';
  setBusy(true);
  const wasPlaying = !video.paused;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project,
        history: chatHistory,
        message: project.media.kind === 'video' ? `${message}\n(Playhead is at ${video.currentTime.toFixed(2)}s)` : message,
        frame: snapshot(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Edit failed');
    if (data.actions.length) commit(data.project);
    addMessage('ai', data.reply, data.actions);
    chatHistory.push({ role: 'user', text: message }, { role: 'assistant', text: data.reply });
    if ($('speakReplies').checked) speak(data.reply, $('langSelect').value);
    if (wasPlaying && video.paused) video.play();
  } catch (err) {
    addMessage('ai error', err.message);
  } finally {
    setBusy(false);
  }
}

// ---------- export ----------

const EXPORT_FPS = 30;

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function seek(t) {
  return new Promise((resolve) => {
    video.addEventListener('seeked', resolve, { once: true });
    video.currentTime = t;
  });
}

// Waits until every image and model the project needs is loaded, so no exported frame misses them.
async function prepareAssets() {
  const srcs = project.layers.filter((l) => l.type === 'image').map((l) => l.src);
  if (project.background.mode === 'image' && project.background.src) srcs.push(project.background.src);
  await preloadImages(srcs);
  if (project.background.mode !== 'none' || project.layers.some((l) => l.cutout)) await segmenterReady();
}

async function exportMedia() {
  if (!project.media || recording) return;
  recording = true;
  $('exportBtn').disabled = true;
  setBusy(true, 'Preparing…');
  try {
    await prepareAssets();
    if (project.media.kind === 'image') {
      // Render at full resolution for photos.
      const full = document.createElement('canvas');
      Object.assign(full, outputSize(project, 4096));
      renderFrame(full.getContext('2d'), project, imageSource, 0, () => {}, segmentation);
      download(await new Promise((r) => full.toBlob(r, 'image/png')), 'edited.png');
      return;
    }
    await exportVideo();
  } catch (err) {
    addMessage('ai error', `Export failed: ${err.message}`);
  } finally {
    recording = false;
    setBusy(false);
    $('exportBtn').disabled = false;
  }
}

// Renders the video frame by frame (so heavy effects never drop frames), streams the frames
// to the server, and lets ffmpeg add the original audio.
async function exportVideo() {
  video.pause();
  const frameCanvas = document.createElement('canvas');
  Object.assign(frameCanvas, outputSize(project, 1920));
  const frameCtx = frameCanvas.getContext('2d');
  const { start } = project.trim;
  const end = trimEnd();
  const step = project.speed / EXPORT_FPS; // source seconds per output frame
  const total = Math.max(1, Math.floor((end - start) / step));

  const session = await (await fetch('/api/render', { method: 'POST' })).json();
  if (session.error) throw new Error(session.error);
  const inFlight = new Set();
  for (let i = 0; i < total; i++) {
    const t = start + i * step;
    await seek(t);
    renderFrame(frameCtx, project, video, t, () => {}, exportSegmentation);
    const blob = await new Promise((r) => frameCanvas.toBlob(r, 'image/jpeg', 0.92));
    const upload = fetch(`/api/render/${session.id}/frame/${i}`, { method: 'PUT', body: blob }).then((res) => {
      if (!res.ok) throw new Error('Frame upload failed');
    });
    inFlight.add(upload);
    upload.finally(() => inFlight.delete(upload));
    if (inFlight.size >= 6) await Promise.race(inFlight);
    if (i % 10 === 0) setBusy(true, `Rendering ${Math.round((i / total) * 100)}%`);
  }
  await Promise.all(inFlight);
  setBusy(true, 'Encoding MP4…');
  const res = await fetch(`/api/render/${session.id}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: EXPORT_FPS, media: project.media.url, start, end, speed: project.speed }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Encoding failed');
  download(await res.blob(), 'edited.mp4');
  await seek(start);
}

// ---------- wiring ----------

$('mediaInput').onchange = (e) => e.target.files[0] && openMedia(e.target.files[0]);
$('assetInput').onchange = (e) => addAssets([...e.target.files]);
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
$('exportBtn').onclick = exportMedia;
$('playBtn').onclick = togglePlay;
canvas.onclick = togglePlay;
$('scrubber').oninput = (e) => {
  video.currentTime = Number(e.target.value);
};
$('composer').onsubmit = (e) => {
  e.preventDefault();
  send($('promptInput').value);
};
for (const chip of $('suggestions').querySelectorAll('button')) {
  chip.onclick = () => send(chip.textContent);
}

const drop = $('dropZone');
drop.ondragover = (e) => {
  e.preventDefault();
  drop.classList.add('dragging');
};
drop.ondragleave = () => drop.classList.remove('dragging');
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  const media = files.find((f) => /^(video|image)\//.test(f.type));
  if (!project.media && media) openMedia(media);
  else if (files.length) addAssets(files.filter((f) => f.type.startsWith('image/')));
};

const voice = createVoiceInput({
  button: $('micBtn'),
  input: $('promptInput'),
  getLang: () => $('langSelect').value,
  onFinal: send,
});
if (!voice.supported) $('micBtn').title = 'Voice input needs Chrome, Edge or Safari';

$('langSelect').onchange = () => {
  $('promptInput').dir = $('langSelect').value.startsWith('ar') || $('langSelect').value.startsWith('ur') ? 'rtl' : 'auto';
};

document.addEventListener('keydown', (e) => {
  const typing = document.activeElement === $('promptInput');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  }
});

fetch('/api/health').then((r) => r.json()).then((h) => {
  if (!h.claude) addMessage('ai error', 'The server has no ANTHROPIC_API_KEY set, so AI edits will fail. See README.');
}).catch(() => {});

onProjectChanged();
