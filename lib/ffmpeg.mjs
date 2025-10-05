// E:\workspace\video-server\lib\ffmpeg.mjs
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const THUMB_DEBUG = String(process.env.THUMB_DEBUG || '0') === '1';

export function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

export function ffprobeDurationMs(filePath) {
    return new Promise((resolve) => {
        const p = spawn(
            FFPROBE,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-v',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'default=nokey=1:noprint_wrappers=1',
                filePath,
            ],
            { windowsHide: true }
        );

        let out = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.on('close', () => {
            const seconds = parseFloat(out.trim());
            if (isNaN(seconds)) return resolve(null);
            resolve(Math.floor(seconds * 1000));
        });
        p.on('error', () => resolve(null));
    });
}

/**
 * Try to extract a single JPEG frame robustly.
 * Strategy:
 *  - Try multiple seek positions (10% of duration, atSec, 0.5s).
 *  - Try multiple filter pipelines/pixel formats to dodge swscale/encoder quirks.
 */
export async function generateThumb({
    filePath,
    outPath,
    width = 320,
    atSec = 3,
}) {
    ensureDir(path.dirname(outPath));
    if (fs.existsSync(outPath)) {
        // If a previous failed run left a 0-byte file, remove it so we can retry
        try {
            if (fs.statSync(outPath).size === 0) fs.unlinkSync(outPath);
        } catch {
            /* Ignored */
        }
    }
    if (fs.existsSync(outPath)) return outPath;

    // Positions to try (seconds)
    const positions = [];
    const durMs = await ffprobeDurationMs(filePath);
    if (durMs && isFinite(durMs) && durMs > 0) {
        const tenPct = Math.max(
            1,
            Math.min((durMs / 1000) * 0.1, Math.max(atSec, 1))
        );
        positions.push(tenPct);
    }
    positions.push(Math.max(0.5, atSec), 0.5);

    // Pipelines to try (ordered: ones that worked for your file are first)
    const attempts = [
        // 1) Force-tag colorspace to bt709, then normalize and scale to yuv420p
        {
            vf: `colorspace=iall=bt709:all=bt709:fast=1,format=yuv420p,scale=${width}:-2`,
            pix: null,
        },

        // 2) Same but to RGB (some odd encoders prefer RGB path)
        {
            vf: `colorspace=iall=bt709:all=bt709:fast=1,format=rgb24,scale=${width}:-2`,
            pix: 'rgb24',
        },

        // 3) Representative frame then scale (when timestamps are messy)
        { vf: `thumbnail,format=rgb24,scale=${width}:-2`, pix: 'rgb24' },

        // 4) Frame-count fallback: pick every 25th frame
        {
            vf: `select=not(mod(n\\,25)),format=rgb24,scale=${width}:-2`,
            pix: 'rgb24',
        },

        // 5) (Optional) keep zscale as a last resort; it failed on your clip but helps some others
        {
            vf: `zscale=matrixin=bt709:transferin=bt709:primariesin=bt709,format=rgb24,scale=${width}:-2`,
            pix: 'rgb24',
        },
    ];

    let lastErr = '';
    for (const pos of positions) {
        for (const { vf, pix } of attempts) {
            const args = [
                '-hide_banner',
                '-loglevel',
                'error',
                '-nostdin',
                '-y',
                '-ss',
                String(pos),
                '-i',
                filePath,
                '-frames:v',
                '1',
                '-vf',
                vf,
            ];
            if (pix) args.push('-pix_fmt', pix);
            args.push(outPath);

            if (THUMB_DEBUG) console.log('[ffmpeg-thumb]', args.join(' '));

            try {
                await run(FFMPEG, args);
                const st = fs.statSync(outPath);
                if (st.size > 0) return outPath;
                // very rare: created but empty
                fs.unlinkSync(outPath);
                lastErr = 'output file empty';
            } catch (e) {
                lastErr = e.message || 'unknown ffmpeg error';
            }
        }
    }
    throw new Error(`ffmpeg failed: ${lastErr}`);
}

/** Spawn helper capturing stderr so we get real reasons. */
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
