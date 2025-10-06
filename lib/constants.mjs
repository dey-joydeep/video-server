// NOTE: This file is for STABLE application constants.
// For environment-specific settings, use .env and config.mjs.

export const LOGGING = Object.freeze({
    ROOT_LOG_FILENAME_PREFIX: 'video_server_',
    TOOL_LOG_FILENAME_PREFIXES: Object.freeze({
        SYNC: 'sync_',
        GEN_CLIPS: 'gen_clips_',
        GEN_SPRITE: 'gen_sprite_',
        GEN_THUMBS: 'gen_thumbs_',
    }),
});

export const HLS = Object.freeze({
    TRANSCODE_PRESET: {
        // for live preview hover
        PREVIEW: 'superfast',
        // for full playback
        DEFAULT: 'veryfast',
    },
    TRANSCODE_CRF: {
        // for live preview hover
        PREVIEW: '28',
        // for full playback
        DEFAULT: '21',
    },
});

export const SUPPORTED_VIDEO_EXTENSIONS = Object.freeze(
    new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi'])
);
