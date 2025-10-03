// server.mjs — robust startup + HLS resolver via live scan (updated)
// (keeps your routes; integrates HLS exactly once at startup)

import express from 'express';
import fs from 'fs';
import path from 'path';
import mime from 'mime';
import dotenv from 'dotenv';
import morgan from 'morgan';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { setupHls } from './lib/hls.mjs'; // HLS module

dotenv.config();

const __filename = fileURLToPath(import.meta.url);

const app = express();

const CWD = process.cwd();
const ROOT = path.resolve(process.env.VIDEO_ROOT || CWD);
const PORT = parseInt(process.env.PORT || '8765', 10);
const BIND = process.env.BIND || '0.0.0.0';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(CWD, 'data'));
const DB_PATH = path.join(DATA_DIR, 'thumbs-index.json'); // produced by tools/sync.mjs
const PUBLIC_DIR = path.join(CWD, 'public');
const THUMBS_DIR = path.resolve(
    process.env.THUMBS_DIR || path.join(CWD, 'thumbs')
);

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi']);

// ---------- logging ----------
app.use(morgan('dev'));

// ---------- basic hardening ----------
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

app.use((err, req, res, next) => {
    console.error('EXPRESS ERROR:', err);
    res.status(500).json({ error: 'server error' });
});

// HTML (no-cache for shell pages)
app.get('/', (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), {
        headers: { 'Cache-Control': 'no-store' },
    })
);
app.get('/watch', (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'player.html'), {
        headers: { 'Cache-Control': 'no-store' },
    })
);

// Static assets

// Serve favicon with explicit cache headers
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'favicon.ico'), {
    headers: { 'Cache-Control': 'public, max-age=86400' }
  });
});


app.use(express.static(PUBLIC_DIR, { maxAge: '7d', immutable: true }));
app.use(
    '/thumbs',
    express.static(THUMBS_DIR, { maxAge: '7d', immutable: true })
);

// ---------- helpers: DB + scan ----------
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

function stripExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
}

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
            if (!VIDEO_EXTS.has(ext)) continue;

            const stat = fs.statSync(full);
            const rel = path.relative(ROOT, full).replaceAll('\\', '/');
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
    walk(ROOT);

    out.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
    );
    return out;
}

// ---------- ffprobe helper ----------
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
        .map(({ id, name, mtimeMs, durationMs, thumb }) => ({
            id,
            name,
            mtimeMs,
            durationMs,
            thumb,
        }));
    res.json({ total, offset, limit, items: page });
});

// Legacy range streaming by id (non-HLS path; kept for fallback)
app.get('/v/:id', (req, res) => {
    const id = req.params.id;
    const { byId } = loadIndex();
    const rel = byId[id];
    if (!rel) return res.sendStatus(404);

    const abs = path.resolve(path.join(ROOT, rel));
    if (!abs.startsWith(ROOT)) return res.sendStatus(403);
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
    const { byId } = loadIndex();
    let rel = null;

    if (id) rel = byId[id];
    if (!rel && f && f !== 'undefined') rel = f; // tolerate old clients

    if (!rel) return res.status(400).json({ error: 'missing id' });

    const abs = path.resolve(path.join(ROOT, rel));
    if (!abs.startsWith(ROOT)) return res.sendStatus(403);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
        return res.sendStatus(404);

    const stat = fs.statSync(abs);
    let durationMs = null;
    try {
        durationMs = await ffprobeDurationMs(abs);
    } catch {}
    res.json({ id: id || null, mtimeMs: stat.mtimeMs, durationMs });
});

// Liveness
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ---------- deterministic startup: register HLS, then listen ----------
async function start() {
    // Resolve id -> rel using the *current filesystem view*
    function getRelById(id) {
        if (!id) return null;
        const arr = listAllVideos();
        const it = arr.find((v) => v.id === id);
        return it?.rel || null;
    }

    try {
        await setupHls(app, {
            hlsDir: process.env.HLS_DIR || path.join(CWD, '.hls'),
            segSec: parseInt(process.env.HLS_SEG_SEC || '4', 10),
            tokenTtlSec: parseInt(process.env.TOKEN_TTL_SEC || '900', 10),
            pinIp: String(process.env.TOKEN_PIN_IP || 'true') === 'true',
            ffmpegPath: process.env.FFMPEG || 'ffmpeg',
            // pass through ffprobe (optional) via env if you need a custom path
            ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
            // allow forcing transcode for testing
            forceTranscode:
                String(process.env.HLS_FORCE_TRANSCODE || '0') === '1',
            resolveFile: async (id) => {
                const rel = getRelById(id);
                if (!rel) throw new Error('not found');
                const abs = path.resolve(ROOT, rel);
                if (!abs.startsWith(ROOT)) throw new Error('path escape');
                if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
                    throw new Error('missing file');
                return abs;
            },
        });
        console.log(
            '🔐 HLS routes ready: /api/session, /hlskey/:token/key.bin, /hls/:token/:file'
        );
    } catch (e) {
        // Keep the app running even if HLS init fails; legacy /v/:id still works.
        console.error('HLS init failed:', e?.message || e);
    }

    app.listen(PORT, BIND, () => {
        console.log(`📺 Serving ${ROOT} at http://${BIND}:${PORT}`);
    });
}

// surface async crashes instead of dying silently
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

start().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
