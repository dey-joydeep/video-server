// lib/hls.mjs — HLS sessions with AES-128; copy-first then transcode fallback
// UPDATED: probe codecs with ffprobe and only "copy" when browser-compatible;
// otherwise auto-transcode to H.264/AAC to fix audio-only playback.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'node:child_process';

const defaultOpts = {
    hlsDir: '.hls', // where to write session playlists/segments
    segSec: 4, // HLS segment length (seconds)
    tokenTtlSec: 900, // token/session TTL
    pinIp: true, // bind session to client IP
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    forceTranscode: false, // override to always re-encode
    // REQUIRED: resolveFile(id) -> absolute file path
    resolveFile: async (_id) => {
        throw new Error('resolveFile(id) not provided');
    },
};

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}
function makeToken() {
    return crypto.randomBytes(16).toString('hex');
}
function freshExp(ttl) {
    return Date.now() + ttl * 1000;
}

function clientIp(req) {
    return (
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress ||
        ''
    );
}

function sessionOk(req, s, pinIp) {
    if (!s) return false;
    if (Date.now() > s.exp) return false;
    if (pinIp && s.ip && s.ip !== clientIp(req)) return false;
    return true;
}

function runFfmpeg(ffmpegPath, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, {
            cwd,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('close', (code) => {
            if (code === 0) return resolve({ code, stderr });
            const err = new Error(`ffmpeg failed (${code})`);
            err.code = code;
            err.stderr = stderr;
            err.args = args;
            reject(err);
        });
        child.on('error', (e) => {
            const err = new Error(`ffmpeg spawn error: ${e.message || e}`);
            err.spawn = e;
            err.args = args;
            reject(err);
        });
    });
}

// ---- probe first stream codecs with ffprobe
async function ffprobeCodec(ffprobePath, input, which) {
    return new Promise((resolve) => {
        const args = [
            '-v',
            'error',
            '-select_streams',
            which, // 'v:0' or 'a:0'
            '-show_entries',
            'stream=codec_name',
            '-of',
            'csv=p=0',
            input,
        ];
        const p = spawn(ffprobePath, args, { windowsHide: true });
        let out = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.on('close', () => resolve((out.trim() || '').toLowerCase() || null));
        p.on('error', () => resolve(null));
    });
}

async function ffprobeStreams(ffprobePath, input) {
    const [vcodec, acodec] = await Promise.all([
        ffprobeCodec(ffprobePath, input, 'v:0'),
        ffprobeCodec(ffprobePath, input, 'a:0'),
    ]);
    return { vcodec, acodec };
}

/**
 * Build HLS once per token.
 *  - Try COPY (when vcodec/acodec are browser-friendly), else TRANSCODE to H.264/AAC fMP4.
 */
