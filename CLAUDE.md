# AI Director Lite — operator notes

The user runs everything inside Claude Code cloud sessions (old computer, no local setup).
Claude operates the app on their behalf; the user only does the ChatGPT Pro part.

## Setup already done by the user
- `REPLICATE_API_TOKEN` is set in the cloud environment settings (check with `[ -n "$REPLICATE_API_TOKEN" ]`, never print it).
- Google Drive is connected through the Composio MCP (`googledrive` toolkit). Use it to fetch images/audio and to deliver the video.

## Starting a new video
The user starts a new cloud session and sends: the video name, the script, the style reference image, and the aspect ratio.
The narration audio comes later, either in the Drive image folder or attached in chat. Past projects live in `projects/<slug>/`.

## Workflow
1. `npm install` (if needed), then start the server in the background: `npm start` (port 3000).
2. User sends the script, style reference image, and aspect ratio. Create a project, PATCH script/settings,
   upload the style image, POST `/api/projects/:id/plan`, and poll until `jobs.plan.status` is `done`.
3. **Save the plan to the repo right away** (the container is wiped when idle): write
   `projects/<slug>/shot-plan.json` (from `/export/plan.json`), `projects/<slug>/settings.json`, and the style image, then commit and push.
   A later session restores it with `POST /api/projects/:id/plan/import` (after PATCHing the script).
4. Send the user the ChatGPT job JSON (`/export/chatgpt.json`) and instructions (`/export/instructions.txt`) with SendUserFile.
5. **Review the images before using them** (the user asked for this step). Images may arrive as loose `shot_####.png` or as zips
   (`*-batch-N.zip`, `*-batch-N-updated.zip`); for each shot always use the NEWEST version. Check: all shots present, no byte-identical
   duplicates (`md5sum`; ChatGPT has repeated and shifted a whole batch before), then look at every image in 2x3 contact sheets
   (Pillow) against its narration line and planned scene from `shot-plan.json`: right scene/speaker, recurring characters and the
   car stay consistent, numbers/text correct, no AI glitches or style-image leftovers. Write `projects/<slug>/review.md` with
   what's wrong per shot and a ready-to-paste ChatGPT prompt (original prompt + CORRECTION), send it with a grid of the flagged
   images, and wait: the user regenerates or says ignore. Good images in the wrong slots can be re-mapped instead of regenerated;
   save the mapping in `projects/<slug>/`. Only delete old files in Drive if the user asks.
6. When the images are ready, find the Drive folder, download every `shot_####.png` plus the narration audio,
   then upload the images to `/api/projects/:id/images` (batches of ~25) and the audio to `/api/projects/:id/audio`.
   For more than ~20 images, do the downloads in COMPOSIO_REMOTE_WORKBENCH (214 images took ~40s): list the folder with
   GOOGLEDRIVE_FIND_FILE, run GOOGLEDRIVE_DOWNLOAD_FILE + fetch the s3url with a ThreadPoolExecutor(16) (wrap it in
   `contextlib.redirect_stdout` — the helper prints every response), zip ~43 images per ZIP_STORED archive, PUT each zip to a
   presigned link (step 8a) and `curl -L` its `download_url` here. For a few images, GOOGLEDRIVE_DOWNLOAD_FILE → fetch the s3url.
7. POST `/transcribe`. With the default engine it runs WhisperX (word-accurate) and OpenAI Whisper side by side and times each
   script word from WhisperX, switching to OpenAI Whisper only where WhisperX skipped the word or is >2.5s off (WhisperX sometimes
   drops a sentence and stretches the next ones over its audio). Lines neither engine heard are left out instead of flashing by.
   Check the job message (how many word times came from OpenAI Whisper) and `alignStats` (`unspokenShots`, very short shots),
   then POST `/render`. Default cut lead is 0.08s (about 2 frames early). Measured: cuts land within ~0.1s of the voice
   (before, with `openai/whisper` alone: median 0.23s, worst 1.8s off).
   Save `{words, altWords}` from the project's transcript to `projects/<slug>/whisper.json` (restore later with `/transcript/import`).
8. **Deliver the full-quality MP4 to Google Drive** (same folder as the images, named `<Title>.mp4`). The normal Drive upload is
   capped at 5MB, so use this route (tested up to a 1.14GB, 12-minute video; checksum verified):
   a. In COMPOSIO_REMOTE_WORKBENCH, request a presigned upload link and print only `key` and `upload_url` (never print the access key):
      ```python
      import requests, os
      r = requests.post(os.environ.get("BACKEND_URL", "https://backend.composio.dev") + "/api/v3/tool_router/internal/presigned_url",
                        json={"operation": "upload"},
                        headers={"x-session-access-key": os.environ["COMPOSIO_WORKBENCH_ACCESS_KEY"], "Content-Type": "application/json"})
      r.raise_for_status(); j = r.json(); print("KEY=" + j["key"]); print("UPLOAD=" + j["upload_url"])
      ```
   b. From this machine: `curl -H "Content-Type: video/mp4" -T <render>.mp4 '<upload_url>'` (expect 200; link lasts 1 hour).
      Use `-T` (streams from disk), not `--data-binary @file`, which loads the file into memory and fails around 1GB.
   c. GOOGLEDRIVE_RESUMABLE_UPLOAD with `file_to_upload: {name, mimetype: "video/mp4", s3key: <key>}`, `folder_to_upload_to: <folder id>`,
      `chunkSize: 33554432`. Then GOOGLEDRIVE_GET_FILE_METADATA and compare `md5Checksum` with `md5sum` of the local file.
   Composio calls time out after 60s on the client side, but the work keeps running: after a timeout on the image downloads or
   the Drive upload, check what finished (file sizes in the sandbox; GOOGLEDRIVE_FIND_FILE in the folder) before retrying, so
   nothing is duplicated. For big image sets, start the downloads and check progress in a separate call.
   Give the user the Drive link. Only if this fails, fall back to SendUserFile (30MB cap): re-encode with Remotion's bundled ffmpeg
   (`node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg`, run with `LD_LIBRARY_PATH` set to that folder;
   `-c:v libx264 -crf 23 -maxrate 4M -bufsize 8M -c:a copy`).

See README.md for the API and settings.
