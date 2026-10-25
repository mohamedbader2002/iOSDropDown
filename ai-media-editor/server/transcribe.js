import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Speech-to-text for auto captions. Any service exposing the common
// POST /v1/audio/transcriptions endpoint with word timestamps works
// (a hosted Whisper API, or a self-hosted faster-whisper / whisper.cpp server).
const URL_ = process.env.TRANSCRIBE_URL;
const KEY = process.env.TRANSCRIBE_API_KEY;
const MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';

export function transcriptionConfigured() {
  return Boolean(URL_);
}

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-v', 'error', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `ffmpeg exited ${code}`))));
  });
}

export async function transcribeMedia(mediaPath, language) {
  if (!URL_) {
    throw new Error('Auto captions are not set up on this server (TRANSCRIBE_URL is missing). Tell the user they can still dictate captions by saying what text to show and when.');
  }
  if (!mediaPath) throw new Error('The video file is not on the server.');
  const audioPath = path.join(os.tmpdir(), `audio-${Date.now()}.mp3`);
  await runFfmpeg(['-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audioPath]);
  try {
    const form = new FormData();
    form.append('file', new Blob([await readFile(audioPath)], { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    if (language) form.append('language', language);
    const res = await fetch(URL_, { method: 'POST', body: form, headers: KEY ? { Authorization: `Bearer ${KEY}` } : {} });
    if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    if (Array.isArray(data.words)) {
      return data.words.map((w) => ({ text: String(w.word).trim(), start: w.start, end: w.end })).filter((w) => w.text);
    }
    // Segment-only responses: spread each segment's duration over its words.
    return (data.segments || []).flatMap((s) => {
      const parts = String(s.text).trim().split(/\s+/).filter(Boolean);
      const step = (s.end - s.start) / Math.max(1, parts.length);
      return parts.map((text, i) => ({ text, start: s.start + i * step, end: s.start + (i + 1) * step }));
    });
  } finally {
    await rm(audioPath, { force: true });
  }
}

// Group timed words into short caption lines, breaking on pauses and sentence ends.
export function wordsToCaptions(words, perLine = 4) {
  const captions = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    captions.push({
      text: current.map((w) => w.text).join(' '),
      start: current[0].start,
      end: current[current.length - 1].end,
      words: current,
    });
    current = [];
  };
  for (const word of words) {
    const prev = current[current.length - 1];
    if (prev && (word.start - prev.end > 0.6 || current.length >= perLine)) flush();
    current.push(word);
    if (/[.!?؟،,]$/.test(word.text)) flush();
  }
  flush();
  // Keep each caption on screen until the next one starts (avoids flicker in short gaps).
  for (let i = 0; i < captions.length - 1; i++) {
    const gap = captions[i + 1].start - captions[i].end;
    if (gap > 0 && gap < 0.6) captions[i].end = captions[i + 1].start;
  }
  return captions;
}
