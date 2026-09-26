# AI Director Lite

Your Replit "AI Director" pipeline, minus the expensive image API:

```
script ──► GPT-5.6 Sol on Replicate (the same Director prompts) ──► shot plan + character bible
       ──► ChatGPT image-job JSON  ──► ChatGPT Pro scheduled task makes the images ──► Google Drive
       ──► upload images (.zip or up to 500 files) + your narration audio
       ──► Whisper on Replicate (word timestamps) ──► every image switches on its exact word
       ──► Remotion ──► MP4
```

## Setup

```bash
npm install
cp .env.example .env      # add your REPLICATE_API_TOKEN
npm start                 # http://localhost:3000
```

Node 20.12+ is required. Remotion downloads its own headless Chrome the first time you render (or set `REMOTION_BROWSER_EXECUTABLE`).
Remotion is free for individuals and companies with up to 3 employees; larger companies need a Remotion company licence.

## The five steps (one page)

1. **Script & style**: paste the script, pick the aspect ratio, type a style and/or upload a **style reference image** (it overrides the text style, exactly like your Replit app). Click **Direct this script**.
   Long scripts are planned in ~400-word sections with the character list and the previous section's last visual state carried forward. Weak, style-only directions are sent to the repair prompt automatically; if repair fails, a narration-based fallback is used and listed in the notes.
   You can also **Import existing plan JSON** (`{characters, shots}`) from the Replit app.
2. **Shot plan → ChatGPT**: review and edit each shot's direction. You'll see the exact final prompt per image, built with your engine's rules (identity anchor, wardrobe override, off-screen/background rule, edit continuity rule, Comic Sans rule, and the STYLE REFERENCE RULE).
   - **Download ChatGPT job JSON**: every image with `file_name` (`shot_0001.png`…), `kind` (`new_scene` / `continues_previous`), `reference_image`, narration, and the full prompt. The file also includes the run schedule.
   - **Copy ChatGPT instructions**: paste this into ChatGPT with the JSON **and your style image** attached. ChatGPT first replies with the image count and run plan, then each scheduled run makes the next N missing images and saves them to your Drive folder with exact names.
   - Runs try to end just before a new scene, so an edit shot rarely has to continue from yesterday's image. Per-run JSON files are there if one big file is too much to attach.
3. **Images**: drop the Google Drive download (`.zip`) or up to 500 loose images. Files are matched by the shot number in the name (`shot_0012.png`, `12.png`, `image 12.png`). Files without a shot number (e.g. `ChatGPT Image … 08_15_32 AM.png`) fill the empty shots oldest-first. Any single shot can be replaced from the grid.
4. **Audio sync**: upload the narration, then click **Transcribe & sync**.
   - **WhisperX** (`victor-upmeet/whisperx`) is the default because its forced alignment gives the most accurate word timestamps. Incredibly-fast-whisper and OpenAI Whisper (segment timing only) are available as alternatives.
   - The script words are aligned to the heard words (banded Needleman–Wunsch alignment, tolerant of misheard words, "12" vs "twelve", filler words). Each image starts on the first word of its narration and holds until the next shot's first word. The first image covers any intro silence and the last one runs to the end of the audio.
   - **Cut lead** moves every cut slightly before its word (editors often use 0.03–0.08s). **Import Whisper JSON** lets you skip Replicate.
   - The in-page preview plays the audio and swaps the images live.
5. **Render**: pick FPS, a subtle camera move (Ken Burns, off automatically on flash cuts under 0.6s) or static images, and hard cut or quick dissolve. Missing images hold the previous frame.

## Project layout

```
server/director/prompts/   the Director prompts, verbatim (system, planning, reference-image, chunk context, repair)
server/director/planner.js chunking, Replicate calls, JSON retry, repair pass
server/director/validate.js verbatim-coverage reconciliation, structure rules, weak-direction detection
server/director/imagePrompts.js final per-image prompt assembly
server/export/chatgpt.js   ChatGPT job JSON + instructions + run schedule
server/sync/               Whisper normalisation + script↔audio alignment
server/render/render.js    Remotion bundle + render
remotion/                  the video composition
public/                    the web UI
data/projects/<id>/        your projects (images, audio, renders), git-ignored
```

`npm test` runs the unit tests (coverage repair, prompt assembly, ChatGPT export, alignment, transcript parsing).
