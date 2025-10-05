# Gemini Quick-Start Guide

This guide provides quick references for developing the video server project. For a full project overview, see [README.md](./README.md).

## Core Technologies

- **Backend:** Node.js, Express.js (using ES Modules `.mjs`)
- **Frontend:** Vanilla JavaScript (ESM), HTML, CSS
- **Streaming:** HLS (HTTP Live Streaming) via `ffmpeg`
- **Dependencies:** `ffmpeg` and `ffprobe` must be in the system `PATH`.

## Key Commands

- `npm start`: Run the production server.
- `npm run dev`: Start the development server with `nodemon` for auto-reloading.
- `npm run sync`: Manually scan the video library and generate thumbnails.

## Important Files

- **Server Entry Point:** `server.mjs`
- **Backend Logic:**
    - `lib/hls.mjs`: HLS session management and transcoding.
    - `lib/scan.mjs`: Video file scanning.
    - `lib/ffmpeg.mjs`: Thumbnail generation.
    - `lib/db.mjs`: JSON database interaction.
- **Frontend Logic:**
    - `public/js/main.js`: Main application logic for the browser page.
    - `public/player.html` & `public/js/player.js`: The video player page.
- **Configuration:** `.env` (must be created from `.env.example`)
- **Video Index:** `data/thumbs-index.json`

## Common Workflow

1.  Ensure `.env` is configured, especially `VIDEO_ROOT`.
2.  Run `npm run dev` to start the development server.
3.  Modify files in `lib/` for backend changes or `public/` for frontend changes. `nodemon` will automatically restart the server.
4.  The main API endpoint for listing videos is `/api/list`. HLS sessions are initiated via `/api/session`.

## API Endpoints

| Method | Path                     | Description                                       | Key Parameters                 |
| :----- | :----------------------- | :------------------------------------------------ | :----------------------------- |
| GET    | `/api/list`              | Lists videos with search and pagination.          | `q`, `sort`, `offset`, `limit` |
| GET    | `/api/session`           | Initiates an HLS streaming session for a video.   | `id`, `preview`                |
| GET    | `/api/meta`              | Gets metadata for a single video.                 | `id` or `f` (legacy)           |
| GET    | `/hls/:token/:file`      | Serves HLS playlist (.m3u8) and segments (.ts).   | (Internal use)                 |
| GET    | `/hlskey/:token/key.bin` | Serves the AES encryption key for the HLS stream. | (Internal use)                 |
| GET    | `/thumbs/:hash.jpg`      | Serves a video thumbnail.                         | (Internal use)                 |
| GET    | `/v/:id`                 | Legacy non-HLS video streaming endpoint.          | (Fallback)                     |

## Debugging

- **General Logs:** Check the `log/` directory for daily log files managed by `winston`.
- **FFmpeg Errors:** The `ffmpeg.mjs` and `hls.mjs` modules log `ffmpeg`'s stderr output on failure. Look for these logs in the console output when running `npm run dev`.
- **Thumbnail Issues:** Set `THUMB_DEBUG=1` in your `.env` file to print the exact `ffmpeg` commands used for thumbnailing to the console.
- **HLS Failures:** The `hls.mjs` module first tries to `copy` codecs. If that fails, it falls back to a full `transcode`. Check the server logs for `[HLS] starting COPY job` or `[HLS] starting TRANSCODE job` to see which path is being taken.

## Core Data Structures

- **`data/thumbs-index.json`**: The main "database". It maps a video's relative file path to its metadata.

    ```json
    {
        "version": 1,
        "updatedAt": "...",
        "videoRoot": "...",
        "files": {
            "path/to/video1.mp4": {
                "hash": "...",
                "mtimeMs": 123456789,
                "size": 98765,
                "durationMs": 60000,
                "thumb": "hash.jpg"
            }
        }
    }
    ```

## Gotchas & Notes

- **`ffmpeg` is critical:** The application will fail at thumbnailing and streaming if `ffmpeg`/`ffprobe` are not correctly installed and in the system's `PATH` (or specified via `FFMPEG_PATH` in `.env`).
- **Sync Process:** The initial `npm run sync` can be very slow on large libraries. Subsequent runs are much faster as they only process new or changed files.
- **HLS Concurrency:** HLS generation is resource-intensive. `hls.mjs` limits concurrent `ffmpeg` jobs (default: `MAX_CONCURRENT = 2`). Additional streaming requests will be queued.
