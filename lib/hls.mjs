// lib/hls.mjs
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

const defaultOpts = {
    hlsDir: '.hls', // folder to write session playlists/segments
    segSec: 4, // HLS segment length (seconds)
    tokenTtlSec: 900, // token/session expires after N seconds of inactivity
    pinIp: true, // bind session to client IP
    ffmpegPath: 'ffmpeg', // override if needed
    // REQUIRED: resolveFile(id) -> absolute file path inside ROOT (throws if not found)
    resolveFile: async (_id) => {
        throw new Error('resolveFile(id) not provided');
    },
};

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

function clientIp(req) {
    return (
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress ||
        ''
    );
}

function makeToken() {
    return crypto.randomBytes(16).toString('hex');
}

function freshExp(ttl) {
    return Date.now() + ttl * 1000;
}

function sessionOk(req, s, pinIp) {
    if (!s) return false;
    if (Date.now() > s.exp) return false;
    if (pinIp && s.ip && s.ip !== clientIp(req)) return false;
    return true;
}

async function runFfmpeg(ffmpegPath, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegPath, args, {
            windowsHide: true,
            stdio: 'ignore',
        });
        p.on('exit', (code) =>
            code === 0
                ? resolve()
                : reject(Object.assign(new Error('ffmpeg failed'), { code }))
        );
        p.on('error', reject);
    });
}

/**
 * Build HLS (AES-128) once per token. Try "copy" (fast transmux) first; if it fails, re-encode (x264/AAC).
 */
async function buildHlsForToken({ ffmpegPath, input, outDir, segSec }) {
    ensureDir(outDir);
    const keyPath = path.join(outDir, 'key.bin');
    const keyInfoPath = path.join(outDir, 'keyinfo');
    const masterPath = path.join(outDir, 'master.m3u8');

    if (!fs.existsSync(keyPath))
        fs.writeFileSync(keyPath, crypto.randomBytes(16));
    const keyUrl = `/hlskey/${path.basename(outDir)}/key.bin`;
    fs.writeFileSync(keyInfoPath, `${keyUrl}\n${keyPath}\n`);

    // 1) fast transmux attempt
    const common = [
        '-y',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-hls_time',
        String(segSec),
        '-hls_playlist_type',
        'event',
        '-hls_flags',
        'independent_segments+delete_segments',
        '-hls_segment_filename',
        path.join(outDir, 'seg_%05d.ts'),
        '-hls_key_info_file',
        keyInfoPath,
        masterPath,
    ];

    try {
        await runFfmpeg(ffmpegPath, ['-c:v', 'copy', '-c:a', 'aac', ...common]);
        return;
    } catch (e) {
        // fall through to re-encode
    }

    // 2) robust fallback: re-encode to H.264/AAC (baseline & AAC LC for max compatibility)
    await runFfmpeg(ffmpegPath, [
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-b:a',
        '128k',
        ...common,
    ]);
}

export async function setupHls(
    app,
    {
        hlsDir = defaultOpts.hlsDir,
        segSec = defaultOpts.segSec,
        tokenTtlSec = defaultOpts.tokenTtlSec,
        pinIp = defaultOpts.pinIp,
        ffmpegPath = defaultOpts.ffmpegPath,
        resolveFile = defaultOpts.resolveFile,
    } = {}
) {
    const sessions = new Map(); // token -> { id, ip, exp, dir }

    const absHls = path.resolve(hlsDir);
    ensureDir(absHls);

    // periodic cleanup
    setInterval(() => {
        const now = Date.now();
        for (const [tok, s] of sessions) {
            if (now > s.exp) {
                try {
                    fs.rmSync(s.dir, { recursive: true, force: true });
                } catch {}
                sessions.delete(tok);
            }
        }
    }, 30_000);

    // API: issue session (token) and build HLS once
    app.get('/api/session', async (req, res) => {
        try {
            const id = String(req.query.id || '').trim();
            if (!id) return res.status(400).json({ error: 'missing id' });

            // Ask host app how to get the absolute input path
            const input = await resolveFile(id);
            if (!input || !fs.existsSync(input))
                return res.status(404).json({ error: 'not found' });

            const token = makeToken();
            const dir = path.join(absHls, token);
            const s = {
                id,
                ip: clientIp(req),
                exp: freshExp(tokenTtlSec),
                dir,
            };
            sessions.set(token, s);

            await buildHlsForToken({ ffmpegPath, input, outDir: dir, segSec });

            res.set('Cache-Control', 'no-store');
            res.json({ token, hlsUrl: `/hls/${token}/master.m3u8` });
        } catch (err) {
            res.status(500).json({
                error: 'session failed',
                reason: String(e?.message || e),
            }); // dev only
        }
    });

    // HLS key (per-session AES-128 key)
    app.get('/hlskey/:token/key.bin', (req, res) => {
        const s = sessions.get(req.params.token);
        if (!sessionOk(req, s, pinIp)) return res.sendStatus(403);
        s.exp = freshExp(tokenTtlSec);
        const keyPath = path.join(s.dir, 'key.bin');
        if (!keyPath.startsWith(s.dir) || !fs.existsSync(keyPath))
            return res.sendStatus(404);
        res.set({
            'Content-Type': 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
        });
        fs.createReadStream(keyPath).pipe(res);
    });

    // HLS playlist & segments
    app.get('/hls/:token/:file', (req, res) => {
        const s = sessions.get(req.params.token);
        if (!sessionOk(req, s, pinIp)) return res.sendStatus(403);
        s.exp = freshExp(tokenTtlSec);

        const file = String(req.params.file || '').replace(
            /[^a-zA-Z0-9_.-]/g,
            ''
        );
        const p = path.join(s.dir, file);
        if (!p.startsWith(s.dir) || !fs.existsSync(p))
            return res.sendStatus(404);

        if (file.endsWith('.m3u8')) {
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Cache-Control', 'no-store');
        } else if (file.endsWith('.ts')) {
            res.set('Content-Type', 'video/mp2t');
            res.set('Cache-Control', 'no-store');
            // Optional: discourage "Save as" on segments
            res.set('Accept-Ranges', 'none');
        }
        fs.createReadStream(p).pipe(res);
    });
}
