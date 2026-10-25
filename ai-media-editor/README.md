# TalkEdit: edit videos and photos by talking

Open a video or photo, then say (or type) what you want:

> "Give it a cinematic look" · "Add captions and highlight the key words" · "Put my logo top-left as a sticker" ·
> "Make the part from 4 to 7 seconds black and white with the label 1944" · "Add a 3-2-1 countdown" ·
> "Show a chart of Bitcoin going from $1 to $601, title it Bitcoin price" · "Trim to the first 30 seconds" · "Undo that title" ·
> "Blur my background" · "Put me in a 1914 study room" · "Cut the person out of this photo and stick it next to me"

Each request becomes an edit right away in the live preview. When you're happy, **Export** gives you an MP4 (video) or PNG (photo).

## How it works

```
 voice / text ──► browser ──(project JSON + frame snapshot)──► server ──► Claude (tool use)
                    ▲                                              │
                    └──────────── edited project JSON ◄────────────┘
```

- **The edit model is plain JSON** (`public/js/ops.js`): color grade, transform, trim, speed and a list of time-ranged
  layers (text, captions, image stickers, effects, countdown, chart). Every edit is a named operation, and the same
  module runs in the browser (instant preview, undo/redo) and on the server (the AI agent).
- **Claude turns speech into operations.** `server/agent.js` sends the request, the current project and a small
  snapshot of the frame (so it can place things without covering your face) and runs a tool-use loop. Each tool
  call is applied to the project.
- **Rendering happens in the browser** (`public/js/renderer.js`) on a canvas, so the preview is exactly what you
  export. Video export renders every frame (so heavy effects never drop frames), uploads them to the server,
  and ffmpeg joins them with the original audio into an MP4.
- **Background replacement and cut-outs** run in the browser with MediaPipe's selfie segmentation model
  (`public/js/segment.js`). The model (16 MB) is downloaded once by the server and then served locally.
  It runs on the GPU when the browser allows it; add `?delegate=cpu` to the URL to force the CPU.
- **AI backgrounds** (optional) come from an image generation service. Claude writes the prompt, describing your
  room from the snapshot plus the style you asked for.
- **Voice input** uses the browser's speech recognition (Chrome, Edge, Safari). Hold the mic button or the Space bar.
  Pick the language with the selector, including Arabic. You can also have replies read aloud.
- **Auto captions** (optional) transcribe the video's speech with word timings and add karaoke-style captions.
  Then you can say "highlight the important words".

## Run it

Requirements: Node 20+, ffmpeg (for MP4 export and captions).

```bash
cd ai-media-editor
npm install
cp .env.example .env        # add your ANTHROPIC_API_KEY
node --env-file=.env server/index.js
# open http://localhost:3000
```

Run the tests with `npm test`.

## What it can do today

| Area | Edits |
| --- | --- |
| Look | presets (cinematic, warm, cool, vivid, black & white, vintage, faded), brightness, contrast, saturation, hue, blur, vignette |
| Frame | rotate, flip, zoom/crop, trim, speed |
| Text | titles and labels in 5 styles, any language (RTL supported), pop/fade/slide animations |
| Captions | dark box with highlighted words, karaoke word highlighting, auto-transcription |
| Images | uploaded images or image URLs as stickers, polaroids or full-frame B-roll |
| Effects (time-ranged) | black & white, sepia, vintage, blur, zoom in/out, shake, flash, film grain, with optional corner label |
| Motion graphics | film-leader countdown, animated line chart with headline value |
| Background | blur, solid color, uploaded image, or AI-generated image behind the people |
| Cut-outs | remove a photo's background so only the person remains, with a white sticker outline |

## Ideas for next steps

- **Object removal and image editing** ("remove the lamp"): send the frame to an image editing model instead of
  generating a new background from a prompt.
- **Cut-outs of objects**, not just people (the selfie model only finds people).
- **Image search for B-roll**: a tool that finds pictures for what's being said and drops them in on cue.
- **Cuts and silence removal**: remove the pauses between sentences using the transcript timings.
- **Mobile app**: the browser app already works on phones. Wrap it with Capacitor, or reuse the same JSON edit
  model in a native SwiftUI/AVFoundation renderer.
