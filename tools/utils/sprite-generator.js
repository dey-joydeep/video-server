import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { loadIndex } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import config from '../../lib/config.js';
import { LOGGING } from '../../lib/constants.js';

const logger = createLogger({
    dirname: config.TOOLS_LOG_DIR,
    filename: `${LOGGING.TOOL_LOG_FILENAME_PREFIXES.GEN_SPRITE}%DATE%.log`,
});

// --- Helpers ---
/**
 * Ensures that a directory exists, creating it if it doesn't.
 * @param {string} p - The path to the directory to ensure.
 */
function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

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
                : reject(new Error(err.trim() || `exit ${code}`))
        );
        p.on('error', (e) => reject(new Error(e.message)));
    });
}

/**
 * Converts a total number of seconds into an HLS-compatible timestamp format (HH:MM:SS.ms).
 * @param {number} totalSeconds - The total number of seconds.
 * @returns {string} The formatted timestamp string.
 */
function secondsToTimestamp(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}.000`;
}

/**
 * Extract frames as PNG (RGB) to avoid swscale/zscale color pipeline edge cases.
 */
/**
 * Extracts frames from a video as PNG images using ffmpeg.
 * It tries multiple filter pipelines to handle various video color profiles robustly.
 * @param {object} options - Options for frame extraction.
 * @param {string} options.input - Path to the input video file.
 * @param {string} options.outDir - Output directory for the extracted PNG frames.
 * @param {number} options.fpsEverySec - Extract one frame every `fpsEverySec` seconds.
 * @param {number} options.width - Desired width of the extracted frames.
 * @throws {Error} If ffmpeg fails to extract frames after all attempts.
 */
async function extractFramesToPng({ input, outDir, fpsEverySec, width }) {
    ensureDir(outDir);
    const commonArgs = [
        '-hide_banner', // Hide FFmpeg's startup information
        '-nostdin', // Prevent FFmpeg from waiting for user input
        '-loglevel', // Set the logging level
        'error', // Only show errors to keep output clean
        '-y', // Overwrite output files without asking
        '-i', // Specify the input file
        input, // The path to the video file
    ];

    const vfCandidates = [
        // 1) Standard approach: set frame rate, scale, and convert to RGB
        `fps=1/${fpsEverySec},scale=${width}:-2,format=rgb24`,
        // 2) Fallback with colorspace normalization: useful for videos with unusual color profiles
        `colorspace=iall=bt709:all=bt709:fast=1,fps=1/${fpsEverySec},scale=${width}:-2,format=rgb24`,
        // 3) Another fallback with zscale for more advanced color handling
        `zscale=primaries=bt709:transfer=bt709:matrix=bt709,format=gbrp,fps=1/${fpsEverySec},scale=${width}:-2,format=rgb24`,
    ];

    let lastError = null;
    for (const vf of vfCandidates) {
        const args = [
            ...commonArgs,
            '-vf',
            vf,
            '-an',
            path.join(outDir, '%06d.png'),
        ];
        try {
            await run(config.FFMPEG_PATH, args);
            logger.info(`[SPRITE] ffmpeg succeeded with filter: ${vf}`);
            return;
        } catch (e) {
            lastError = e;
            logger.warn(
                `[SPRITE] ffmpeg failed with filter: ${vf}. Trying next fallback. ffmpeg error: ${e.message}`
            );
        }
    }
    throw lastError || new Error('ffmpeg failed for all filters');
}

/**
 * Compose a sprite sheet and VTT from extracted frames.
 */
/**
 * Composes a sprite sheet (or multiple) from extracted PNG frames and generates a corresponding VTT file.
 * @param {object} options - Options for composing the sprite and VTT.
 * @param {string} options.framesDir - Directory containing the extracted PNG frames.
 * @param {string} options.hash - The hash of the video, used for naming output files.
 * @param {string} options.outVttPath - The output path for the VTT file.
 * @param {number} options.intervalSec - The time interval between frames in the VTT.
 * @param {number} options.tileW - The width of each individual frame (tile) in the sprite sheet.
 * @throws {Error} If no frames were extracted.
 */
async function composeSpriteAndVtt({
    framesDir,
    hash,
    outVttPath,
    intervalSec,
    tileW,
}) {
    const files = fs
        .readdirSync(framesDir)
        .filter((f) => f.endsWith('.png'))
        .sort();
    if (files.length === 0) throw new Error('No frames were extracted.');

    const firstMeta = await sharp(path.join(framesDir, files[0])).metadata();
    const srcW = firstMeta.width || tileW;
    const srcH = firstMeta.height || Math.round((tileW * 9) / 16);
    const tileH = Math.round((tileW * srcH) / srcW);

    const cols = Math.max(1, config.SPRITE_COLUMNS);

    /** @constant {number} JPEG_MAX_DIMENSION - The maximum pixel dimension for JPEG images. */
    const JPEG_MAX_DIMENSION = 65535;
    const maxRows = Math.floor(JPEG_MAX_DIMENSION / tileH);
    const maxFramesPerSprite = maxRows * cols;

    const frameChunks = [];
    for (let i = 0; i < files.length; i += maxFramesPerSprite) {
        frameChunks.push(files.slice(i, i + maxFramesPerSprite));
    }

    if (frameChunks.length > 1) {
        logger.info(
            `[SPRITE] Video requires ${frameChunks.length} sprite sheets due to JPEG size limits.`
        );
    }

    let vttContent = 'WEBVTT\n\n';
    const assetDir = path.join(config.THUMBS_DIR, hash);

    for (const [chunkIndex, frameChunk] of frameChunks.entries()) {
        const isMultiSprite = frameChunks.length > 1;
        const spriteFileName = isMultiSprite
            ? `${hash}${config.SUFFIX_SPRITE_IMG.replace('.jpg', `_${chunkIndex + 1}.jpg`)}`
            : `${hash}${config.SUFFIX_SPRITE_IMG}`;
        const currentSpritePath = path.join(assetDir, spriteFileName);

        const chunkRows = Math.ceil(frameChunk.length / cols);
        const spriteW = cols * tileW;
        const spriteH = chunkRows * tileH;

        logger.info(
            `[SPRITE] Generating sheet #${chunkIndex + 1} with ${frameChunk.length} frames (${cols}x${chunkRows})...`
        );

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
            create: {
                width: spriteW,
                height: spriteH,
                channels: 3,
                background: { r: 0, g: 0, b: 0 },
            },
        })
            .composite(compositeOps)
            .jpeg({ quality: config.SPRITE_JPEG_QUALITY, mozjpeg: true })
            .toFile(currentSpritePath);

        for (let i = 0; i < frameChunk.length; i++) {
            const globalFrameIndex = chunkIndex * maxFramesPerSprite + i;
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
/**
 * Generates sprite sheets and VTT files for a single video file.
 * @param {object} options - Options for generating sprites for a file.
 * @param {string} options.relPath - The relative path of the video file.
 * @param {string} options.rootDir - The root directory of the video library.
 * @param {string} options.hash - The hash of the video file.
 */
async function generateSpritesForFile({ relPath, rootDir, hash }) {
    const inputAbs = path.join(rootDir, relPath);
    const assetDir = path.join(config.THUMBS_DIR, hash);
    const outVttPath = path.join(
        assetDir,
        `${hash}${config.SUFFIX_SPRITE_VTT}`
    );

    ensureDir(assetDir);

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
            fpsEverySec: config.SPRITE_INTERVAL_SEC,
            width: config.SPRITE_THUMB_WIDTH,
        });

        await composeSpriteAndVtt({
            framesDir: tempDir,
            hash: hash,
            outVttPath,
            intervalSec: config.SPRITE_INTERVAL_SEC,
            tileW: config.SPRITE_THUMB_WIDTH,
        });

        logger.info(`[SPRITE] Finished sprite/VTT generation for ${hash}`);
    } finally {
        setTimeout(() => {
            fs.rm(tempDir, { recursive: true, force: true }, () => {});
        }, 5000);
    }
}

/**
 * Orchestrates the generation of sprite sheets and VTT files for all videos in the index.
 */
export async function generateSprites() {
    logger.info('[SPRITE] Starting sprite generation process...');

    const index = loadIndex(config.DATA_DIR, config.VIDEO_ROOT);
    const videos = Object.entries(index.files || {});

    logger.info(`[SPRITE] Found ${videos.length} videos to process.`);

    for (const [i, [relPath, videoData]] of videos.entries()) {
        const { hash } = videoData;
        if (!hash) {
            logger.warn(`[SPRITE] Skipping video with no hash: ${relPath}`);
            continue;
        }

        logger.info(
            `[SPRITE] [${i + 1}/${videos.length}] Processing: ${relPath}`
        );
        try {
            await generateSpritesForFile({
                relPath: relPath,
                rootDir: config.VIDEO_ROOT,
                hash: hash,
            });
        } catch (e) {
            logger.error(`[SPRITE] Failed to process ${relPath}`, e);
        }
    }

    logger.info('[SPRITE] Sprite generation process finished.');
}
