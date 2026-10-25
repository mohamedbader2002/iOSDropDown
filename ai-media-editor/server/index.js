import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEditTurn } from './agent.js';
import { runFfmpeg, transcriptionConfigured } from './transcribe.js';
import { UPLOAD_DIR, uploadPath } from './media.js';

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

app.get('/api/health', (_req, res) => {
  res.json({
    claude: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    ffmpeg: hasFfmpeg,
    transcription: transcriptionConfigured(),
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

// The browser records the edited video as WebM; convert it to a widely playable MP4.
app.post('/api/transcode', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  if (!hasFfmpeg) return res.status(501).json({ error: 'ffmpeg is not installed on the server' });
  const out = path.join(UPLOAD_DIR, `${path.parse(req.file.filename).name}-export.mp4`);
  try {
    await runFfmpeg([
      '-i', req.file.path, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out,
    ]);
    res.download(out, 'edited.mp4', () => rm(out, { force: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    rm(req.file.path, { force: true });
  }
});

app.listen(PORT, () => {
  console.log(`AI media editor running at http://localhost:${PORT}`);
});
