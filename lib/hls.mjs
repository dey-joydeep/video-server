// lib/hls.mjs — HLS sessions with AES-128; copy-first then transcode fallback
// UPDATED: probe codecs with ffprobe and only "copy" when browser-compatible;
// otherwise auto-transcode to H.264/AAC to fix audio-only playback.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from './config.mjs';
import { HLS } from './constants.mjs';
import { spawn } from 'node:child_process';

let logger = {
    info: () => {},
    warn: () => {},
    error: console.error,
    debug: () => {},
};

/**
 * Initializes the HLS module with a logger instance.
 * @param {object} options - Options for initialization.
 * @param {object} options.logger - The logger instance to use for logging.
 */
export function init({ logger: loggerInstance }) {
    if (loggerInstance) {
        logger = loggerInstance;
    }
}

// ---- HLS job registry / concurrency guard ----
/** @constant {Map<string, object>} HLS_JOBS - Registry of active HLS transcoding jobs. */
const HLS_JOBS = new Map(); // token -> { proc, startedAt, outDir }


/**
 * Returns the number of currently active HLS transcoding jobs.
 * @returns {number} The count of active jobs.
 */
function currentJobs() {
    let n = 0;
    for (const j of HLS_JOBS.values()) if (j.proc && !j.proc.killed) n++;
    return n;
}

/**
 * Registers an HLS transcoding job.
 * @param {string} token - The session token for the job.
 * @param {ChildProcess} proc - The child process running ffmpeg.
 * @param {string} outDir - The output directory for HLS segments.
 */
function registerJob(token, proc, outDir) {
    HLS_JOBS.set(token, { proc, startedAt: Date.now(), outDir });
    proc.on('close', (code) => {
        const j = HLS_JOBS.get(token);
        if (j) j.proc = null;
        logger.info(`[HLS] job for ${token} exited with code ${code}`);
    });
}

/**
 * Waits for a file to exist and have a size greater than 0.
 * @param {string} filePath - The path to the file to wait for.
 * @param {object} [options] - Options for waiting.
 * @param {number} [options.timeoutMs=15000] - Maximum time to wait in milliseconds.
 * @param {number} [options.intervalMs=200] - Interval between checks in milliseconds.
 * @returns {Promise<boolean>} A promise that resolves to true if the file is found, false otherwise.
 */
async function waitForFile(
    filePath,
    { timeoutMs = 15000, intervalMs = 200 } = {}
) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const st = fs.statSync(filePath);
            if (st.size > 0) return true;
        } catch {
            /* Ignored */
        }
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
    resolveFile: async () => {
        throw new Error('resolveFile(id) not provided');
    },
};

/**
 * Ensures that a directory exists, creating it if it doesn't.
 * @param {string} p - The path to the directory to ensure.
 */
function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}
/**
 * Generates a random hexadecimal token.
 * @returns {string} A 32-character hexadecimal string.
 */
function makeToken() {
    return crypto.randomBytes(16).toString('hex');
}
/**
 * Calculates a new expiration timestamp based on the current time and a time-to-live (TTL).
 * @param {number} ttl - The time-to-live in seconds.
 * @returns {number} The expiration timestamp in milliseconds since epoch.
 */
function freshExp(ttl) {
    return Date.now() + ttl * 1000;
}

/**
 * Extracts the client's IP address from an Express request object.
 * @param {object} req - The Express request object.
 * @returns {string} The client's IP address.
 */
function clientIp(req) {
    return (
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress ||
        ''
    );
}

/**
 * Checks if an HLS session is valid.
 * @param {object} req - The Express request object.
 * @param {object} s - The session object.
 * @param {boolean} pinIp - Whether the session should be bound to the client's IP address.
 * @returns {boolean} True if the session is valid, false otherwise.
 */
function sessionOk(req, s, pinIp) {
    if (!s) return false;
    if (Date.now() > s.exp) return false;
    if (pinIp && s.ip && s.ip !== clientIp(req)) return false;
    return true;
}

