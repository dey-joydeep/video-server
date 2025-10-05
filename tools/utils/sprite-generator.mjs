// tools/utils/sprite-generator.mjs
// Robust sprite generator that handles AV1 + bt709(reserved) cases by extracting PNG (RGB) frames
// and then compositing into a JPG sprite + VTT.
// Usage: node tools/utils/sprite-generator.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import sharp from 'sharp';
import { loadIndex } from '../../lib/db.mjs';
import { createLogger } from '../../lib/logger.mjs';

dotenv.config();

const logger = createLogger({
  dirname: 'logs/tools-log',
  filename: 'sprite-generator-%DATE%.log',
});

// --- Config ---
const CWD = process.cwd();
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || CWD);
const THUMBS_DIR = path.resolve(process.env.THUMBS_DIR || path.join(CWD, 'thumbs'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(CWD, 'data'));
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

const SUFFIX_SPRITE_IMG = process.env.SUFFIX_SPRITE_IMG || '_sprite.jpg';
const SUFFIX_SPRITE_VTT = process.env.SUFFIX_SPRITE_VTT || '_sprite.vtt';

const SPRITE_INTERVAL_SEC = Number(process.env.SPRITE_INTERVAL_SEC || 5);       // one frame every 5 seconds
const SPRITE_THUMB_WIDTH = Number(process.env.SPRITE_THUMB_WIDTH || 160);       // width of each tile in the sprite
const SPRITE_COLUMNS = Number(process.env.SPRITE_COLUMNS || 10);                // tiles per row
const SPRITE_JPEG_QUALITY = Number(process.env.SPRITE_JPEG_QUALITY || 82);

// --- Helpers ---
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`)));
    p.on('error', (e) => reject(new Error(e.message)));
  });
}

function secondsToTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}.000`;
}

/**
 * Extract frames as PNG (RGB) to avoid swscale/zscale color pipeline edge cases.
 * We try a small list of filters that are known to be resilient against AV1+bt709(reserved).
 */
async function extractFramesToPng({ input, outDir, fpsEverySec, width }) {
  ensureDir(outDir);
  const commonArgs = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-y', '-i', input,
  ];

  // Filters we try in order.
  // 1) Convert to RGB and scale; PNG avoids yuvj/yuv full-range surprises in mjpeg
  // 2) Explicitly assert bt709 through colorspace filter, then RGB
  // 3) Use zscale to normalize then RGB
  const vfCandidates = [
    `fps=1/${fpsEverySec},scale=${width}:-2,format=rgb24`,
    `colorspace=iall=bt709:all=bt709:fast=1,fps=1/${fpsEverySec},scale=${width}:-2,format=rgb24`,
    `zscale=primaries=bt709:transfer=bt709:matrix=bt709,format=gbrp,fps=1/${fpsEverySec},scale=${width}:-2,format=rgb24`,
  ];

  let lastError = null;
  for (const vf of vfCandidates) {
    const args = [
      ...commonArgs,
      '-vf', vf,
      // Force input as video only and write PNGs
      '-an',
      path.join(outDir, '%06d.png'),
    ];
    try {
      await run(FFMPEG_PATH, args);
      logger.info(`[SPRITE] ffmpeg succeeded with filter: ${vf}`);
      return;
    } catch (e) {
      lastError = e;
      logger.warn(`[SPRITE] ffmpeg failed with filter: ${vf}. Trying next fallback. ffmpeg error: ${e.message}`);
    }
  }
  throw lastError || new Error('ffmpeg failed for all filters');
}

/**
 * Compose a sprite sheet and VTT from extracted frames.
 * This combines a grid layout with chunking to support videos of any length.
 */