async function buildHlsForToken({
    ffmpegPath,
    ffprobePath,
    input,
    outDir,
    segSec,
    forceTranscode,
}) {
    ensureDir(outDir);
    const keyPath = path.join(outDir, 'key.bin');
    const keyInfoPath = path.join(outDir, 'keyinfo');
    const masterPath = path.join(outDir, 'master.m3u8');

    // per-session AES key
    if (!fs.existsSync(keyPath))
        fs.writeFileSync(keyPath, crypto.randomBytes(16));
    const keyUrl = `/hlskey/${path.basename(outDir)}/key.bin`;
    fs.writeFileSync(keyInfoPath, `${keyUrl}\n${keyPath}\n`);

    // probe codecs → decide whether copy is safe
    let vcodec = null,
        acodec = null;
    try {
        const pp = await ffprobeStreams(ffprobePath, input);
        vcodec = pp.vcodec;
        acodec = pp.acodec;
    } catch {}

    const canCopyVideo = vcodec === 'h264' || vcodec === 'mpeg4'; // avc1 or mpeg4 ASP
    const canCopyAudio =
        acodec === 'aac' || acodec === 'mp3' || acodec === 'mp2';
    const shouldCopy = !forceTranscode && canCopyVideo && canCopyAudio;

    // COPY → MPEG-TS segments
    const argsCopy = [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'copy',
        '-c:a',
        'copy',
        '-f',
        'hls',
        '-start_number',
        '0',
        '-hls_time',
        String(segSec),
        '-hls_list_size',
        '0',
        '-hls_flags',
        'independent_segments+delete_segments',
        '-hls_segment_type',
        'mpegts',
        '-hls_segment_filename',
        path.join(outDir, 'seg_%05d.ts'),
        '-hls_key_info_file',
        keyInfoPath,
        masterPath,
    ];

    // TRANSCODE → fMP4 segments (robust)
    const argsTranscode = [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '21',
        '-profile:v',
        'high',
        '-level:v',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-f',
        'hls',
        '-hls_time',
        String(segSec),
        '-hls_playlist_type',
        'vod',
        '-hls_segment_type',
        'fmp4',
        '-hls_flags',
        'independent_segments+delete_segments',
        '-hls_fmp4_init_filename',
        'init.mp4',
        '-hls_segment_filename',
        path.join(outDir, 'seg_%05d.m4s'),
        '-hls_key_info_file',
        keyInfoPath,
        masterPath,
    ];

    try {
        if (shouldCopy) {
            try {
                await runFfmpeg(ffmpegPath, argsCopy, outDir);
            } catch (e1) {
                // fallback to transcode on any copy failure
                await runFfmpeg(ffmpegPath, argsTranscode, outDir);
            }
        } else {
            await runFfmpeg(ffmpegPath, argsTranscode, outDir);
        }
    } catch (e) {
        const err = new Error('ffmpeg failed');
        err.reason = e?.stderr || e?.message || String(e);
        throw err;
    }

    if (!fs.existsSync(masterPath)) {
        throw new Error('HLS master playlist missing after ffmpeg');
    }
}

export async function setupHls(
    app,
    {
        hlsDir = defaultOpts.hlsDir,
        segSec = defaultOpts.segSec,
        tokenTtlSec = defaultOpts.tokenTtlSec,
        pinIp = defaultOpts.pinIp,
        ffmpegPath = defaultOpts.ffmpegPath,
        ffprobePath = defaultOpts.ffprobePath,
        forceTranscode = defaultOpts.forceTranscode,
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

    // API: issue session token and build HLS once
    app.get('/api/session', async (req, res) => {
        try {
            const id = String(req.query.id || '').trim();
            if (!id) return res.status(400).json({ error: 'missing id' });

            const input = await resolveFile(id);
            if (!input || !fs.existsSync(input)) {
                return res.status(404).json({ error: 'not found' });
            }

            const token = makeToken();
            const dir = path.join(absHls, token);
            const s = {
                id,
                ip: clientIp(req),
                exp: freshExp(tokenTtlSec),
                dir,
            };
            sessions.set(token, s);

            await buildHlsForToken({
                ffmpegPath,
                ffprobePath,
                input,
                outDir: dir,
                segSec,
                forceTranscode,
            });

            res.set('Cache-Control', 'no-store');
            res.json({ token, hlsUrl: `/hls/${token}/master.m3u8` });
        } catch (e) {
            res.status(500).json({
                error: 'session failed',
                reason: e?.reason || e?.stderr || e?.message || String(e),
            });
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
            'Accept-Ranges': 'none',
            'Content-Disposition': 'inline',
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
            res.set('Content-Disposition', 'inline');
        } else if (file.endsWith('.ts')) {
            res.set('Content-Type', 'video/mp2t');
            res.set('Cache-Control', 'no-store');
            res.set('Accept-Ranges', 'none');
            res.set('Content-Disposition', 'inline');
        } else if (file.endsWith('.m4s') || file.endsWith('.mp4')) {
            res.set('Content-Type', 'video/mp4');
            res.set('Cache-Control', 'no-store');
            res.set('Accept-Ranges', 'none');
            res.set('Content-Disposition', 'inline');
        }
        fs.createReadStream(p).pipe(res);
    });
}
