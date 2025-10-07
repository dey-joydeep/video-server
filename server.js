// (keeps your routes; integrates HLS exactly once at startup)

import express from 'express';
import fs from 'fs';
import path from 'path';
import mime from 'mime';
import morgan from 'morgan';
import { spawn } from 'node:child_process';
import config from './lib/config.js';
import { init as initHls, setupHls } from './lib/hls.js';
import { createLogger } from './lib/logger.js';
import { SUPPORTED_VIDEO_EXTENSIONS, LOGGING } from './lib/constants.js';

const logger = createLogger({
    dirname: config.LOGS_DIR,
    filename: `${LOGGING.ROOT_LOG_FILENAME_PREFIX}%DATE%.log`,
});

initHls({ logger });

/** @constant {string} DB_PATH - The absolute path to the JSON database file. */
const DB_PATH = path.join(config.DATA_DIR, 'thumbs-index.json'); // produced by tools/sync.js
/** @constant {string} PUBLIC_DIR - The absolute path to the public static assets directory. */
const PUBLIC_DIR = path.join(process.cwd(), 'public');

/** @constant {Express} app - The Express application instance. */
const app = express();

// ---------- logging ----------
app.use(
    morgan('combined', {
        stream: { write: (message) => logger.info(message.trim()) },
    })
);

// ---------- basic hardening ----------
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

app.use((err, req, res) => {
    logger.error('EXPRESS ERROR:', err);
    res.status(500).json({ error: 'server error' });
});

// HTML (no-cache for shell pages)
/**
 * Serves an HTML file, optionally rewriting asset paths for production builds.
 * @param {object} res - The Express response object.
 * @param {string} fileName - The name of the HTML file to serve (e.g., 'index.html').
 */
function serveHtml(res, fileName) {
    const filePath = path.join(PUBLIC_DIR, fileName);
    res.setHeader('Cache-Control', 'no-store');

    if (config.isProduction) {
        try {
            let html = fs.readFileSync(filePath, 'utf8');
            // In prod, rewrite asset paths to point to minified versions in /dist
            html = html
                .replace('/styles.css', '/dist/styles.css')
                .replace('/js/main.js', '/dist/main.min.js')
                .replace('/js/player.js', '/dist/player.min.js');
            res.send(html);
        } catch (e) {
            logger.error(`Failed to serve modified HTML for ${fileName}`, e);
            res.status(500).send('Error processing HTML file.');
        }
    } else {
        res.sendFile(filePath, (err) => {
            if (err) {
                logger.error(`Failed to send file: ${filePath}`, err);
            }
        });
    }
}

app.get('/', (_req, res) => serveHtml(res, 'index.html'));
app.get('/watch', (_req, res) => serveHtml(res, 'player.html'));

// Static assets
if (config.isProduction) {
    // In prod, serve the pre-built minified assets from /dist
    app.use(
        '/dist',
        express.static(path.join(PUBLIC_DIR, 'dist'), {
            maxAge: '1y',
            immutable: true,
        })
    );
}
app.use(express.static(PUBLIC_DIR, { maxAge: '7d' }));
app.use(
    '/thumbs',
    express.static(config.THUMBS_DIR, { maxAge: '7d', immutable: true })
);

// ---------- helpers: DB + scan ----------
/**
 * Reads and parses a JSON file safely, returning a fallback value on error.
 * @param {string} p - The path to the JSON file.
 * @param {any} fallback - The value to return if the file cannot be read or parsed.
 * @returns {any} The parsed JSON data or the fallback value.
 */
function readJsonSafe(p, fallback) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return fallback;
    }
}

/**
 * Accept either:
 * A) { files: { "<rel>": { hash, thumb, durationMs, ... }, ... } }
 * B) { items: [ { id/hash, rel/path, name, durationMs, thumb, ... }, ... ] }
 */
/**
 * Loads the video index, handling different data shapes.
 * @returns {{byRel: object, byId: object}} An object containing video data indexed by relative path and by ID.
 */
