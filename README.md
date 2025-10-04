# LAN Video Server

A simple, self-hosted video server for your local network. It scans your video library, generates thumbnails, and provides a clean web interface for browsing and streaming.

## Features

-   **Web-based UI:** Modern, responsive interface for browsing videos in a grid or list view.
-   **On-the-fly HLS Streaming:** Videos are converted to HTTP Live Streaming (HLS) format for efficient, adaptive streaming. This is more robust than simple file streaming.
-   **Secure Sessions:** HLS streams are protected with temporary tokens and AES-128 encryption, preventing direct file access.
-   **Thumbnail Generation:** Automatically creates thumbnails for your videos using `ffmpeg`.
-   **Incremental Sync:** Scans your video directory and updates the index without reprocessing existing files.
-   **Search and Sort:** Instantly search your library by filename and sort by name or date.
-   **Hover Previews:** Get a quick glimpse of a video by hovering over its thumbnail.
-   **Configuration via `.env`:** Easy setup using an environment file.

## Architecture

The application consists of two main parts:

1.  **Node.js/Express Backend:**
    -   Serves the static frontend application.
    -   Provides a REST API for listing videos and managing streaming sessions.
    -   Handles video processing (thumbnailing and HLS transcoding) using `ffmpeg`.
    -   Maintains a JSON-based database (`data/thumbs-index.json`) of video metadata.
2.  **Vanilla JS Frontend:**
    -   A single-page application for browsing and playing videos.
    -   Uses `hls.js` to play the HLS streams provided by the backend.
    -   Stores user preferences in the browser's Local Storage.

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

```
.
├── .env                # Local configuration (create this file)
├── .env.example        # Example configuration
├── data/
│   └── thumbs-index.json # Video metadata index
├── lib/                # Core backend modules
│   ├── db.mjs          # Database (JSON file) helpers
│   ├── ffmpeg.mjs      # ffmpeg wrapper for thumbnails
│   ├── hls.mjs         # HLS session and transcoding logic
│   └── scan.mjs        # Video file scanner
├── public/             # Frontend static files (HTML, CSS, JS)
├── thumbs/             # Generated thumbnail images
├── tools/
│   └── sync.mjs        # Manual sync script
└── server.mjs          # Main server entry point
```

## Getting Started

### Prerequisites

-   [Node.js](https://nodejs.org/) (v18 or higher recommended)
-   [ffmpeg](https://ffmpeg.org/download.html) and `ffprobe` must be installed and available in your system's `PATH`.

### Installation

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

### Running the Server

-   **For development (with auto-reload):**
    ```bash
    npm run dev
    ```

-   **For production:**
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

## Configuration

All configuration is done via the `.env` file.

| Variable             | Description                                                              | Default         |
| -------------------- | ------------------------------------------------------------------------ | --------------- |
| `VIDEO_ROOT`         | **Required.** The absolute path to your video files directory.           | -               |
| `BIND`               | The IP address to bind the server to. `0.0.0.0` for all interfaces.      | `0.0.0.0`       |
| `PORT`               | The port for the web server.                                             | `8200`          |
| `DATA_DIR`           | Directory to store the JSON index.                                       | `./data`        |
| `THUMBS_DIR`         | Directory to store generated thumbnails.                                 | `./thumbs`      |
| `THUMB_WIDTH`        | The width of generated thumbnails in pixels.                             | `320`           |
| `THUMB_AT_SECONDS`   | The timestamp (in seconds) to try and grab the thumbnail from.           | `3`             |
| `AUTO_SYNC_ON_START` | Run the sync process automatically on server start (`1` for yes, `0` for no). | `1`             |
| `FFMPEG_PATH`        | Optional explicit path to the `ffmpeg` executable.                       | `ffmpeg`        |
| `FFPROBE_PATH`       | Optional explicit path to the `ffprobe` executable.                      | `ffprobe`       |
| `HLS_DIR`            | Directory to store temporary HLS session files.                          | `.hls`          |
| `HLS_SEG_SEC`        | The length of each HLS video segment in seconds.                         | `4`             |
| `TOKEN_TTL_SEC`      | Time-to-live for HLS session tokens in seconds.                          | `900` (15 mins) |
| `TOKEN_PIN_IP`       | Bind HLS sessions to the client's IP address (`true` or `false`).        | `true`          |