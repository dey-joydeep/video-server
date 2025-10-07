import * as fs from 'node:fs';
import * as path from 'node:path';

/** @constant {Set<string>} VIDEO_EXTS - A set of supported video file extensions. */
const VIDEO_EXTS = new Set([
    '.mp4',
    '.mkv',
    '.webm',
    '.mov',
    '.m4v',
    '.avi',
    '.wmv',
    '.flv',
]);

/**
 * Recursively walks a directory and yields information about video files found.
 * @param {string} root - The root directory to start walking from.
 * @yields {{rel: string, full: string, size: number, mtimeMs: number}} An object containing relative path, full path, size, and last modified time of a video file.
 */
export function* walkVideos(root) {
    const stack = [root];
    const rootResolved = path.resolve(root);
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
            } else {
                const ext = path.extname(ent.name).toLowerCase();
                if (VIDEO_EXTS.has(ext)) {
                    const rel = path
                        .relative(rootResolved, full)
                        .split(path.sep)
                        .join('/');
                    let stat;
                    try {
                        stat = fs.statSync(full);
                    } catch {
                        continue;
                    }
                    yield { rel, full, size: stat.size, mtimeMs: stat.mtimeMs };
                }
            }
        }
    }
}
