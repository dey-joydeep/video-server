import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { loadIndex } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import config from '../../lib/config.js';
import { LOGGING } from '../../lib/constants.js';

const logger = createLogger({
  dirname: config.TOOLS_LOG_DIR,
  filename: `${LOGGING.TOOL_LOG_FILENAME_PREFIXES.GEN_HEADSTART}%DATE%.log`,
});

const CWD = process.cwd();
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || CWD);
const THUMBS_DIR = path.resolve(process.env.THUMBS_DIR || path.join(CWD, 'thumbs'));
// DATA_DIR not used; index is loaded via lib/db helper
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

const SUFFIX_HEADSTART_MP4 =
  process.env.SUFFIX_HEADSTART_MP4 || config.SUFFIX_HEADSTART_MP4 || '_head.mp4';
const HEADSTART_SEC = parseInt(process.env.HEADSTART_SEC || '20', 10);
const HEADSTART_CRF = process.env.HEADSTART_CRF || '28';
const HEADSTART_PRESET = process.env.HEADSTART_PRESET || 'veryfast';
const HEADSTART_HEIGHT = parseInt(process.env.HEADSTART_HEIGHT || '480', 10);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))));
    p.on('error', (e) => reject(e));
  });
}

export async function generateHeadStart() {
  logger.info('[HEAD] Starting head-start MP4 generation...');
  const { byRel } = loadIndex();
  const videos = Object.entries(byRel);
  if (!videos.length) {
    logger.warn('[HEAD] No videos found. Run sync first.');
    return;
  }

  for (const [i, [relPath, videoData]] of videos.entries()) {
    const { hash, durationMs } = videoData;
    if (!hash || !durationMs) {
      logger.warn(`[HEAD] Skipping (missing hash/duration): ${relPath}`);
      continue;
    }
    const assetDir = path.join(THUMBS_DIR, hash);
    fs.mkdirSync(assetDir, { recursive: true });
    const headPath = path.join(assetDir, `${hash}${SUFFIX_HEADSTART_MP4}`);
    if (fs.existsSync(headPath)) {
      logger.info(`[HEAD] Exists, skipping: ${headPath}`);
      continue;
    }
    const input = path.join(VIDEO_ROOT, relPath);
    if (!fs.existsSync(input)) {
      logger.warn(`[HEAD] Source missing, skip: ${input}`);
      continue;
    }
    const sec = Math.max(3, Math.min(HEADSTART_SEC, Math.floor((durationMs || 0) / 1000)));
    if (sec < 3) {
      logger.info(`[HEAD] Too short for head-start, skip: ${relPath}`);
      continue;
    }
    logger.info(`[HEAD] [${i + 1}/${videos.length}] ${relPath} -> ${headPath} (${sec}s)`);
    const vf = `scale=-2:${HEADSTART_HEIGHT}`;
    const args = [
      '-y',
      '-ss', '0',
      '-t', String(sec),
      '-i', input,
      '-vf', vf,
      '-c:v', 'libx264',
      '-preset', HEADSTART_PRESET,
      '-crf', HEADSTART_CRF,
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      headPath,
    ];
    try {
      await run(FFMPEG_PATH, args);
      logger.info(`[HEAD] Wrote ${headPath}`);
    } catch (e) {
      logger.error(`[HEAD] Failed: ${relPath}`, e);
    }
  }
  logger.info('[HEAD] Head-start MP4 generation complete.');
}
