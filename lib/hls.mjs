// lib/hls.mjs — HLS sessions with AES-128; copy-first then transcode fallback
// UPDATED: probe codecs with ffprobe and only "copy" when browser-compatible;
// otherwise auto-transcode to H.264/AAC to fix audio-only playback.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'node:child_process';

import logger from './logger.mjs';

// ---- HLS job registry / concurrency guard ----
const HLS_JOBS = new Map(); // token -> { proc, startedAt, outDir }
const MAX_CONCURRENT = 2;

function currentJobs() {
    let n = 0;
    for (const j of HLS_JOBS.values()) if (j.proc && !j.proc.killed) n++;
    return n;
}


function registerJob(token, proc, outDir) {
    HLS_JOBS.set(token, { proc, startedAt: Date.now(), outDir });
    proc.on('close', (code) => {
        const j = HLS_JOBS.get(token);
        if (j) j.proc = null;
        logger.info(`[HLS] job for ${token} exited with code ${code}`);
    });
}

async function waitForFile(
    filePath,
    { timeoutMs = 15000, intervalMs = 200 } = {}
) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const st = fs.statSync(filePath);
            if (st.size > 0) return true;
        } catch {}
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

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
    token,
    isPreview,
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
    } catch (e) {
        logger.warn('[HLS] ffprobe failed', e);
    }

    const canCopyVideo = vcodec === 'h264'; // avc1 baseline/main/high
    const canCopyAudio =
        acodec === 'aac' || acodec === 'mp3' || acodec === 'mp2';
    const shouldCopy = !isPreview && !forceTranscode && canCopyVideo && canCopyAudio;

    const argsCopy = [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'info',
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

    const preset = isPreview ? 'superfast' : 'veryfast';
    const crf = isPreview ? '28' : '21';

    const baseTranscode = [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'info',
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
        preset,
        '-crf',
        crf,
        '-profile:v',
        'high',
        '-level:v',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '48',
        '-keyint_min',
        '48',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-f',
        'hls',
        '-hls_time',
        String(segSec),
        '-hls_playlist_type',
        'vod',
        '-hls_segment_type',
        'mpegts',
        '-hls_flags',
        'independent_segments+delete_segments',
        '-hls_segment_filename',
        path.join(outDir, 'seg_%05d.ts'),
        '-hls_key_info_file',
        keyInfoPath,
        masterPath,
    ];

    // Concurrency cap
    if (currentJobs() >= MAX_CONCURRENT) {
        logger.warn('[HLS] concurrency cap reached, waiting for a free slot…');
        while (currentJobs() >= MAX_CONCURRENT) {
            await new Promise((r) => setTimeout(r, 250));
        }
    }

    let proc = null;
    const runSpawn = (argv) =>
        spawn(ffmpegPath, argv, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
        });

    // Start ffmpeg (non-blocking); respond once master exists
    const startTranscode = (argv) => {
        logger.info('[HLS] starting TRANSCODE job:', argv.join(' '));
        proc = runSpawn(argv);
        registerJob(token, proc, outDir);
    };
    const startCopy = () => {
        logger.info('[HLS] starting COPY job:', argsCopy.join(' '));
        proc = runSpawn(argsCopy);
        registerJob(token, proc, outDir);
    };

    // launch
    if (shouldCopy) startCopy();
    else startTranscode(baseTranscode);

    // brief stderr progress (optional)
    proc.stderr.on('data', (b) => {
        logger.debug('[ffmpeg]', b.toString());
    });

    // Wait only for master.m3u8, not the full job
    let ready = await waitForFile(masterPath, {
        timeoutMs: 15000,
        intervalMs: 200,
    });

    // If COPY didn’t produce a master quickly, kill it and fall back to TRANSCODE
    if (!ready && shouldCopy) {
        try {
            proc.kill('SIGKILL');
        } catch {}
        startTranscode(baseTranscode);
        ready = await waitForFile(masterPath, {
            timeoutMs: 15000,
            intervalMs: 200,
        });
    }

    // If transcode failed early due to colorspace issue (-129 etc.), retry once with normalization
    if (!ready) {
        // try to detect an early-exit on stderr by peeking (best-effort)
        const needsColorspaceFix = false; // we can’t read proc stderr bufferfully here
        if (needsColorspaceFix) {
            const fixed = [...baseTranscode];
            const insertAt = fixed.indexOf('-c:v');
            const vfExpr = 'colorspace=iall=bt709:all=bt709:fast=1';
            if (insertAt >= 0) fixed.splice(insertAt, 0, '-vf', vfExpr);
            else fixed.push('-vf', vfExpr);
            try {
                proc.kill('SIGKILL');
            } catch {}
            startTranscode(fixed);
            ready = await waitForFile(masterPath, {
                timeoutMs: 15000,
                intervalMs: 200,
            });
        }
    }

    if (!ready) throw new Error('master playlist not ready in time');
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

            const isPreview = req.query.preview === 'true';

            // Kick off HLS; return when manifest exists (segments continue in background)
            await buildHlsForToken({
                ffmpegPath,
                ffprobePath,
                input,
                outDir: dir,
                segSec,
                forceTranscode,
                token,
                isPreview,
            });

            res.set('Cache-Control', 'no-store');
            res.json({ token, hlsUrl: `/hls/${token}/master.m3u8` });
        } catch (e) {
            logger.error('[/api/session] ERROR:', e);
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
