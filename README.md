# LAN Video Server (with thumbnails + incremental sync)

## Quick Start (Windows / PowerShell)
1) Install dependencies in your project folder:
   ```powershell
   npm install
   ```

2) Create a `.env` (copy from `.env.example`) and set:
   ```env
   VIDEO_ROOT=D:\Videos\P
   PORT=8200
   BIND=0.0.0.0
   DATA_DIR=./data
   THUMBS_DIR=./thumbs
   THUMB_WIDTH=320
   THUMB_AT_SECONDS=3
   AUTO_SYNC_ON_START=1
   ```

3) (Optional first-time) Run a full sync to generate the JSON DB and thumbnails:
   ```powershell
   npm run sync
   ```

4) Start the server:
   ```powershell
   npm start
   ```

5) On your phone (same Wi‑Fi), open: `http://<YOUR-LAN-IP>:8200/`

## What it does
- Serves a minimal UI from `/public`.
- Streams videos via `/video/<relative-path>` with HTTP Range support.
- Caches thumbnails in `./thumbs` and tracks files in `./data/thumbs-index.json`.
- `npm run sync` scans VIDEO_ROOT recursively, detects renames using content hashes,
  and only generates thumbnails for new/changed files.

## Notes
- Requires ffmpeg/ffprobe on PATH (or set FFMPEG_PATH/FFPROBE_PATH in `.env`).
- Accepts common video extensions: .mp4 .mkv .webm .mov .m4v .avi .wmv .flv
