# AI Director Lite — operator notes

The user runs everything inside Claude Code cloud sessions (old computer, no local setup).
Claude operates the app on their behalf; the user only does the ChatGPT Pro part.

## Setup already done by the user
- `REPLICATE_API_TOKEN` is set in the cloud environment settings (check with `[ -n "$REPLICATE_API_TOKEN" ]`, never print it).
- Google Drive is connected through the Composio MCP (`googledrive` toolkit). Use it to fetch images/audio.

## Workflow
1. `npm install` (if needed), then start the server in the background: `npm start` (port 3000).
2. User sends the script, style reference image, and aspect ratio. Create a project, PATCH script/settings,
   upload the style image, POST `/api/projects/:id/plan`, and poll until `jobs.plan.status` is `done`.
3. **Save the plan to the repo right away** (the container is wiped when idle): write
   `projects/<slug>/shot-plan.json` (from `/export/plan.json`), `projects/<slug>/settings.json`, and the style image, then commit and push.
   A later session restores it with `POST /api/projects/:id/plan/import` (after PATCHing the script).
4. Send the user the ChatGPT job JSON (`/export/chatgpt.json`) and instructions (`/export/instructions.txt`) with SendUserFile.
5. When the user says the images are ready, find the Drive folder, download every `shot_####.png` plus the narration audio
   through Composio (GOOGLEDRIVE_FIND_FILE with folder_id → GOOGLEDRIVE_DOWNLOAD_FILE → fetch the s3url),
   then upload the images to `/api/projects/:id/images` (batches of ~25) and the audio to `/api/projects/:id/audio`.
6. POST `/transcribe` (default engine `openai/whisper`), check `alignStats.matchRate` (expect 90%+), then POST `/render`.
   Save the Whisper JSON to `projects/<slug>/whisper.json` (restore later with `/transcript/import`).
   Send the MP4 with SendUserFile (Drive uploads are capped at 5MB, so deliver the video in chat). Chat files are capped at 30MB:
   if the render is bigger, re-encode with Remotion's bundled ffmpeg
   (`node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg`, run with `LD_LIBRARY_PATH` set to that folder; `-c:v libx264 -crf 23 -maxrate 4M -bufsize 8M -c:a copy`).

See README.md for the API and settings.
