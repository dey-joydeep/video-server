# Repository Guidelines

## Project Structure & Module Organization

`server.js` boots Express, wires `/api` routes, and serves everything under `public/`. Backend helpers live in `lib/` (HLS, ffmpeg helpers, data/index utilities, logging, configuration). The browser UI sits in `public/` with shared modules in `public/js/` and UI fragments under `public/components/`. Pipeline scripts in `tools/` populate `data/thumbs-index.json`, per-video assets in `thumbs/<hash>/`, and HLS working files in `.hls/`; these folders are generated at runtime and usually stay out of source control.

## Build, Test, and Development Commands

- `npm run dev` – start Express with nodemon for hot reload.
- `npm start` – run the server once using the current `.env` settings.
- `npm run build` – emit minified JS and CSS into `public/dist/` (terser + cssnano).
- `npm run sync` – rescan `VIDEO_ROOT` and refresh `data/thumbs-index.json`.
- `npm run process` – run sync plus thumbnail, sprite, and preview-clip generators.

## Coding Style & Naming Conventions

Code is ESM-based JavaScript with two-space indentation and camelCase identifiers; reserve SCREAMING_SNAKE_CASE for shared constants (see `lib/constants.js`). Keep modules focused (for example, `player.js` handles playback wiring, `card.js` manages card hover/touch). Run `npm run lint` before pushing; the ESLint + Prettier setup already reflects project defaults for HTML, CSS, and JS.

## Testing Guidelines

There is no automated suite yet—exercise the grid (`/`) and player (`/watch`) flows manually while `npm run dev` is running. For HLS or ffmpeg changes, confirm `/api/session`, `/api/meta`, `.hls/`, and `thumbs/<hash>/` all update as expected with at least one local video. Record the manual checks you performed in commit or PR notes until automated coverage is added.

## Commit & Pull Request Guidelines

Author imperative, scope-limited commits (e.g., `Add scrubber sprite hover guard`). Reference any related issues, describe reproduction steps, and attach screenshots or short clips when changing UI or generated assets. Ensure lint/build commands succeed locally before opening a PR.

## Security & Configuration Tips

Copy `.env.example` to `.env` and set `VIDEO_ROOT`, network binding (`BIND`, `PORT`), and optional explicit `FFMPEG_PATH`/`FFPROBE_PATH` before running sync/process commands. `.hls/`, `thumbs/`, `data/`, and `logs/` can expose private filenames or media snippets—exclude them from commits and scrub artifacts before sharing logs externally.
