import dotenv from 'dotenv';
import path from 'path';

// Load .env file at the absolute top
dotenv.config();

const CWD = process.cwd();

const config = {
    // Server
    PORT: parseInt(process.env.PORT || '8200', 10),
    BIND: process.env.BIND || '0.0.0.0',

    // Paths
    VIDEO_ROOT: path.resolve(process.env.VIDEO_ROOT || CWD),
    DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(CWD, 'data')),
    THUMBS_DIR: path.resolve(
        process.env.THUMBS_DIR || path.join(CWD, 'thumbs')
    ),
    LOGS_DIR: path.resolve(path.join(CWD, 'logs')),
    TOOLS_LOG_DIR: path.resolve(path.join(CWD, 'logs', 'tools-log')),

    // FFmpeg
    FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
    FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',

    // Thumbnail Settings
    THUMB_WIDTH: parseInt(process.env.THUMB_WIDTH || '320', 10),
    THUMB_AT_SECONDS: parseFloat(process.env.THUMB_AT_SECONDS || '3'),

    // HLS Settings
    HLS_DIR: path.resolve(process.env.HLS_DIR || path.join(CWD, '.hls')),
    HLS_SEG_SEC: parseInt(process.env.HLS_SEG_SEC || '4', 10),
    TOKEN_TTL_SEC: parseInt(process.env.TOKEN_TTL_SEC || '900', 10),
    TOKEN_PIN_IP: String(process.env.TOKEN_PIN_IP || 'true') === 'true',

    // Asset Suffixes
    SUFFIX_THUMB: process.env.SUFFIX_THUMB || '_thumb.jpg',
    SUFFIX_SPRITE_IMG: process.env.SUFFIX_SPRITE_IMG || '_sprite.jpg',
    SUFFIX_SPRITE_VTT: process.env.SUFFIX_SPRITE_VTT || '_sprite.vtt',
    SUFFIX_PREVIEW_CLIP: process.env.SUFFIX_PREVIEW_CLIP || '_preview.mp4',

    // Sprite Generation Tunables
    SPRITE_INTERVAL_SEC: Number(process.env.SPRITE_INTERVAL_SEC || 5),
    SPRITE_THUMB_WIDTH: Number(process.env.SPRITE_THUMB_WIDTH || 160),
    SPRITE_COLUMNS: Number(process.env.SPRITE_COLUMNS || 10),
    SPRITE_JPEG_QUALITY: Number(process.env.SPRITE_JPEG_QUALITY || 82),
};

// Freeze the object to prevent accidental modification elsewhere
export default Object.freeze(config);
