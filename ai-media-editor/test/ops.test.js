import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, emptyProject, TOOLS, OP_NAMES } from '../public/js/ops.js';
import { wordsToCaptions } from '../server/transcribe.js';

const withVideo = () => ({ ...emptyProject(), media: { kind: 'video', duration: 20, width: 720, height: 1280, url: '/uploads/x.mp4' } });

test('every tool except auto_captions maps to an operation', () => {
  for (const tool of TOOLS) {
    if (tool.name !== 'auto_captions') assert.ok(OP_NAMES.includes(tool.name), tool.name);
  }
});

test('applyOp does not mutate the input project', () => {
  const p = withVideo();
  const { project } = applyOp(p, 'add_text', { text: 'Hello' });
  assert.equal(p.layers.length, 0);
  assert.equal(project.layers[0].id, 'L1');
  assert.equal(project.layers[0].style, 'card');
});

test('set_look applies presets and clamps values', () => {
  const { project } = applyOp(withVideo(), 'set_look', { preset: 'black_and_white', brightness: 999 });
  assert.equal(project.look.grayscale, 100);
  assert.equal(project.look.brightness, 300);
});

test('trim is bounded by duration and validated', () => {
  assert.deepEqual(applyOp(withVideo(), 'trim', { start: 2, end: 50 }).project.trim, { start: 2, end: 20 });
  assert.throws(() => applyOp(withVideo(), 'trim', { start: 5, end: 3 }));
});

test('add_image needs a known asset', () => {
  const p = withVideo();
  p.assets.push({ id: 'A-1', url: '/uploads/a.png', name: 'a.png' });
  assert.equal(applyOp(p, 'add_image', { asset_id: 'A-1' }).project.layers[0].src, '/uploads/a.png');
  assert.throws(() => applyOp(p, 'add_image', { asset_id: 'nope' }));
});

test('update and remove layers', () => {
  let { project } = applyOp(withVideo(), 'add_caption', { text: 'one two', start: 1, end: 2 });
  project = applyOp(project, 'update_layer', { id: 'L1', changes: { highlight: ['two'], type: 'image' } }).project;
  assert.deepEqual(project.layers[0].highlight, ['two']);
  assert.equal(project.layers[0].type, 'caption');
  assert.throws(() => applyOp(project, 'update_layer', { id: 'L9', changes: {} }));
  assert.equal(applyOp(project, 'remove_layers', { type: 'caption' }).project.layers.length, 0);
});

test('reset_all keeps media and assets', () => {
  let { project } = applyOp(withVideo(), 'add_effect', { effect: 'flash' });
  project = applyOp(project, 'reset_all').project;
  assert.equal(project.layers.length, 0);
  assert.equal(project.media.duration, 20);
});

test('wordsToCaptions groups words by count, pauses and punctuation', () => {
  const w = (text, start) => ({ text, start, end: start + 0.3 });
  const caps = wordsToCaptions([w('a', 0), w('b', 0.3), w('c.', 0.6), w('d', 0.9), w('e', 3), w('f', 3.3)], 4);
  assert.deepEqual(caps.map((c) => c.text), ['a b c.', 'd', 'e f']);
});
