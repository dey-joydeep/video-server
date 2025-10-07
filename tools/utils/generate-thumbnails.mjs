import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../lib/logger.mjs';
import { loadIndex } from '../../lib/db.mjs';
import { generateThumb } from '../../lib/ffmpeg.mjs';
import config from '../../lib/config.mjs';
import { LOGGING } from '../../lib/constants.mjs';

const logger = createLogger({
    dirname: config.TOOLS_LOG_DIR,
    filename: `${LOGGING.TOOL_LOG_FILENAME_PREFIXES.GEN_THUMBS}%DATE%.log`,
});

/**
 * Generates thumbnails for all videos in the index.
 * It skips videos that already have a thumbnail.
 */
export async function generateThumbnails() {
    logger.info('[THUMB] Starting thumbnail generation process...');
    const db = loadIndex(config.DATA_DIR, config.VIDEO_ROOT);
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

        const thumbDir = path.join(config.THUMBS_DIR, hash);
        const thumbPath = path.join(thumbDir, `${hash}${config.SUFFIX_THUMB}`);

        if (fs.existsSync(thumbPath)) {
            continue; // Skip if thumb already exists
        }

        logger.info(
            `[THUMB] [${i + 1}/${videos.length}] Generating for: ${relPath}`
        );

        const videoFullPath = path.join(config.VIDEO_ROOT, relPath);

        try {
            await generateThumb({
                filePath: videoFullPath,
                outPath: thumbPath, // Pass the full output path directly
                width: config.THUMB_WIDTH,
                atSec: config.THUMB_AT_SECONDS,
            });
        } catch (error) {
            logger.error(
                `[THUMB] Failed to generate for ${relPath}: ${error.message}`
            );
        }
    }

    logger.info('[THUMB] Thumbnail generation process finished.');
}
