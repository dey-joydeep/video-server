// UPDATED: probe codecs with ffprobe and only "copy" when browser-compatible;
// otherwise auto-transcode to H.264/AAC to fix audio-only playback.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import config from './config.js';

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

function firstSegReady(dir) {
  try {
    const first = path.join(dir, 'seg_00000.ts');
    if (fs.existsSync(first)) {
      const st = fs.statSync(first);
      return st.isFile() && st.size > 0;
    }
    // Fallback: look for any first segment by name and ensure it is non-empty
    const files = safeReaddir(dir)
      .filter((f) => /seg_\d+\.ts$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
    if (!files.length) return false;
    const p = path.join(dir, files[0]);
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
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
  const hasFirst = firstSegReady(job.outDir);
  if (isDebug()) {
    logger.debug(
      `[HLS][status] token=${token} hasMaster=${hasMaster} segCount=${segs} firstSeg=${hasFirst}`
    );
  }
  if (hasMaster && segs >= config.MIN_READY_SEGMENTS && hasFirst) {
    const resp = { status: 'ready', hlsUrl: `/hls/${token}/master.m3u8` };
    if (isDebug())
      resp._debug = { hasMaster: true, segCount: segs, firstSeg: hasFirst };
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
    hlsDir = config.HLS_DIR,
    tokenTtlSec = config.TOKEN_TTL_SEC,
    pinIp = config.TOKEN_PIN_IP,
    resolveFile,
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
        sessions.delete(tok);
      }
    }
    // idle job cleanup by video id
    for (const [id, w] of WATCHERS_BY_ID) {
      if (
        (w.count || 0) === 0 &&
        now - (w.lastUsed || 0) > config.IDLE_JOB_TTL_MS
      ) {
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
        return res.status(404).json({ error: 'Video source file not found' });
      }

      const outDir = path.join(absHls, id);
      const masterPlaylistPath = path.join(outDir, 'master.m3u8');

      // Check if the pre-built HLS stream exists and is ready.
      if (fs.existsSync(masterPlaylistPath) && firstSegReady(outDir)) {
        const token = makeToken();
        const s = {
          id,
          ip: clientIp(req),
          exp: freshExp(tokenTtlSec),
          dir: outDir,
        };
        sessions.set(token, s);

        // Register a synthetic job so polling clients can get a ready status
        HLS_JOBS.set(token, { proc: null, startedAt: Date.now(), outDir, id });
        JOBS_BY_VIDEO.set(id, { token, outDir, startedAt: Date.now() });
        return res.json({
          token,
          hlsUrl: `/hls/${token}/master.m3u8`,
          status: 'ready',
        });
      } else {
        // If the HLS stream is not pre-built, return a 404.
        return res.status(404).json({
          error: 'Not Found',
          message: 'This video has not been processed for streaming yet.',
        });
      }
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
    // (removed unused buildVodSnapshot helper)

    const file = String(req.params.file || '').replace(/[^a-zA-Z0-9_.-]/g, '');
    const p = path.join(s.dir, file);
    if (!p.startsWith(s.dir)) return res.sendStatus(404);
    if (!fs.existsSync(p)) return res.sendStatus(404);

    if (file.endsWith('.m3u8')) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', 'inline');
      try {
        let text = fs.readFileSync(p, 'utf8');
        // Ensure the KEY URI points to the current session token to satisfy /hlskey route checks
        const before = text;
        text = text.replace(
          /\/hlskey\/[A-Za-z0-9_-]+\/key\.bin/g,
          `/hlskey/${req.params.token}/key.bin`
        );
        const rewritten = before !== text ? '1' : '0';
        res.set('X-HLS-Key-Rewritten', rewritten);
        return res.send(text);
      } catch {
        // Fallback to raw streaming if read/transform fails
        return fs.createReadStream(p).pipe(res);
      }
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