function loadIndex() {
    const raw = readJsonSafe(DB_PATH, {});
    const byRel = {};
    const byId = {};

    if (raw && raw.files && typeof raw.files === 'object') {
        // Shape A
        for (const [rel, rec] of Object.entries(raw.files)) {
            const r = rec || {};
            byRel[rel] = r;
            if (r.hash) byId[r.hash] = rel;
            if (r.id && !byId[r.id]) byId[r.id] = rel;
        }
    } else if (raw && Array.isArray(raw.items)) {
        // Shape B
        for (const it of raw.items) {
            const rel = it.rel || it.relativePath || it.path || null;
            if (!rel) continue;
            const rec = {
                hash: it.id || it.hash || null,
                thumb: it.thumb || (it.id ? `${it.id}.jpg` : null),
                durationMs: it.durationMs ?? null,
                name: it.name || null,
            };
            byRel[rel] = rec;
            if (rec.hash) byId[rec.hash] = rel;
        }
    }
    return { byRel, byId };
}

/**
 * Removes the file extension from a filename.
 * @param {string} name - The filename.
 * @returns {string} The filename without its extension.
 */
function stripExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
}

/**
 * Lists all video files in the configured VIDEO_ROOT, enriching them with metadata from the index.
 * @returns {Array<object>} An array of video objects with their metadata.
 */
function listAllVideos() {
    const { byRel } = loadIndex();
    const out = [];

    const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                walk(full);
                continue;
            }
            const ext = path.extname(ent.name).toLowerCase();
            if (!SUPPORTED_VIDEO_EXTENSIONS.has(ext)) continue;

            const stat = fs.statSync(full);
            const rel = path
                .relative(config.VIDEO_ROOT, full)
                .replaceAll('\\', '/');
            const rec = byRel[rel] || {};
            out.push({
                id: rec.hash || null,
                name: stripExt(ent.name), // don’t expose extension
                rel, // internal (never sent to client)
                mtimeMs: stat.mtimeMs,
                durationMs: rec.durationMs ?? null,
                thumb: rec.thumb ?? (rec.hash ? `${rec.hash}.jpg` : null),
            });
        }
    };
    walk(config.VIDEO_ROOT);

    out.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
    );
    return out;
}

// ---------- ffprobe helper ----------
/**
 * Uses ffprobe to get the duration of a video file in milliseconds.
 * @param {string} filePath - The path to the video file.
 * @returns {Promise<number|null>} A promise that resolves with the duration in milliseconds, or null if it cannot be determined.
 */
function ffprobeDurationMs(filePath) {
    return new Promise((resolve) => {
        const p = spawn(
            process.env.FFPROBE_PATH || 'ffprobe',
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'default=nokey=1:noprint_wrappers=1',
                filePath,
            ],
            { windowsHide: true }
        );
        let out = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.on('close', () => {
            const s = parseFloat(out.trim());
            resolve(Number.isFinite(s) ? Math.floor(s * 1000) : null);
        });
        p.on('error', () => resolve(null));
    });
}

// ---------- APIs ----------
app.get('/api/list', (req, res) => {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const sort = (req.query.sort || 'name-asc').toString();
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    const limit = Math.max(
        Math.min(parseInt(req.query.limit || '21', 10), 200),
        1
    );

    let items = listAllVideos();
    if (q) items = items.filter((v) => v.name.toLowerCase().includes(q));

    const [key, dir] = sort.split('-');
    const mul = dir === 'asc' ? 1 : -1;
    items.sort((a, b) => {
        if (key === 'name')
            return (
                a.name.localeCompare(b.name, undefined, { numeric: true }) * mul
            );
        if (key === 'date') return (a.mtimeMs - b.mtimeMs) * mul;
        return 0;
    });

    const total = items.length;
    const page = items
        .slice(offset, offset + limit)
        .map(({ id, name, mtimeMs, durationMs }) => {
            const item = { id, name, mtimeMs, durationMs };
            if (id) {
                const assetDir = path.join(config.THUMBS_DIR, id);
                // Dynamically add thumb
                const thumbPath = path.join(
                    assetDir,
                    `${id}${process.env.SUFFIX_THUMB || '_thumb.jpg'}`
                );
                if (fs.existsSync(thumbPath)) {
                    item.thumb = `${id}/${id}${
                        process.env.SUFFIX_THUMB || '_thumb.jpg'
                    }`;
                }

                // Dynamically add preview clip
                const clipPath = path.join(
                    assetDir,
                    `${id}${process.env.SUFFIX_PREVIEW_CLIP || '_preview.mp4'}`
                );
                if (fs.existsSync(clipPath)) {
                    item.previewClip = `/thumbs/${id}/${id}${
                        process.env.SUFFIX_PREVIEW_CLIP || '_preview.mp4'
                    }`;
                }
            }
            return item;
        });
    res.json({ total, offset, limit, items: page });
});

