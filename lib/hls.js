// UPDATED: probe codecs with ffprobe and only "copy" when browser-compatible;
// otherwise auto-transcode to H.264/AAC to fix audio-only playback.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from './config.js';
import { HLS } from './constants.js';
import { spawn } from 'node:child_process';

let logger = {
  info: () => {},
  warn: () => {},
  error: console.error,
  debug: () => {},
};

function isDebug() {
  return !config.isProduction || config.DEBUG_HLS;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function countSegments(dir) {
  const files = safeReaddir(dir);
  return files.filter((f) => /seg_\d+\.ts$/i.test(f)).length;
}

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
const HLS_JOBS = new Map(); // token -> { proc, startedAt, outDir, id }
const JOBS_BY_VIDEO = new Map(); // id -> { token, outDir, startedAt }
const WATCHERS_BY_ID = new Map(); // id -> { count, lastUsed, outDir }

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
function registerJob(token, proc, outDir, id) {
  HLS_JOBS.set(token, { proc, startedAt: Date.now(), outDir, id });
  if (id) JOBS_BY_VIDEO.set(id, { token, outDir, startedAt: Date.now() });
  proc.on('close', (code) => {
    const j = HLS_JOBS.get(token);
    if (j) j.proc = null;
    logger.info(`[HLS] job for ${token} exited with code ${code}`);
  });
}

export function addWatcher(token) {
  const job = HLS_JOBS.get(token);
  if (!job || !job.id) return;
  const w = WATCHERS_BY_ID.get(job.id) || {
    count: 0,
    lastUsed: Date.now(),
    outDir: job.outDir,
  };
  w.count += 1;
  w.lastUsed = Date.now();
  w.outDir = job.outDir;
  WATCHERS_BY_ID.set(job.id, w);
}

export function removeWatcher(token) {
  const job = HLS_JOBS.get(token);
  if (!job || !job.id) return;
  const w = WATCHERS_BY_ID.get(job.id) || {
    count: 0,
    lastUsed: Date.now(),
    outDir: job.outDir,
  };
  w.count = Math.max(0, (w.count || 0) - 1);
  w.lastUsed = Date.now();
  w.outDir = job.outDir;
  WATCHERS_BY_ID.set(job.id, w);
}

/**
 * Gets the status of an HLS transcoding job.
 * @param {string} token - The session token for the job.
 * @returns {{status: string, hlsUrl?: string}} The status of the job.
 */
export function getHlsJobStatus(token) {
  const job = HLS_JOBS.get(token);
  if (!job) {
    return { status: 'not_found' };
  }

  const masterPlaylistPath = path.join(job.outDir, 'master.m3u8');
  const hasMaster = fs.existsSync(masterPlaylistPath);
  const segs = countSegments(job.outDir);
  if (isDebug()) {
    logger.debug(
      `[HLS][status] token=${token} hasMaster=${hasMaster} segCount=${segs}`
    );
  }
  if (hasMaster && segs >= config.MIN_READY_SEGMENTS) {
    const resp = { status: 'ready', hlsUrl: `/hls/${token}/master.m3u8` };
    if (isDebug()) resp._debug = { hasMaster: true, segCount: segs };
    return resp;
  }

  // Diagnostic: if another m3u8 exists, surface it to help the client
  try {
    const alt = fs
      .readdirSync(job.outDir)
      .find((f) => f.toLowerCase().endsWith('.m3u8'));
    if (alt && segs >= config.MIN_READY_SEGMENTS) {
      const resp = { status: 'ready', hlsUrl: `/hls/${token}/${alt}` };
      if (isDebug()) resp._debug = { hasMaster: false, alt, segCount: segs };
      return resp;
    }
  } catch {}

  // Attempt a minimal synthesized playlist if segments exist
  if (trySynthesizeMaster(job.outDir, token)) {
    if (isDebug())
      logger.info(
        `[HLS][status] SYNTH-M3U8 token=${token} segCount=${countSegments(job.outDir)}`
      );
    const resp = { status: 'ready', hlsUrl: `/hls/${token}/master.m3u8` };
    if (isDebug())
      resp._debug = { synthesized: true, segCount: countSegments(job.outDir) };
    return resp;
  }

  if (job.proc && !job.proc.killed) {
    const resp = { status: 'processing' };
    if (isDebug()) resp._debug = { hasMaster: false, segCount: segs };
    return resp;
  }

  const resp = { status: 'error' };
  if (isDebug()) resp._debug = { hasMaster: false, segCount: segs };
  return resp;
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
  id,
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
  const canCopyAudio = acodec === 'aac' || acodec === 'mp3' || acodec === 'mp2';
  const shouldCopyCandidate =
    !isPreview && !forceTranscode && canCopyVideo && canCopyAudio;
  const allowCopy = process.env.HLS_ALLOW_COPY === 'true';
  const shouldCopy = allowCopy && shouldCopyCandidate;

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
    'independent_segments+split_by_time', // Ensure segments are independent and force exact segment splits
    '-hls_playlist_type', // EVENT enables a growing, seekable playlist
    'event',
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
  const crf = isPreview ? HLS.TRANSCODE_CRF.PREVIEW : HLS.TRANSCODE_CRF.DEFAULT;

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
    '-hls_list_size', // Keep growing the playlist for immediate availability
    '0',
    '-hls_segment_type', // Set the HLS segment type
    'mpegts', // Use MPEG Transport Stream segments
    '-hls_flags', // Special HLS flags
    'independent_segments+split_by_time', // Ensure segments are independent and force exact segment splits
    '-hls_playlist_type', // EVENT enables DVR-like timeline while growing
    'event',
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
    registerJob(token, proc, outDir, id);
  };
  const startCopy = () => {
    logger.info('[HLS] starting COPY job:', argsCopy.join(' '));
    proc = runSpawn(argsCopy);
    registerJob(token, proc, outDir, id);
  };

  // launch
  if (shouldCopy) startCopy();
  else startTranscode(baseTranscode);

  // stderr progress (debug only, include token and content)
  proc.stderr.on('data', (b) => {
    if (!isDebug()) return;
    const text = b.toString();
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((line) => logger.debug(`[ffmpeg][${token}] ${line}`));
  });

  // Wait only for master.m3u8, not the full job
  logger.info(
    `[HLS] job ${token}: input=${input} outDir=${outDir} master=${masterPath} copy=${shouldCopy} segSec=${segSec} ffmpeg=${ffmpegPath} ffprobe=${ffprobePath} vcodec=${vcodec} acodec=${acodec}`
  );

  const ready = await waitForFile(masterPath, {
    timeoutMs: 60000,
    intervalMs: 200,
  });

  // If COPY didn't produce a master quickly, kill it and fall back to TRANSCODE
  if (!ready && shouldCopy) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* Ignored */
    }
    logger.warn(
      '[HLS] copy mode did not produce master.m3u8 in time; falling back to transcode'
    );
    startTranscode(baseTranscode);
  }

  // If still not ready after extended wait, log diagnostics
  if (!ready) {
    try {
      const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.ts'));
      logger.warn(
        `[HLS] master.m3u8 still missing after wait: token=${token} tsCount=${files.length}`
      );
    } catch (e) {
      logger.error('[HLS] diagnostic readdir failed', e);
    }
  }
}

