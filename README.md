# LAN Video Server

A simple, self-hosted video server for your local network. It scans your video library, generates thumbnails, and provides a clean web interface for browsing and streaming.

## Features

- **Web-based UI:** Modern, responsive interface for browsing videos in a grid or list view.
- **On-the-fly HLS Streaming:** Videos are converted to HTTP Live Streaming (HLS) format for efficient, adaptive streaming. This is more robust than simple file streaming.
- **Secure Sessions:** HLS streams are protected with temporary tokens and AES-128 encryption, preventing direct file access.
- **Thumbnail Generation:** Automatically creates thumbnails for your videos using `ffmpeg`.
- **Incremental Sync:** Scans your video directory and updates the index without reprocessing existing files.
- **Search and Sort:** Instantly search your library by filename and sort by name or date.
- **Hover Previews:** Get a quick glimpse of a video by hovering over its thumbnail.
- **Configuration via `.env`:** Easy setup using an environment file.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [ffmpeg](https://ffmpeg.org/download.html) and `ffprobe` must be installed and available in your system's `PATH`.

### Installation & Configuration

1.  **Clone the repository:**

    ```bash
    git clone <repository-url>
    cd video-server
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Create your configuration:**
    Copy the example `.env.example` to a new file named `.env`.

    ```bash
    cp .env.example .env
    ```

    Now, edit `.env` and set `VIDEO_ROOT` to the absolute path of your video library. Adjust other settings as needed.

    ```dotenv
    # REQUIRED: where your videos live (recurse all subfolders)
    VIDEO_ROOT=D:\Videos

    # Server bind + port
    PORT=8200
    ```

## Usage

### Key Commands

- `npm start`: Run the production server.
- `npm run dev`: Start the development server with `nodemon` for auto-reloading.
- `npm run sync`: Manually scan the video library and generate thumbnails.

### Running the Server

- **For development (with auto-reload):**

  ```bash
  npm run dev
  ```

- **For production:**
  ```bash
  npm start
  ```

The server will be accessible at `http://localhost:8200` (or the port you configured).

### Syncing Videos

The server can automatically scan for new videos on startup if `AUTO_SYNC_ON_START=1` is in your `.env` file.

To run a manual sync at any time, use:

```bash
npm run sync
```

This will scan the `VIDEO_ROOT` directory, add new videos to the index, and generate any missing thumbnails.

## API Endpoints

| Method | Path                     | Description                                       | Key Parameters                 |
| :----- | :----------------------- | :------------------------------------------------ | :----------------------------- |
| GET    | `/api/list`              | Lists videos with search and pagination.          | `q`, `sort`, `offset`, `limit` |
| GET    | `/api/session`           | Initiates an HLS streaming session for a video.   | `id`, `preview`                |
| GET    | `/api/meta`              | Gets metadata for a single video.                 | `id` or `f` (legacy)           |
| GET    | `/hls/:token/:file`      | Serves HLS playlist (.m3u8) and segments (.ts).   | (Internal use)                 |
| GET    | `/hlskey/:token/key.bin` | Serves the AES encryption key for the HLS stream. | (Internal use)                 |
| GET    | `/thumbs/:hash.jpg`      | Serves a video thumbnail.                         | (Internal use)                 |

## Debugging

- **General Logs:** Check the `log/` directory for daily log files managed by `winston`.
- **FFmpeg Errors:** The `ffmpeg.js` and `hls.js` modules log `ffmpeg`'s stderr output on failure. Look for these logs in the console output when running `npm run dev`.
- **Thumbnail Issues:** Set `THUMB_DEBUG=1` in your `.env` file to print the exact `ffmpeg` commands used for thumbnailing to the console.
- **HLS Failures:** The `hls.js` module first tries to `copy` codecs. If that fails, it falls back to a full `transcode`. Check the server logs for `[HLS] starting COPY job` or `[HLS] starting TRANSCODE job` to see which path is being taken.

## Configuration

All configuration is done via the `.env` file.

| Variable             | Description                                                                   | Default         |
| :------------------- | :---------------------------------------------------------------------------- | :-------------- |
| `VIDEO_ROOT`         | **Required.** The absolute path to your video files directory.                | -               |
| `BIND`               | The IP address to bind the server to. `0.0.0.0` for all interfaces.           | `0.0.0.0`       |
| `PORT`               | The port for the web server.                                                  | `8200`          |
| `DATA_DIR`           | Directory to store the JSON index.                                            | `./data`        |
| `THUMBS_DIR`         | Directory to store generated thumbnails.                                      | `./thumbs`      |
| `THUMB_WIDTH`        | The width of generated thumbnails in pixels.                                  | `320`           |
| `THUMB_AT_SECONDS`   | The timestamp (in seconds) to try and grab the thumbnail from.                | `3`             |
| `THUMB_DEBUG`        | Print `ffmpeg` thumbnail commands to the console (`1` for yes, `0` for no).   | `0`             |
| `AUTO_SYNC_ON_START` | Run the sync process automatically on server start (`1` for yes, `0` for no). | `1`             |
| `FFMPEG_PATH`        | Optional explicit path to the `ffmpeg` executable.                            | `ffmpeg`        |
| `FFPROBE_PATH`       | Optional explicit path to the `ffprobe` executable.                           | `ffprobe`       |
| `HLS_DIR`            | Directory to store temporary HLS session files.                               | `.hls`          |
| `HLS_SEG_SEC`        | The length of each HLS video segment in seconds.                              | `4`             |
| `TOKEN_TTL_SEC`      | Time-to-live for HLS session tokens in seconds.                               | `900` (15 mins) |
| `TOKEN_PIN_IP`       | Bind HLS sessions to the client's IP address (`true` or `false`).             | `true`          |

## Architecture

The application consists of two main parts:

1.  **Node.js/Express Backend:**
    - Serves the static frontend application.
    - Provides a REST API for listing videos and managing streaming sessions.
    - Handles video processing (thumbnailing and HLS transcoding) using `ffmpeg`.
    - Maintains a JSON-based database (`data/thumbs-index.json`) of video metadata.
2.  **Vanilla JS Frontend:**
    - A single-page application for browsing and playing videos.
    - Uses `hls.js` to play the HLS streams provided by the backend.
    - Stores user preferences in the browser's Local Storage.

```
+----------------------+        +-------------------------+
|      Web Browser     |        |      Video Files        |
| (HTML, CSS, JS)      |        | (e.g., /mnt/videos)     |
+----------------------+        +-------------------------+
          ^                             ^
          | HTTP/S                      | Filesystem Read
          v                             v
+---------------------------------------------------------+
|                  Node.js Server                         |
| +----------------------+  +---------------------------+ |
| |   Express.js API     |  |     FFmpeg Processor      | |
| | (/api/list, /api/session)|  | (Thumbnails, HLS Segments)| |
| +----------------------+  +---------------------------+ |
| |   Static File Server |  |      File Scanner         | |
| |   (public/*)         |  |      (walks VIDEO_ROOT)   | |
| +----------------------+  +---------------------------+ |
+---------------------------------------------------------+
```

## Project Structure

- **`server.js`**: The main server entry point.
- **`lib/`**: Core backend modules.
  - `hls.js`: HLS session management and transcoding.
  - `scan.js`: Video file scanning.
  - `ffmpeg.js`: Thumbnail generation.
  - `db.js`: JSON database interaction.
  - `config.js`: Application configuration loader.
  - `logger.js`: Logging setup.
- **`public/`**: Frontend static files.
  - `js/main.js`: Main application logic for the browser page.
  - `player.html` & `js/player.js`: The video player page.
- **`data/`**: Data files.
  - `thumbs-index.json`: The main "database" mapping video paths to metadata.
- **`tools/`**: Command-line scripts.
  - `sync.js`: Manual sync script.
- **`.env`**: Local configuration file (must be created from `.env.example`).

## Core Data Structures

The main "database" is `data/thumbs-index.json`. It maps a video's relative file path to its metadata.

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

## Important Notes

- **`ffmpeg` is critical:** The application will fail at thumbnailing and streaming if `ffmpeg`/`ffprobe` are not correctly installed and in the system's `PATH` (or specified via `FFMPEG_PATH` in `.env`).
- **Sync Process:** The initial `npm run sync` can be very slow on large libraries. Subsequent runs are much faster as they only process new or changed files.
- **HLS Concurrency:** HLS generation is resource-intensive. `hls.js` limits concurrent `ffmpeg` jobs. Additional streaming requests will be queued.
