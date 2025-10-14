import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { loadIndex } from '../../lib/db.js';
import config from '../../lib/config.js';
import { createLogger } from '../../lib/logger.js';
import { LOGGING } from '../../lib/constants.js';

const logger = createLogger({
  dirname: config.TOOLS_LOG_DIR,
  filename: `${LOGGING.TOOL_LOG_FILENAME_PREFIXES.SYNC || 'sync_'}generate_hls-%DATE%.log`,
});

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))));
    p.on('error', (e) => reject(e));
  });
}

function existsNonEmpty(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export async function generateHlsVod() {
  logger.info('[HLS-PRE] Starting VOD HLS prebuild...');
  const { byRel } = loadIndex();
  const entries = Object.entries(byRel);
  if (!entries.length) {
    logger.warn('[HLS-PRE] No videos found. Run sync first.');
    return;
  }

  const segSec = config.HLS_SEG_SEC || 4;

  for (const [i, [rel, rec]] of entries.entries()) {
    const hash = rec?.hash;
    if (!hash) {
      logger.warn(`[HLS-PRE] Skipping (no hash): ${rel}`);
      continue;
    }
    const input = path.join(config.VIDEO_ROOT, rel);
    if (!fs.existsSync(input)) {
      logger.warn(`[HLS-PRE] Source missing, skip: ${input}`);
      continue;
    }
    const outDir = path.join(config.HLS_DIR, hash);
    const master = path.join(outDir, 'master.m3u8');
    if (fs.existsSync(master) && existsNonEmpty(master)) {
      logger.info(`[HLS-PRE] Exists, skipping: ${hash}`);
      continue;
    }
    ensureDir(outDir);

    // Build copy-first VOD
    const argsCopy = [
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'info',
      '-y',
      '-i', input,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'hls',
      '-start_number', '0',
      '-hls_time', String(segSec),
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments+split_by_time',
      '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
      master,
    ];

    const argsTranscode = [
      '-hide_banner', '-nostdin', '-loglevel', 'info', '-y',
      '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
      '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p',
      '-g', '48', '-keyint_min', '48',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart',
      '-f', 'hls', '-hls_time', String(segSec), '-hls_list_size', '0',
      '-hls_segment_type', 'mpegts',
      '-hls_flags', 'independent_segments+split_by_time',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
      master,
    ];

    logger.info(`[HLS-PRE] [${i + 1}/${entries.length}] Building VOD for: ${rel}`);
    try {
      // Try copy first; if it fails, transcode
      try { await run(config.FFMPEG_PATH, argsCopy); }
      catch { await run(config.FFMPEG_PATH, argsTranscode); }
      logger.info(`[HLS-PRE] Wrote ${master}`);
    } catch (e) {
      logger.error(`[HLS-PRE] Failed for ${rel}: ${e.message}`);
    }
  }
  logger.info('[HLS-PRE] VOD HLS prebuild complete.');
}

