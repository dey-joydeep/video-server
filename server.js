// (keeps your routes; integrates HLS exactly once at startup)

import express from 'express';
import fs from 'fs';
import path from 'path';
import morgan from 'morgan';
import config from './lib/config.js';
import { init as initHls, setupHls } from './lib/hls.js';
import { createLogger } from './lib/logger.js';
import { LOGGING } from './lib/constants.js';
import apiRoutes from './lib/routes/api.js';

import { listAllVideos } from './lib/video-utils.js';

const logger = createLogger({
    dirname: config.LOGS_DIR,
    filename: `${LOGGING.ROOT_LOG_FILENAME_PREFIX}%DATE%.log`,
});

initHls({ logger });

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

app.use((err, _req, res, _next) => {
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

// ---------- APIs ----------
app.use('/api', apiRoutes);

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