// ---- probe first stream codecs with ffprobe
/**
 * Probes the codec name of a specific stream (video or audio) in a media file using ffprobe.
 * @param {string} ffprobePath - The path to the ffprobe executable.
 * @param {string} input - The path to the input media file.
 * @param {string} which - Specifies which stream to probe (e.g., 'v:0' for first video, 'a:0' for first audio).
 * @returns {Promise<string|null>} A promise that resolves with the codec name (lowercase) or null if not found/error.
 */
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

/**
 * Probes the video and audio codec names of a media file using ffprobe.
 * @param {string} ffprobePath - The path to the ffprobe executable.
 * @param {string} input - The path to the input media file.
 * @returns {Promise<{vcodec: string|null, acodec: string|null}>} A promise that resolves with an object containing video and audio codec names.
 */
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
/**
 * Builds HLS streams for a given token, attempting direct copy if codecs are compatible, otherwise transcoding.
 * @param {object} options - Options for building the HLS stream.
 * @param {string} options.ffmpegPath - Path to the ffmpeg executable.
 * @param {string} options.ffprobePath - Path to the ffprobe executable.
 * @param {string} options.input - Path to the input video file.
 * @param {string} options.outDir - Output directory for HLS segments and playlists.
 * @param {number} options.segSec - Duration of each HLS segment in seconds.
 * @param {boolean} options.forceTranscode - If true, always transcode even if copy is possible.
 * @param {string} options.token - The session token.
 * @param {boolean} options.isPreview - If true, use preview-specific transcoding settings.
 * @throws {Error} If master playlist is not ready in time.
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
    const shouldCopy =
        !isPreview && !forceTranscode && canCopyVideo && canCopyAudio;

    const argsCopy = [
        '-hide_banner', // Hide FFmpeg's startup information
        '-nostdin', // Prevent FFmpeg from waiting for user input
        '-loglevel', // Set the logging level
        'info', // Show informational messages
        '-y', // Overwrite output files without asking
        '-i', // Specify the input file
        input, // The path to the video file
        '-map', // Select specific streams from the input
        '0:v:0', // Map the first video stream
        '-map', // Select specific streams from the input
        '0:a:0?', // Map the first audio stream if it exists
        '-c:v', // Set the video codec
        'copy', // Copy the video stream directly without re-encoding
        '-c:a', // Set the audio codec
        'copy', // Copy the audio stream directly without re-encoding
        '-f', // Force the output format
        'hls', // Output as HTTP Live Streaming (HLS)
        '-start_number', // Set the starting sequence number for HLS segments
        '0', // Start from segment 0
        '-hls_time', // Set the duration of each HLS segment
        String(segSec), // Segment duration in seconds
        '-hls_list_size', // Set the maximum number of segments in the playlist
        '0', // Keep all segments in the playlist (for VOD)
        '-hls_flags', // Special HLS flags
        'independent_segments+delete_segments', // Ensure segments are independent and delete old ones
        '-hls_segment_type', // Set the HLS segment type
        'mpegts', // Use MPEG Transport Stream segments
        '-hls_segment_filename', // Define the naming pattern for HLS segments
        path.join(outDir, 'seg_%05d.ts'), // Output segment files (e.g., seg_00000.ts)
        '-hls_key_info_file', // Specify the file containing AES encryption key info
        keyInfoPath, // Path to the key info file
        masterPath, // The main HLS playlist file (e.g., master.m3u8)
    ];

    const preset = isPreview
        ? HLS.TRANSCODE_PRESET.PREVIEW
        : HLS.TRANSCODE_PRESET.DEFAULT;
    const crf = isPreview
        ? HLS.TRANSCODE_CRF.PREVIEW
        : HLS.TRANSCODE_CRF.DEFAULT;

    const baseTranscode = [
        '-hide_banner', // Hide FFmpeg's startup information
        '-nostdin', // Prevent FFmpeg from waiting for user input
        '-loglevel', // Set the logging level
        'info', // Show informational messages
        '-y', // Overwrite output files without asking
        '-i', // Specify the input file
        input, // The path to the video file
        '-map', // Select specific streams from the input
        '0:v:0', // Map the first video stream
        '-map', // Select specific streams from the input
        '0:a:0?', // Map the first audio stream if it exists
        '-c:v', // Set the video codec
        'libx264', // Use the H.264 video encoder
        '-preset', // Set the encoding speed/compression ratio
        preset, // Preset (e.g., 'veryfast', 'superfast') for speed vs. quality
        '-crf', // Set the Constant Rate Factor for video quality
        crf, // CRF value (lower means higher quality, larger file size)
        '-profile:v', // Set the H.264 profile for compatibility
        'high', // High profile for broad compatibility
        '-level:v', // Set the H.264 level for compatibility
        '4.1', // Level 4.1 for broad compatibility
        '-pix_fmt', // Set the pixel format
        'yuv420p', // YUV 4:2:0 pixel format for broad compatibility
        '-g', // Set the Group of Pictures (GOP) size
        '48', // Keyframe interval (e.g., 48 frames for 2-second interval at 24fps)
        '-keyint_min', // Minimum keyframe interval
        '48', // Same as GOP size for consistent keyframes
        '-c:a', // Set the audio codec
        'aac', // Use AAC audio encoder
        '-b:a', // Set the audio bitrate
        '128k', // 128 kbps audio bitrate
        '-ac', // Set the number of audio channels
        '2', // Stereo audio
        '-movflags', // Special flags for the MP4 container
        '+faststart', // Move metadata to the beginning for faster web playback
        '-f', // Force the output format
        'hls', // Output as HTTP Live Streaming (HLS)
        '-hls_time', // Set the duration of each HLS segment
        String(segSec), // Segment duration in seconds
        '-hls_playlist_type', // Set the HLS playlist type
        'vod', // Video On Demand playlist (all segments listed)
        '-hls_segment_type', // Set the HLS segment type
        'mpegts', // Use MPEG Transport Stream segments
        '-hls_flags', // Special HLS flags
        'independent_segments+delete_segments', // Ensure segments are independent and delete old ones
        '-hls_segment_filename', // Define the naming pattern for HLS segments
        path.join(outDir, 'seg_%05d.ts'), // Output segment files (e.g., seg_00000.ts)
        '-hls_key_info_file', // Specify the file containing AES encryption key info
        keyInfoPath, // Path to the key info file
        masterPath, // The main HLS playlist file (e.g., master.m3u8)
    ];

    // Concurrency cap
    if (currentJobs() >= config.HLS_MAX_CONCURRENT_JOBS) {
        logger.warn('[HLS] concurrency cap reached, waiting for a free slot…');
        while (currentJobs() >= config.HLS_MAX_CONCURRENT_JOBS) {
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
        } catch {
            /* Ignored */
        }
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
            } catch {
                /* Ignored */
            }
            startTranscode(fixed);
            ready = await waitForFile(masterPath, {
                timeoutMs: 15000,
                intervalMs: 200,
            });
        }
    }

    if (!ready) throw new Error('master playlist not ready in time');
}

/**
 * Sets up HLS streaming routes and session management for an Express application.
 * @param {object} app - The Express application instance.
 * @param {object} [options] - Options for HLS setup.
 * @param {string} [options.hlsDir='.hls'] - Directory to store HLS segments.
 * @param {number} [options.segSec=4] - HLS segment length in seconds.
 * @param {number} [options.tokenTtlSec=900] - Time-to-live for HLS session tokens in seconds.
 * @param {boolean} [options.pinIp=true] - Whether to bind HLS sessions to the client's IP address.
 * @param {string} [options.ffmpegPath='ffmpeg'] - Path to the ffmpeg executable.
 * @param {string} [options.ffprobePath='ffprobe'] - Path to the ffprobe executable.
 * @param {boolean} [options.forceTranscode=false] - If true, always transcode even if copy is possible.
 * @param {function(string): Promise<string>} options.resolveFile - Function to resolve a video ID to its absolute file path.
 */
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
                } catch {
                    /* Ignored */
                }
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