function trySynthesizeMaster(outDir, token) {
  try {
    const masterPath = path.join(outDir, 'master.m3u8');
    if (fs.existsSync(masterPath)) return fs.existsSync(masterPath);
    const entries = fs
      .readdirSync(outDir)
      .filter((f) => /seg_\d+\.ts$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
    if (entries.length < 2) return false;
    const keyLine = fs.existsSync(path.join(outDir, 'key.bin'))
      ? `#EXT-X-KEY:METHOD=AES-128,URI="/hlskey/${token}/key.bin"\n`
      : '';
    const segSec = Number(process.env.HLS_SEG_SEC || '4');
    const target = Math.max(1, Math.ceil(segSec + 1));
    let body =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n' +
      `#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n` +
      keyLine;
    for (const f of entries) {
      body += `#EXTINF:${segSec.toFixed(3)},\n${f}\n`;
    }
    body += '#EXT-X-ENDLIST\n';
    fs.writeFileSync(masterPath, body);
    return true;
  } catch (e) {
    logger.warn('[HLS] synth master.m3u8 failed', e);
    return false;
  }
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
    // idle job cleanup by video id
    for (const [id, w] of WATCHERS_BY_ID) {
      if (
        (w.count || 0) === 0 &&
        now - (w.lastUsed || 0) > config.IDLE_JOB_TTL_MS
      ) {
        try {
          if (w.outDir && fs.existsSync(w.outDir))
            fs.rmSync(w.outDir, { recursive: true, force: true });
        } catch {}
        // remove HLS_JOBS entries that reference this outDir
        for (const [tok, j] of HLS_JOBS) {
          if (j && j.outDir === w.outDir) HLS_JOBS.delete(tok);
        }
        JOBS_BY_VIDEO.delete(id);
        WATCHERS_BY_ID.delete(id);
        if (isDebug())
          logger.info(`[HLS][idle-clean] removed job for id=${id}`);
      }
    }
  }, 30000);

  // API: issue session token and build HLS once (idempotent by video id)
  app.get('/api/session', async (req, res) => {
    try {
      const id = String(req.query.id || '').trim();
      if (!id) return res.status(400).json({ error: 'missing id' });

      const input = await resolveFile(id);
      if (!input || !fs.existsSync(input)) {
        return res.status(404).json({ error: 'not found' });
      }

      // Reuse existing job outDir for this id if present
      const reuse = JOBS_BY_VIDEO.get(id) || null;
      const token = makeToken();
      const dir = reuse?.outDir || path.join(absHls, token);
      ensureDir(dir);
      const s = {
        id,
        ip: clientIp(req),
        exp: freshExp(tokenTtlSec),
        dir,
      };
      sessions.set(token, s);

      const isPreview = req.query.preview === 'true';

      // If a job already exists for this id, mirror its proc for this token
      if (reuse && reuse.token) {
        const base = HLS_JOBS.get(reuse.token);
        if (base) {
          HLS_JOBS.set(token, {
            proc: base.proc,
            startedAt: base.startedAt,
            outDir: base.outDir,
            id,
          });
          JOBS_BY_VIDEO.set(id, {
            token: reuse.token,
            outDir: base.outDir,
            startedAt: base.startedAt,
          });
          const masterPlaylistPath = path.join(base.outDir, 'master.m3u8');
          if (fs.existsSync(masterPlaylistPath)) {
            return res.json({
              token,
              hlsUrl: `/hls/${token}/master.m3u8`,
              status: 'ready',
            });
          }
        }
      }

      // Kick off HLS; but don't wait for it to finish
      buildHlsForToken({
        ffmpegPath,
        ffprobePath,
        input,
        outDir: dir,
        segSec,
        forceTranscode,
        token,
        isPreview,
        id,
      }).catch((err) => {
        logger.error(
          `[HLS] background transcoding failed for token ${token}`,
          err
        );
      });

      res.set('Cache-Control', 'no-store');
      res.status(202).json({ token, status: 'processing' });
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
  app.get('/hls/:token/:file', async (req, res) => {
    const s = sessions.get(req.params.token);
    if (!sessionOk(req, s, pinIp)) return res.sendStatus(403);
    s.exp = freshExp(tokenTtlSec);
    function buildVodSnapshot(outDir, token) {
      try {
        const entries = fs
          .readdirSync(outDir)
          .filter((f) => /seg_\d+\.ts$/i.test(f))
          .sort((a, b) => a.localeCompare(b));
        if (entries.length < 2) return null;
        const keyLine = fs.existsSync(path.join(outDir, 'key.bin'))
          ? `#EXT-X-KEY:METHOD=AES-128,URI="/hlskey/${token}/key.bin"\n`
          : '';
        const segSec = Number(process.env.HLS_SEG_SEC || '4');
        const target = Math.max(1, Math.ceil(segSec + 1));
        let body =
          '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n' +
          `#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n` +
          keyLine;
        for (const f of entries)
          body += `#EXTINF:${segSec.toFixed(3)},\n${f}\n`;
        body += '#EXT-X-ENDLIST\n';
        return body;
      } catch {
        return null;
      }
    }

    const file = String(req.params.file || '').replace(/[^a-zA-Z0-9_.-]/g, '');
    const p = path.join(s.dir, file);
    if (!p.startsWith(s.dir)) return res.sendStatus(404);
    // If requesting master.m3u8 and it's missing but segments exist, synthesize lazily
    const isMaster = file.toLowerCase() === 'master.m3u8';
    let vodSnapshot = null;
    if (isMaster) {
      // Always return a VOD snapshot (ENDLIST) to the client for master.m3u8
      let attempts = 0;
      const maxAttempts = 10; // ~2s total at 200ms steps
      while (attempts < maxAttempts) {
        vodSnapshot = buildVodSnapshot(s.dir, req.params.token);
        if (vodSnapshot) break;
        await new Promise((r) => setTimeout(r, 200));
        attempts += 1;
      }
      if (!vodSnapshot) {
        res.set('Retry-After', '1');
        return res.sendStatus(503);
      }
    }
    if (!fs.existsSync(p) && !vodSnapshot) return res.sendStatus(404);

    if (file.endsWith('.m3u8')) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', 'inline');
      if (isDebug()) {
        try {
          const content = vodSnapshot ?? fs.readFileSync(p, 'utf8');
          const hasEnd = /#EXT-X-ENDLIST/i.test(content);
          const segs = (content.match(/#EXTINF:/g) || []).length;
          res.set(
            'X-HLS-Playlist',
            vodSnapshot
              ? 'snapshot'
              : fs.existsSync(path.join(s.dir, 'master.m3u8'))
                ? 'disk'
                : 'synth'
          );
          res.set('X-HLS-SegCount', String(segs));
          res.set('X-HLS-Endlist', String(hasEnd));
        } catch {}
      }
      if (vodSnapshot) {
        return res.send(vodSnapshot);
      }
      return fs.createReadStream(p).pipe(res);
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
