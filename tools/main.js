import dotenv from 'dotenv';
dotenv.config();

import { createLogger } from '../lib/logger.js';

import { runSync } from './utils/sync.js';
import { generateThumbnails } from './utils/generate-thumbnails.js';
import { generateSprites } from './utils/sprite-generator.js';
import { generateClips } from './utils/generate-clips.js';
import { generateHeadStart } from './utils/generate-headstart.js';
import { generateHlsVod } from './utils/generate-hls.js';

const logger = createLogger({
  dirname: 'logs/tools-log',
  filename: 'main-%DATE%.log',
});

/**
 * Main orchestration function for the video processing pipeline.
 * It performs metadata synchronization, then generates thumbnails, sprites, and clips in parallel.
 */
async function main() {
  logger.info('[MAIN] Starting full processing pipeline...');
  const startTime = Date.now();

  try {
    logger.info('[MAIN] Running metadata sync...');
    await runSync();
    logger.info('[MAIN] Metadata sync complete.');
  } catch (e) {
    logger.error('[MAIN] Metadata sync failed catastrophically.', e);
    process.exit(1); // Exit if sync fails, as generators depend on it
  }

  logger.info(
    '[MAIN] Starting parallel asset generation (thumbnails, sprites, clips)...'
  );

  const results = await Promise.allSettled([
    generateThumbnails(),
    generateSprites(),
    generateClips(),
    generateHeadStart(),
    generateHlsVod(),
  ]);

  let allSuccessful = true;
  results.forEach((result, index) => {
    const name = ['Thumbnails', 'Sprites', 'Clips', 'HeadStart', 'HlsVod'][index];
    if (result.status === 'fulfilled') {
      logger.info(`[MAIN] ${name} generation completed successfully.`);
    } else {
      allSuccessful = false;
      logger.error(`[MAIN] ${name} generation failed:`, result.reason);
    }
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  if (allSuccessful) {
    logger.info(
      `[MAIN] Full processing pipeline finished successfully in ${duration}s.`
    );
  } else {
    logger.error(
      `[MAIN] Full processing pipeline finished in ${duration}s with one or more errors.`
    );
  }
}

main().catch((err) => {
  logger.error(
    '[MAIN] An unexpected fatal error occurred in main orchestrator:',
    err
  );
  process.exit(1);
});