async function composeSpriteAndVtt({ framesDir, hash, outVttPath, intervalSec, tileW }) {
  const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();
  if (files.length === 0) throw new Error('No frames were extracted.');

  const firstMeta = await sharp(path.join(framesDir, files[0])).metadata();
  const srcW = firstMeta.width || tileW;
  const srcH = firstMeta.height || Math.round(tileW * 9 / 16);
  const tileH = Math.round(tileW * srcH / srcW);

  const cols = Math.max(1, SPRITE_COLUMNS);
  
  // Calculate max frames that can fit in one sprite sheet, respecting JPEG dimension limits
  const JPEG_MAX_DIMENSION = 65535;
  const maxRows = Math.floor(JPEG_MAX_DIMENSION / tileH);
  const maxFramesPerSprite = maxRows * cols;

  const frameChunks = [];
  for (let i = 0; i < files.length; i += maxFramesPerSprite) {
      frameChunks.push(files.slice(i, i + maxFramesPerSprite));
  }

  if (frameChunks.length > 1) {
      logger.info(`[SPRITE] Video requires ${frameChunks.length} sprite sheets due to JPEG size limits.`);
  }

  let vttContent = 'WEBVTT\n\n';
  const assetDir = path.join(THUMBS_DIR, hash);

  for (const [chunkIndex, frameChunk] of frameChunks.entries()) {
    const isMultiSprite = frameChunks.length > 1;
    const spriteFileName = isMultiSprite 
        ? `${hash}${SUFFIX_SPRITE_IMG.replace('.jpg', `_${chunkIndex + 1}.jpg`)}` 
        : `${hash}${SUFFIX_SPRITE_IMG}`;
    const currentSpritePath = path.join(assetDir, spriteFileName);

    const chunkRows = Math.ceil(frameChunk.length / cols);
    const spriteW = cols * tileW;
    const spriteH = chunkRows * tileH;

    logger.info(`[SPRITE] Generating sheet #${chunkIndex + 1} with ${frameChunk.length} frames (${cols}x${chunkRows})...`);

    const compositeOps = frameChunk.map((frame, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        return {
            input: path.join(framesDir, frame),
            left: col * tileW,
            top: row * tileH,
        };
    });

    await sharp({
        create: { width: spriteW, height: spriteH, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
    .composite(compositeOps)
    .jpeg({ quality: SPRITE_JPEG_QUALITY, mozjpeg: true })
    .toFile(currentSpritePath);

    // Append to VTT file for this chunk
    for (let i = 0; i < frameChunk.length; i++) {
        const globalFrameIndex = (chunkIndex * maxFramesPerSprite) + i;
        const startTime = globalFrameIndex * intervalSec;
        const endTime = startTime + intervalSec;
        
        const row = Math.floor(i / cols);
        const col = i % cols;
        const x = col * tileW;
        const y = row * tileH;

        vttContent += `${secondsToTimestamp(startTime)} --> ${secondsToTimestamp(endTime)}\n`;
        vttContent += `${spriteFileName}#xywh=${x},${y},${tileW},${tileH}\n\n`;
    }
  }

  fs.writeFileSync(outVttPath, vttContent, 'utf-8');
}

/**
 * Per-file pipeline
 */
async function generateSpritesForFile({ relPath, rootDir, hash }) {
  const inputAbs = path.join(rootDir, relPath);
  const assetDir = path.join(THUMBS_DIR, hash);
  const outSpritePath = path.join(assetDir, `${hash}${SUFFIX_SPRITE_IMG}`); // Base path, may have _N appended
  const outVttPath = path.join(assetDir, `${hash}${SUFFIX_SPRITE_VTT}`);

  ensureDir(assetDir);

  // Skip if VTT exists (idempotent behavior)
  if (fs.existsSync(outVttPath)) {
    logger.info('[SPRITE] VTT file already exists. Skipping.');
    return;
  }

  const tempDir = path.join(assetDir, `.__sprite_tmp_${Date.now()}`);
  ensureDir(tempDir);

  try {
    logger.info('[SPRITE] Extracting frames with ffmpeg...');
    await extractFramesToPng({
      input: inputAbs,
      outDir: tempDir,
      fpsEverySec: SPRITE_INTERVAL_SEC,
      width: SPRITE_THUMB_WIDTH,
    });

    await composeSpriteAndVtt({
      framesDir: tempDir,
      hash: hash, // Pass hash for naming
      outVttPath,
      intervalSec: SPRITE_INTERVAL_SEC,
      tileW: SPRITE_THUMB_WIDTH,
    });

    logger.info(`[SPRITE] Finished sprite/VTT generation for ${hash}`);

  } finally {
    // Best-effort cleanup with slight delay to avoid Windows file locking
    setTimeout(() => {
      fs.rm(tempDir, { recursive: true, force: true }, (err) => {
        if (err) logger.warn(`[SPRITE] Delayed cleanup failed for ${tempDir}: ${err.message}`);
        else logger.info(`[SPRITE] Cleaned temp ${tempDir}`);
      });
    }, 2000);
  }
}


export async function generateSprites() {
  logger.info('[SPRITE] Starting sprite generation process...');

  const videoRoot = VIDEO_ROOT;
  const index = loadIndex(DATA_DIR, videoRoot);
  const videos = Object.entries(index.files || {});

  logger.info(`[SPRITE] Found ${videos.length} videos to process.`);

  for (const [i, [relPath, videoData]] of videos.entries()) {
    const { hash } = videoData;
    if (!hash) {
        logger.warn(`[SPRITE] Skipping video with no hash: ${relPath}`);
        continue;
    }

    logger.info(`[SPRITE] [${i + 1}/${videos.length}] Processing: ${relPath}`);
    try {
      await generateSpritesForFile({ relPath: relPath, rootDir: videoRoot, hash: hash });
    } catch (e) {
      logger.error(`[SPRITE] Failed to process ${relPath}`, e);
    }
  }

  logger.info('[SPRITE] Sprite generation process finished.');
}

