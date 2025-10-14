import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { loadIndex } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import config from '../../lib/config.js';
import { LOGGING } from '../../lib/constants.js';

const logger = createLogger({
  dirname: config.TOOLS_LOG_DIR,
  filename: `${LOGGING.TOOL_LOG_FILENAME_PREFIXES.GEN_CLIPS}%DATE%.log`,
});

// --- Config ---
/** @constant {string} CWD - The current working directory. */
const CWD = process.cwd();
/** @constant {string} VIDEO_ROOT - The absolute path to the root directory of the video library. */
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || CWD);
/** @constant {string} THUMBS_DIR - The absolute path to the directory where thumbnails and clips are stored. */
const THUMBS_DIR = path.resolve(
  process.env.THUMBS_DIR || path.join(CWD, 'thumbs')
);
// DATA_DIR not used; index is loaded via lib/db helper
/** @constant {string} FFMPEG_PATH - The path to the ffmpeg executable. */
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
/** @constant {string} SUFFIX_PREVIEW_CLIP - The filename suffix for generated preview clips. */
const SUFFIX_PREVIEW_CLIP = process.env.SUFFIX_PREVIEW_CLIP || '_preview.mp4';

// --- Helper to run a process ---
/**
 * Executes a shell command and captures its stderr for error reporting.
 * @param {string} cmd - The command to execute (e.g., 'ffmpeg').
 * @param {string[]} args - An array of arguments for the command.
 * @returns {Promise<void>} A promise that resolves if the command succeeds, or rejects with an error if it fails.
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg error: ${err.trim() || `exit ${code}`}`))
    );
    p.on('error', (e) => reject(e));
  });
}

// --- Main generation logic ---
/**
 * Generates short preview clips for all videos in the index.
 * Clips are generated using ffmpeg with specific parameters for web-friendly playback.
 */
export async function generateClips() {
  logger.info('[CLIP] Starting preview clip generation process...');
  const { byRel } = loadIndex();
  const videos = Object.entries(byRel);

  if (videos.length === 0) {
    logger.warn('[CLIP] No videos found in the index. Run sync first.');
    return;
  }

  logger.info(`[CLIP] Found ${videos.length} videos to process.`);

  for (const [i, [relPath, videoData]] of videos.entries()) {
    const { hash, durationMs } = videoData || {};
    if (!hash || !durationMs) {
      logger.warn(`[CLIP] Skipping video with no hash or duration: ${relPath}`);
      continue;
    }

    const assetDir = path.join(THUMBS_DIR, hash);
    const clipPath = path.join(assetDir, `${hash}${SUFFIX_PREVIEW_CLIP}`);

    logger.info(`[CLIP] [${i + 1}/${videos.length}] Processing: ${relPath}`);

    if (fs.existsSync(clipPath)) {
      logger.info(`[CLIP] Preview clip already exists. Skipping.`);
      continue;
    }

    const durationSec = durationMs / 1000;
    let clipDuration;

    if (durationSec >= 20) {
      clipDuration = 10;
    } else if (durationSec >= 10) {
      clipDuration = 5;
    } else if (durationSec >= 5) {
      clipDuration = 3;
    } else {
      logger.info(`[CLIP] Video is shorter than 5s. Skipping.`);
      continue;
    }

    // Start the clip at 10% into the video to get a more representative segment
    const startTime = durationSec * 0.1;
    const videoFullPath = path.join(VIDEO_ROOT, relPath);

    try {
      logger.info(`[CLIP] Generating ${clipDuration}s clip...`);
      const ffmpegArgs = [
        '-i', // Specify the input file
        videoFullPath, // The path to the source video file
        '-ss', // Seek to a specific position in the input file
        startTime.toFixed(2), // The time (in seconds) to start the clip
        '-t', // Set the duration of the output clip
        clipDuration, // The length of the clip in seconds
        '-c:v', // Set the video codec
        'libx264', // Use the H.264 video encoder (widely compatible)
        '-preset', // Set the encoding speed/compression ratio
        'veryfast', // A fast preset for quicker encoding, good for previews
        '-crf', // Set the Constant Rate Factor for video quality
        '24', // CRF value (lower means higher quality, larger file size; 24 is a good balance)
        '-g', // Set the Group of Pictures (GOP) size
        '12', // Keyframe interval (e.g., 12 frames for 0.5-second interval at 24fps)
        '-keyint_min', // Minimum keyframe interval
        '12', // Same as GOP size for consistent keyframes
        '-sc_threshold', // Scene change detection threshold
        '0', // Disable scene change detection for fixed keyframe intervals
        '-pix_fmt', // Set the pixel format
        'yuv420p', // YUV 4:2:0 pixel format (most compatible for web)
        '-profile:v', // Set the H.264 profile for compatibility
        'high', // High profile for broad compatibility
        '-level', // Set the H.264 level for compatibility
        '4.0', // Level 4.0 for broad compatibility
        '-an', // Disable audio (previews are typically silent)
        '-vf', // Apply video filters
        `fps=24,setpts=PTS-STARTPTS,scale=480:-2`, // Filters: force 24fps, reset timestamps, scale video width to 480px (height auto)
        '-movflags', // Special flags for the MP4 container
        '+faststart', // Move metadata to the beginning for faster web playback
        clipPath, // The output file path (where the preview clip will be saved)
      ];
      await run(FFMPEG_PATH, ffmpegArgs);
      logger.info(`[CLIP] Preview clip saved to ${clipPath}`);
    } catch (error) {
      logger.error(
        `[CLIP] Failed to generate clip for ${relPath}: ${error.message}`
      );
    }
  }
  logger.info('[CLIP] Preview clip generation process finished.');
}
