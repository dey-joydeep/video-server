
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import sharp from 'sharp';
import { loadIndex } from '../lib/db.mjs';
import logger from '../lib/logger.mjs';

dotenv.config();

// --- Config ---
const CWD = process.cwd();
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || CWD);
const THUMBS_DIR = path.resolve(process.env.THUMBS_DIR || path.join(CWD, 'thumbs'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(CWD, 'data'));
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

const SPRITE_INTERVAL_SEC = 5; // one frame every 5 seconds
const SPRITE_THUMB_WIDTH = 160; // width of each small thumbnail in the sprite

// --- Helper to run a process ---
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

// --- Helper to format time for VTT ---
function formatVttTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// --- Main generation logic ---
async function generateSprites() {
    logger.info('[SPRITE] Starting sprite generation process...');
    const db = loadIndex(DATA_DIR, VIDEO_ROOT);
    const videos = Object.entries(db.files);

    if (videos.length === 0) {
        logger.warn('[SPRITE] No videos found in the index. Run sync first.');
        return;
    }

    logger.info(`[SPRITE] Found ${videos.length} videos to process.`);

    for (const [i, [relPath, videoData]] of videos.entries()) {
        const { hash } = videoData;
        if (!hash) {
            logger.warn(`[SPRITE] Skipping video with no hash: ${relPath}`);
            continue;
        }

        const videoFullPath = path.join(VIDEO_ROOT, relPath);
        const spriteVttPath = path.join(THUMBS_DIR, `${hash}_sprite.vtt`);

        logger.info(`[SPRITE] [${i + 1}/${videos.length}] Processing: ${relPath}`);

        if (fs.existsSync(spriteVttPath)) {
            logger.info(`[SPRITE] VTT file already exists. Skipping.`);
            continue;
        }

        // Clean up any previous partial runs to ensure a fresh start
        const oldSprites = fs.readdirSync(THUMBS_DIR).filter(f => f.startsWith(`${hash}_sprite_`) && f.endsWith('.jpg'));
        for(const oldSprite of oldSprites) {
            try { fs.unlinkSync(path.join(THUMBS_DIR, oldSprite)); } catch {}
        }
        const oldSingleSprite = path.join(THUMBS_DIR, `${hash}_sprite.jpg`);
        if(fs.existsSync(oldSingleSprite)) try { fs.unlinkSync(oldSingleSprite); } catch {}


        const tempDir = path.join(THUMBS_DIR, `temp_${hash}`);
        try {
            // 1. Create temp dir
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
            fs.mkdirSync(tempDir, { recursive: true });

            // 2. Use ffmpeg to extract frames (with fallbacks)
            logger.info(`[SPRITE] Extracting frames with ffmpeg...`);
            const filtersToTry = [
                `format=yuv420p,fps=1/${SPRITE_INTERVAL_SEC},scale=${SPRITE_THUMB_WIDTH}:-1`,
                `zscale=matrixin=bt709,format=yuv420p,fps=1/${SPRITE_INTERVAL_SEC},scale=${SPRITE_THUMB_WIDTH}:-1`,
                `fps=1/${SPRITE_INTERVAL_SEC},scale=${SPRITE_THUMB_WIDTH}:-1` // Original as last resort
            ];
            let success = false;
            for (const vf of filtersToTry) {
                try {
                    const ffmpegArgs = [
                        '-i', videoFullPath,
                        '-vf', vf,
                        '-q:v', '8',
                        path.join(tempDir, 'thumb_%04d.jpg')
                    ];
                    await run(FFMPEG_PATH, ffmpegArgs);
                    success = true;
                    logger.info(`[SPRITE] ffmpeg succeeded with filter: ${vf}`);
                    break;
                } catch (e) {
                    logger.warn(`[SPRITE] ffmpeg failed with filter: ${vf}. Trying next fallback.`);
                }
            }
            if (!success) throw new Error('All ffmpeg fallback filters failed.');


            const frames = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg')).sort();
            if (frames.length === 0) {
                throw new Error('ffmpeg extracted no frames.');
            }
            logger.info(`[SPRITE] Extracted ${frames.length} frames.`);

            // 3. Stitch frames into sprite sheets, handling JPEG size limits
            const firstFramePath = path.join(tempDir, frames[0]);
            const metadata = await sharp(firstFramePath).metadata();
            const thumbWidth = metadata.width;
            const thumbHeight = metadata.height;
            
            const JPEG_MAX_DIMENSION = 65535;
            const maxFramesPerSprite = Math.floor(JPEG_MAX_DIMENSION / thumbWidth);
            
            const frameChunks = [];
            for (let i = 0; i < frames.length; i += maxFramesPerSprite) {
                frameChunks.push(frames.slice(i, i + maxFramesPerSprite));
            }

            if (frameChunks.length > 1) {
                logger.info(`[SPRITE] Video requires ${frameChunks.length} sprite sheets due to JPEG size limits.`);
            }

            let vttContent = 'WEBVTT\n\n';

            for (const [chunkIndex, frameChunk] of frameChunks.entries()) {
                const isMultiSprite = frameChunks.length > 1;
                const spriteFileName = isMultiSprite ? `${hash}_sprite_${chunkIndex + 1}.jpg` : `${hash}_sprite.jpg`;
                const currentSpritePath = path.join(THUMBS_DIR, spriteFileName);
                const totalWidth = thumbWidth * frameChunk.length;

                logger.info(`[SPRITE] Generating sheet #${chunkIndex + 1} with ${frameChunk.length} frames...`);

                const compositeOps = frameChunk.map((frame, index) => ({
                    input: path.join(tempDir, frame),
                    left: index * thumbWidth,
                    top: 0,
                }));

                await sharp({
                    create: { width: totalWidth, height: thumbHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
                })
                .composite(compositeOps)
                .jpeg({ quality: 75 })
                .toFile(currentSpritePath);

                // Append to VTT file for this chunk
                for (let i = 0; i < frameChunk.length; i++) {
                    const globalFrameIndex = (chunkIndex * maxFramesPerSprite) + i;
                    const startTime = globalFrameIndex * SPRITE_INTERVAL_SEC;
                    const endTime = startTime + SPRITE_INTERVAL_SEC;
                    const x = i * thumbWidth;
                    vttContent += `${formatVttTime(startTime)} --> ${formatVttTime(endTime)}\n`;
                    vttContent += `${spriteFileName}#xywh=${x},0,${thumbWidth},${thumbHeight}\n\n`;
                }
            }

            // 4. Write the single, complete VTT file
            fs.writeFileSync(spriteVttPath, vttContent, 'utf-8');
            logger.info(`[SPRITE] VTT file saved to ${spriteVttPath}`);

        } catch (error) {
            logger.error(`[SPRITE] Failed to process ${relPath}: ${error.message}`);
        } finally {
            // 5. Clean up temp dir
            if (fs.existsSync(tempDir)) {
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                } catch (e) {
                    logger.warn(`[SPRITE] Failed to clean up temp directory ${tempDir}: ${e.message}`);
                }
            }
        }
    }
    logger.info('[SPRITE] Sprite generation process finished.');
}

generateSprites().catch(err => {
    logger.error('[SPRITE] A fatal error occurred:', err);
    process.exit(1);
});
