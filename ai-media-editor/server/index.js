import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEditTurn } from './agent.js';
import { runFfmpeg, transcriptionConfigured } from './transcribe.js';
import { UPLOAD_DIR, uploadPath } from './media.js';
import { imageGenConfigured } from './imagegen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${randomUUID().slice(0, 8)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^(video|image)\//.test(file.mimetype)),
});

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/vendor/tasks-vision', express.static(path.join(ROOT, 'node_modules/@mediapipe/tasks-vision')));

// The person-segmentation model is downloaded once and then served locally.
const MODEL_DIR = path.join(ROOT, 'models');
const MODELS = {
  'selfie_multiclass_256x256.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};
const modelDownloads = new Map();
app.get('/models/:name', async (req, res) => {
  const source = MODELS[req.params.name];
  if (!source) return res.sendStatus(404);
  const file = path.join(MODEL_DIR, req.params.name);
  try {
    await stat(file);
  } catch {
    if (!modelDownloads.has(file)) {
      modelDownloads.set(file, (async () => {
        const r = await fetch(source);
        if (!r.ok) throw new Error(`Model download failed: ${r.status}`);
        await mkdir(MODEL_DIR, { recursive: true });
        await writeFile(`${file}.part`, Buffer.from(await r.arrayBuffer()));
        await rename(`${file}.part`, file);
      })().finally(() => modelDownloads.delete(file)));
    }
    try {
      await modelDownloads.get(file);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }
  res.sendFile(file);
});

app.get('/api/health', (_req, res) => {
  res.json({
    claude: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    ffmpeg: hasFfmpeg,
    transcription: transcriptionConfigured(),
    imageGeneration: imageGenConfigured(),
  });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a video or image file.' });
  res.json({
    id: path.parse(req.file.filename).name,
    url: `/uploads/${req.file.filename}`,
    kind: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
    name: req.file.originalname,
  });
});

app.post('/api/chat', async (req, res) => {
  const { project, history, message, frame } = req.body || {};
  if (!project || !message) return res.status(400).json({ error: 'project and message are required' });
  try {
    const out = await runEditTurn({ project, history, message, frame, mediaPath: uploadPath(project.media?.url) });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Edit failed' });
  }
});

// Export: the browser renders each frame and uploads it as a JPEG; ffmpeg joins them with the
// original audio (trimmed and sped up to match).
const RENDER_DIR = path.join(UPLOAD_DIR, 'renders');
const renders = new Map(); // id -> { dir, frames }

app.post('/api/render', async (_req, res) => {
  if (!hasFfmpeg) return res.status(501).json({ error: 'ffmpeg is not installed on the server' });
  const id = randomUUID();
  const dir = path.join(RENDER_DIR, id);
  await mkdir(dir, { recursive: true });
  renders.set(id, { dir, frames: 0 });
  res.json({ id });
});

app.put('/api/render/:id/frame/:n', express.raw({ type: '*/*', limit: '15mb' }), async (req, res) => {
  const session = renders.get(req.params.id);
  const n = Number(req.params.n);
  if (!session || !Number.isInteger(n) || n < 0 || n > 200_000) return res.sendStatus(404);
  await writeFile(path.join(session.dir, `${String(n).padStart(6, '0')}.jpg`), req.body);
  session.frames = Math.max(session.frames, n + 1);
  res.sendStatus(204);
});

// ffmpeg's atempo takes 0.5..2, so larger changes are chained.
function atempo(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(s);
  return parts.map((p) => `atempo=${p.toFixed(4)}`).join(',');
}

app.post('/api/render/:id/finish', async (req, res) => {
  const session = renders.get(req.params.id);
  if (!session) return res.sendStatus(404);
  renders.delete(req.params.id);
  const { fps = 30, media, start = 0, end, speed = 1 } = req.body || {};
  const source = uploadPath(media);
  const out = path.join(session.dir, 'edited.mp4');
  const args = ['-framerate', String(fps), '-i', path.join(session.dir, '%06d.jpg')];
  if (source) args.push('-ss', String(start), ...(end ? ['-to', String(end)] : []), '-i', source);
  args.push('-map', '0:v');
  if (source) args.push('-map', '1:a?', '-af', atempo(Number(speed) || 1), '-c:a', 'aac', '-b:a', '160k');
  args.push(
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-shortest', out,
  );
  try {
    await runFfmpeg(args);
    res.download(out, 'edited.mp4', () => rm(session.dir, { recursive: true, force: true }));
  } catch (err) {
    rm(session.dir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AI media editor running at http://localhost:${PORT}`);
});
