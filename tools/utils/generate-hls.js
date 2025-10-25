/**
 * @fileoverview Offline HLS stream generator.
 * This script iterates through all videos in the JSON database and creates
 * HLS (HTTP Live Streaming) VOD (Video on Demand) streams for them.
 * It uses an intelligent codec check to decide whether to perform a fast
 * stream copy or a full, reliable transcode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadIndex } from '../../lib/db.js';
import config from '../../lib/config.js';
import { createLogger } from '../../lib/logger.js';
import { LOGGING } from '../../lib/constants.js';

const logger = createLogger({
  dirname: config.TOOLS_LOG_DIR,
  filename: `${LOGGING.TOOL_LOG_FILENAME_PREFIXES.SYNC || 'sync_'}generate_hls-%DATE%.log`,
});

/**
 * Ensures a directory exists, creating it if necessary.
 * @param {string} p The directory path.
 */
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Spawns a child process and returns a promise that resolves on success
 * or rejects on error.
 * @param {string} cmd The command to execute.
 * @param {string[]} args The arguments for the command.
 * @returns {Promise<void>} A promise that resolves when the command completes successfully.
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))
    );
    p.on('error', (e) => reject(e));
  });
}

/**
 * Checks if a file exists and is not empty.
 * @param {string} file The path to the file.
 * @returns {boolean} True if the file exists and has a size greater than 0.
 */
function existsNonEmpty(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Main function to generate HLS VOD streams for all videos in the library.
 */
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

    // If a valid HLS stream already exists, skip it.
    if (fs.existsSync(master) && existsNonEmpty(master)) {
      logger.info(`[HLS-PRE] Exists, skipping: ${hash}`);
      continue;
    }
    ensureDir(outDir);

    // Create AES encryption key for the HLS stream.
    const keyPath = path.join(outDir, 'key.bin');
    const keyInfoPath = path.join(outDir, 'keyinfo');
    if (!fs.existsSync(keyPath)) {
      fs.writeFileSync(keyPath, crypto.randomBytes(16));
    }
    const keyUrl = `/hlskey/${hash}/key.bin`;
    fs.writeFileSync(keyInfoPath, `${keyUrl}\n${keyPath}\n`);

    // --- Decide whether to copy or transcode based on codec info --- //
    const { vcodec, acodec } = rec;
    const canCopyVideo = vcodec === 'h264';
    const canCopyAudio =
      acodec === 'aac' || acodec === 'mp3' || acodec === 'mp2';
    const shouldCopy = canCopyVideo && canCopyAudio;

    // --- FFmpeg argument definitions --- //

    // Arguments for a direct stream copy (fast but requires compatible codecs).
    const argsCopy = [
      '-hide_banner', // Suppress printing the ffmpeg banner
      '-nostdin', // Disable interaction on stdin
      '-loglevel',
      'info', // Set log level to info
      '-y', // Overwrite output files without asking
      '-i',
      input, // Input file path
      // Stream mapping
      '-map',
      '0:v:0', // Select the first video stream
      '-map',
      '0:a:0?', // Select the first audio stream (if it exists)
      // Codec settings: copy streams without re-encoding
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      // HLS output settings
      '-f',
      'hls', // Output format is HLS
      '-start_number',
      '0', // Start segment numbering from 0
      '-hls_time',
      String(segSec), // Segment duration in seconds
      '-hls_list_size',
      '0', // Keep all segments in the playlist (VOD)
      '-hls_playlist_type',
      'vod', // Create a VOD (not live) playlist
      '-hls_flags',
      'independent_segments+split_by_time', // Ensure segments can be played independently
      '-hls_segment_filename',
      path.join(outDir, 'seg_%05d.ts'), // Segment filename pattern
      '-hls_key_info_file',
      keyInfoPath, // HLS encryption key info file
      master, // Output master playlist file
    ];

    // Arguments for a full transcode (reliable but slower).
    const argsTranscode = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'info',
      '-y',
      '-i',
      input,
      // Stream mapping
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      // Video codec settings: transcode to H.264 (libx264)
      '-c:v',
      'libx264', // Encoder
      '-preset',
      'veryfast', // Encoding speed preset (favor speed over size)
      '-crf',
      '21', // Constant Rate Factor (quality, lower is better)
      '-profile:v',
      'high', // H.264 profile for broad compatibility
      '-level:v',
      '4.1', // H.264 level for broad compatibility
      '-pix_fmt',
      'yuv420p', // Pixel format for broad compatibility
      // Keyframe settings
      '-g',
      '48', // GOP (Group of Pictures) size
      '-keyint_min',
      '48', // Minimum keyframe interval
      // Audio codec settings: transcode to AAC
      '-c:a',
      'aac', // Encoder
      '-b:a',
      '128k', // Audio bitrate
      '-ac',
      '2', // Stereo audio channels
      '-movflags',
      '+faststart', // For MP4 containers, move metadata to the start
      // HLS output settings
      '-f',
      'hls',
      '-hls_time',
      String(segSec),
      '-hls_list_size',
      '0',
      '-hls_segment_type',
      'mpegts', // Use MPEG-TS container for segments
      '-hls_flags',
      'independent_segments+split_by_time',
      '-hls_playlist_type',
      'vod', // Create a VOD (not live) playlist
      '-hls_segment_filename',
      path.join(outDir, 'seg_%05d.ts'),
      '-hls_key_info_file',
      keyInfoPath,
      master,
    ];

    logger.info(
      `[HLS-PRE] [${i + 1}/${entries.length}] Building VOD for: ${rel} (copy=${shouldCopy})`
    );

    // Execute the appropriate ffmpeg command.
    try {
      const args = shouldCopy ? argsCopy : argsTranscode;
      await run(config.FFMPEG_PATH, args);
      logger.info(`[HLS-PRE] Wrote ${master}`);
    } catch (e) {
      logger.error(`[HLS-PRE] Failed for ${rel}: ${e.message}`);
    }
  }
  logger.info('[HLS-PRE] VOD HLS prebuild complete.');
}
