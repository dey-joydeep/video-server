import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../lib/logger.mjs';
import { loadIndex } from '../../lib/db.mjs';
import { generateThumb } from '../../lib/ffmpeg.mjs';

dotenv.config();

const logger = createLogger({
    dirname: 'logs/tools-log',
    filename: 'thumbnails-%DATE%.log',
});

// --- Config ---
const CWD = process.cwd();
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || CWD);
const THUMBS_DIR = path.resolve(process.env.THUMBS_DIR || path.join(CWD, 'thumbs'));
const SUFFIX_THUMB = process.env.SUFFIX_THUMB || '_thumb.jpg';
const THUMB_WIDTH = parseInt(process.env.THUMB_WIDTH || '320', 10);
const THUMB_AT_SECONDS = parseFloat(process.env.THUMB_AT_SECONDS || '3');

export async function generateThumbnails() {
    logger.info('[THUMB] Starting thumbnail generation process...');
    const db = loadIndex(path.join(CWD, 'data'), VIDEO_ROOT);
    const videos = Object.entries(db.files);

    if (videos.length === 0) {
        logger.warn('[THUMB] No videos found in the index. Run sync first.');
        return;
    }

    logger.info(`[THUMB] Found ${videos.length} videos to process.`);

    for (const [i, [relPath, videoData]] of videos.entries()) {
        const { hash } = videoData;
        if (!hash) {
            logger.warn(`[THUMB] Skipping video with no hash: ${relPath}`);
            continue;
        }

        const thumbDir = path.join(THUMBS_DIR, hash);
        const thumbPath = path.join(thumbDir, `${hash}${SUFFIX_THUMB}`);

        if (fs.existsSync(thumbPath)) {
            continue; // Skip if thumb already exists
        }

        logger.info(`[THUMB] [${i + 1}/${videos.length}] Generating for: ${relPath}`);

        const videoFullPath = path.join(VIDEO_ROOT, relPath);

        try {
            await generateThumb({
                filePath: videoFullPath,
                outPath: thumbPath, // Pass the full output path directly
                width: THUMB_WIDTH,
                atSec: THUMB_AT_SECONDS,
            });
        } catch (error) {
            logger.error(`[THUMB] Failed to generate for ${relPath}: ${error.message}`);
        }
    }

    logger.info('[THUMB] Thumbnail generation process finished.');
}

