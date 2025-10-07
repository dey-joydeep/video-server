import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { loadIndex } from '../../lib/db.mjs';
import { createLogger } from '../../lib/logger.mjs';
import config from '../../lib/config.mjs';
import { LOGGING } from '../../lib/constants.mjs';

const logger = createLogger({
    dirname: config.TOOLS_LOG_DIR,
    filename: `${LOGGING.TOOL_LOG_FILENAME_PREFIXES.GEN_CLIPS}%DATE%.log`,
});

// --- Config ---
const CWD = process.cwd();
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || CWD);
const THUMBS_DIR = path.resolve(
    process.env.THUMBS_DIR || path.join(CWD, 'thumbs')
);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(CWD, 'data'));
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const SUFFIX_PREVIEW_CLIP = process.env.SUFFIX_PREVIEW_CLIP || '_preview.mp4';

// --- Helper to run a process ---
function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('close', (code) =>
            code === 0
                ? resolve()
                : reject(
                      new Error(`ffmpeg error: ${err.trim() || `exit ${code}`}`)
                  )
        );
        p.on('error', (e) => reject(e));
    });
}

// --- Main generation logic ---
export async function generateClips() {
    logger.info('[CLIP] Starting preview clip generation process...');
    const db = loadIndex(DATA_DIR, VIDEO_ROOT);
    const videos = Object.entries(db.files);

    if (videos.length === 0) {
        logger.warn('[CLIP] No videos found in the index. Run sync first.');
        return;
    }

    logger.info(`[CLIP] Found ${videos.length} videos to process.`);

    for (const [i, [relPath, videoData]] of videos.entries()) {
        const { hash, durationMs } = videoData;
        if (!hash || !durationMs) {
            logger.warn(
                `[CLIP] Skipping video with no hash or duration: ${relPath}`
            );
            continue;
        }

        const assetDir = path.join(THUMBS_DIR, hash);
        const clipPath = path.join(assetDir, `${hash}${SUFFIX_PREVIEW_CLIP}`);

        logger.info(
            `[CLIP] [${i + 1}/${videos.length}] Processing: ${relPath}`
        );

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
                // Use -ss AFTER the input for accurate seeking
                '-i',
                videoFullPath,
                '-ss',
                startTime.toFixed(2),
                '-t',
                clipDuration,
                '-c:v',
                'libx264',
                '-preset',
                'veryfast',
                '-crf',
                '28',
                '-g', '12',
                '-keyint_min', '12',
                '-sc_threshold', '0',
                '-pix_fmt', 'yuv420p',
                '-profile:v', 'high',
                '-level', '4.0',

                '-an', // No audio
                // Combine all video filters into one -vf flag
                '-vf',
                `fps=24,setpts=PTS-STARTPTS,scale=480:-2`,
                '-movflags',
                '+faststart',
                clipPath,
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