// Legacy range streaming by id (non-HLS path; kept for fallback)
app.get('/v/:id', (req, res) => {
    const id = req.params.id;
    const { byId } = loadIndex();
    const rel = byId[id];
    const abs = path.resolve(path.join(config.VIDEO_ROOT, rel));
    if (!abs.startsWith(config.VIDEO_ROOT)) return res.sendStatus(403);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
        return res.sendStatus(404);

    const stat = fs.statSync(abs);
    const fileSize = stat.size;
    const contentType = mime.getType(abs) || 'application/octet-stream';
    const range = req.headers.range;

    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

    if (!range) {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
        });
        fs.createReadStream(abs).pipe(res);
        return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (!m) return res.status(416).end();
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
    if (start >= fileSize || end >= fileSize) return res.status(416).end();

    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
});

// Meta by id or legacy ?f=rel (compat for older UI)
app.get('/api/meta', async (req, res) => {
    const id = (req.query.id || '').toString();
    const f = (req.query.f || '').toString(); // legacy param
    const { byId, byRel } = loadIndex();
    let rel = null;
    let hash = null;

    if (id) {
        rel = byId[id];
        hash = id;
    }
    if (!rel && f && f !== 'undefined') {
        rel = f; // tolerate old clients
        const rec = byRel[f] || {};
        hash = rec.hash || null;
    }

    if (!rel) return res.status(400).json({ error: 'missing id' });

    const abs = path.resolve(path.join(config.VIDEO_ROOT, rel));
    if (!abs.startsWith(config.VIDEO_ROOT)) return res.sendStatus(403);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
        return res.sendStatus(404);

    const stat = fs.statSync(abs);
    let durationMs = null;
    try {
        durationMs = await ffprobeDurationMs(abs);
    } catch {
        /* Ignored */
    }

    const response = { id: hash, mtimeMs: stat.mtimeMs, durationMs };

    if (hash) {
        const vttPath = path.join(
            config.THUMBS_DIR,
            hash,
            `${hash}${process.env.SUFFIX_SPRITE_VTT || '_sprite.vtt'}`
        );
        if (fs.existsSync(vttPath)) {
            response.sprite = `/thumbs/${hash}/${hash}${
                process.env.SUFFIX_SPRITE_VTT || '_sprite.vtt'
            }`;
        }
    }

    res.json(response);
});

// Liveness
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ---------- deterministic startup: register HLS, then listen ----------
/**
 * Initializes and starts the Express server.
 * Sets up HLS streaming and listens for incoming requests.
 */
async function start() {
    // Resolve id -> rel using the *current filesystem view*
    /**
     * Resolves a video ID to its relative file path using the current filesystem view.
     * @param {string} id - The ID (hash) of the video.
     * @returns {string|null} The relative path of the video, or null if not found.
     */
    function getRelById(id) {
        if (!id) return null;
        const arr = listAllVideos();
        const it = arr.find((v) => v.id === id);
        return it?.rel || null;
    }

    try {
        await setupHls(app, {
            hlsDir: config.HLS_DIR,
            segSec: config.HLS_SEG_SEC,
            tokenTtlSec: config.TOKEN_TTL_SEC,
            pinIp: config.TOKEN_PIN_IP,
            ffmpegPath: config.FFMPEG_PATH,
            ffprobePath: config.FFPROBE_PATH,
            // allow forcing transcode for testing
            forceTranscode:
                String(process.env.HLS_FORCE_TRANSCODE || '0') === '1',
            resolveFile: async (id) => {
                const rel = getRelById(id);
                if (!rel) throw new Error('not found');
                const abs = path.resolve(config.VIDEO_ROOT, rel);
                if (!abs.startsWith(config.VIDEO_ROOT))
                    throw new Error('path escape');
                if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
                    throw new Error('missing file');
                return abs;
            },
        });
        logger.info(
            '🔐 HLS routes ready: /api/session, /hlskey/:token/key.bin, /hls/:token/:file'
        );
    } catch (e) {
        // Keep the app running even if HLS init fails; legacy /v/:id still works.
        logger.error('HLS init failed:', e);
    }

    app.listen(config.PORT, config.BIND, () => {
        logger.info(
            `📺 Serving ${config.VIDEO_ROOT} at http://${config.BIND}:${config.PORT}`
        );
    });
}

// surface async crashes instead of dying silently
process.on('unhandledRejection', (err) => {
    logger.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION:', err);
});

start().catch((err) => {
    logger.error('Fatal startup error:', err);
    process.exit(1);
});
