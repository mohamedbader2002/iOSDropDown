import { applyOp, emptyProject } from './ops.js';
import { outputSize, renderFrame } from './renderer.js';
import { createVoiceInput, speak } from './voice.js';

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
let audio = null; // { ctx, source } created on first playback, needed to record sound on export
let recording = false;

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
  renderFrame(ctx, project, project.media ? source : null, currentTime(), draw);
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

function ensureAudio() {
  if (audio) return audio;
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaElementSource(video);
  source.connect(audioCtx.destination);
  audio = { ctx: audioCtx, source };
  return audio;
}

function togglePlay() {
  if (project.media?.kind !== 'video') return;
  ensureAudio().ctx.resume();
  if (video.paused) {
    clampToTrim();
    video.play();
  } else video.pause();
}

// ---------- timeline + assets ----------

const LAYER_LABEL = {
  text: (l) => `T  ${l.text}`,
  caption: (l) => `CC ${l.text}`,
  image: () => 'Image',
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

function pickMimeType() {
  const types = ['video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function exportMedia() {
  if (!project.media || recording) return;
  if (project.media.kind === 'image') {
    // Render at full resolution for photos.
    const full = document.createElement('canvas');
    Object.assign(full, outputSize(project, 4096));
    renderFrame(full.getContext('2d'), project, imageSource, 0);
    full.toBlob((blob) => download(blob, 'edited.png'), 'image/png');
    return;
  }

  recording = true;
  setBusy(true, 'Rendering video…');
  $('exportBtn').disabled = true;
  try {
    const { ctx: audioCtx, source } = ensureAudio();
    await audioCtx.resume();
    video.pause();
    video.currentTime = project.trim.start;
    await new Promise((r) => (video.onseeked = () => { video.onseeked = draw; draw(); r(); }));

    const stream = canvas.captureStream(30);
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (recorder.onstop = r));
    recorder.start(250);
    await video.play();
    await new Promise((resolve) => {
      const check = () => (video.currentTime >= trimEnd() || video.ended ? resolve() : requestAnimationFrame(check));
      check();
    });
    video.pause();
    recorder.stop();
    await stopped;
    source.disconnect(dest);

    const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
    if (blob.type.startsWith('video/mp4')) return download(blob, 'edited.mp4');
    setBusy(true, 'Converting to MP4…');
    const body = new FormData();
    body.append('file', new File([blob], 'export.webm', { type: 'video/webm' }));
    const res = await fetch('/api/transcode', { method: 'POST', body });
    if (res.ok) download(await res.blob(), 'edited.mp4');
    else download(blob, 'edited.webm');
  } catch (err) {
    addMessage('ai error', `Export failed: ${err.message}`);
  } finally {
    recording = false;
    setBusy(false);
    $('exportBtn').disabled = false;
  }
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
