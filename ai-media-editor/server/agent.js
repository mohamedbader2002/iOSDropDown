import Anthropic from '@anthropic-ai/sdk';
import { applyOp, describeProject, TOOLS } from '../public/js/ops.js';
import { transcribeMedia, wordsToCaptions } from './transcribe.js';
import { importImageUrl } from './media.js';
import { generateImage } from './imagegen.js';

const client = new Anthropic();
const MODEL = process.env.EDITOR_MODEL || 'claude-opus-5-5';
// Edits are short, well-specified tool calls, so low effort keeps replies near-instant.
const EFFORT = process.env.EDITOR_EFFORT || 'low';
const MAX_STEPS = 10;

const SYSTEM = `You are the editing engine of a conversational video and photo editor.
The user talks (often by voice, in any language) and you turn what they say into edits by calling tools.
Each tool call changes the project immediately and the user sees the result live.

How to work:
- Act right away. Make every edit the request implies in this turn, using several tool calls when needed.
- Times are seconds of the source video. Positions are fractions of the frame (x 0..1 left→right, y 0..1 top→bottom, center of the element).
- You get a snapshot of the current frame. Use it to place things well: don't cover the speaker's face; titles usually go near the top, captions near the bottom.
- Write on-screen text in the language the user speaks unless they ask otherwise.
- For photos (media kind "image") timing is ignored; omit start/end.
- Background changes ("put me on a beach", "make my room look like 1914") use generate_image with purpose background; blur and solid colors use set_background directly.
- To turn a person in a photo into a sticker, use add_image with cutout true and frame sticker.
- If something isn't possible with the tools, say so in one sentence and offer the closest edit you can make.
- After editing, reply with one short sentence describing what changed, in the user's language. No lists, no markdown.`;

async function runTool(project, name, input, mediaPath) {
  if (name === 'auto_captions') {
    if (!project.media || project.media.kind !== 'video') throw new Error('Auto captions need a video.');
    const words = await transcribeMedia(mediaPath, input.language);
    if (!words.length) throw new Error('No speech was found in the video.');
    let next = applyOp(project, 'remove_layers', { type: 'caption' }).project;
    const lines = [];
    for (const caption of wordsToCaptions(words, input.words_per_caption || 4)) {
      const karaoke = input.karaoke !== false;
      const out = applyOp(next, 'add_caption', { ...caption, words: karaoke ? caption.words : null });
      next = out.project;
      const layer = next.layers[next.layers.length - 1];
      lines.push(`${layer.id} [${layer.start.toFixed(1)}-${layer.end.toFixed(1)}s] ${layer.text}`);
    }
    return { project: next, result: `Added ${lines.length} captions:\n${lines.join('\n')}` };
  }
  if (name === 'generate_image') {
    const asset = await generateImage(String(input.prompt || ''));
    const withAsset = structuredClone(project);
    withAsset.assets.push(asset);
    if (input.purpose === 'background') {
      const out = applyOp(withAsset, 'set_background', { mode: 'image', asset_id: asset.id });
      return { project: out.project, result: `Generated ${asset.id} and set it as the background` };
    }
    return { project: withAsset, result: `Generated image asset_id ${asset.id}. Place it with add_image.` };
  }
  if ((name === 'add_image' || name === 'set_background') && input.url && !input.asset_id) {
    // Download remote images so the canvas stays exportable (no cross-origin tainting).
    const asset = await importImageUrl(input.url);
    const withAsset = structuredClone(project);
    withAsset.assets.push(asset);
    return applyOp(withAsset, name, { ...input, url: undefined, asset_id: asset.id });
  }
  return applyOp(project, name, input);
}

/**
 * Runs one conversational turn: Claude reads the request and the project, calls edit tools,
 * and we apply each one to the project. Returns the edited project and a short reply.
 */
export async function runEditTurn({ project, history = [], message, frame, mediaPath }) {
  const userContent = [];
  if (frame && /^data:image\/(jpeg|png|webp);base64,/.test(frame)) {
    const [, mediaType, data] = frame.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    userContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }
  userContent.push({
    type: 'text',
    text: `Current project:\n${describeProject(project)}\n\nUser: ${message}`,
  });

  const messages = [
    ...history.slice(-12).map((m) => ({ role: m.role, content: String(m.text) })),
    { role: 'user', content: userContent },
  ];
  // The API needs alternating turns starting with the user.
  while (messages.length && messages[0].role !== 'user') messages.shift();

  const actions = [];
  let reply = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      output_config: { effort: EFFORT },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });

    if (response.stop_reason === 'refusal') {
      reply = "I can't make that edit.";
      break;
    }

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (text) reply = text;

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const tool of toolUses) {
      try {
        const out = await runTool(project, tool.name, tool.input, mediaPath);
        project = out.project;
        actions.push({ name: tool.name, input: tool.input, result: out.result });
        results.push({ type: 'tool_result', tool_use_id: tool.id, content: out.result });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: tool.id, content: String(err.message || err), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  return { project, reply: reply || 'Done.', actions };
}
