// E:\workspace\video-server\tools\sync.mjs
// Incremental sync: scan VIDEO_ROOT, detect renames, generate thumbs, update JSON DB.
// Keeps a single fixed progress line at the top; prints file logs beneath it.
// Distinguishes cached (pre-run) vs duplicate (same hash seen earlier this run).

import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';

import { loadIndex, saveIndex } from '../lib/db.mjs';
import { walkVideos } from '../lib/scan.mjs';
import { hashFile } from '../lib/hash.mjs';
import { generateThumb } from '../lib/ffmpeg.mjs';

const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

function ffprobeDurationMs(filePath) {
    return new Promise((resolve, reject) => {
        const p = spawn(
            FFPROBE_PATH,
            [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=nokey=1:noprint_wrappers=1',
                filePath,
            ],
            { windowsHide: true }
        );
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('close', (code) => {
            if (code !== 0) return reject(new Error(err.trim()));
            const seconds = parseFloat(out.trim());
            if (isNaN(seconds)) return resolve(null);
            resolve(Math.floor(seconds * 1000));
        });
        p.on('error', (e) => reject(e));
    });
}

dotenv.config();

// ---- Progress line helpers (keeps one status line at the top) ----
let _linesPrinted = 0; // number of log lines printed under the status

function printInitialStatus(total) {
    const line = `Progress: 0% (0/${total}) | new:0 cached:0 dup:0 renamed:0 errors:0`;
    process.stdout.write(line + '\n'); // status occupies line 1
}

function updateStatus({
    done,
    total,
    generated,
    cached,
    dupes,
    renamed,
    errors,
}) {
    const linesToMoveUp = _linesPrinted + 1; // status line + printed logs
    try {
        readline.moveCursor(process.stdout, 0, -linesToMoveUp);
        readline.clearLine(process.stdout, 0);
    } catch {}
    const percent = Math.floor((done / Math.max(total, 1)) * 100);
    const line =
        `Progress: ${String(percent).padStart(3, ' ')}% (${done}/${total}) | ` +
        `new:${generated} cached:${cached} dup:${dupes} renamed:${renamed} errors:${errors}`;
    process.stdout.write(line + '\n');
    try {
        readline.moveCursor(process.stdout, 0, _linesPrinted);
    } catch {}
}

/** Write one or many lines *below* the status, bumping the line count accurately. */
function logLine(s) {
    const text = String(s ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    const parts = text.split('\n');
    for (const p of parts) {
        if (p.length === 0) continue; // skip empty trailing line
        process.stdout.write(p + '\n');
        _linesPrinted += 1;
    }
}

export async function runSync(opts = {}) {
    const VIDEO_ROOT = path.resolve(
        opts.VIDEO_ROOT || process.env.VIDEO_ROOT || ''
    );
    if (!VIDEO_ROOT) throw new Error('VIDEO_ROOT not set');

    const DATA_DIR = path.resolve(
        opts.DATA_DIR ||
            process.env.DATA_DIR ||
            path.join(process.cwd(), 'data')
    );
    const THUMBS_DIR = path.resolve(
        opts.THUMBS_DIR ||
            process.env.THUMBS_DIR ||
            path.join(process.cwd(), 'thumbs')
    );
    const THUMB_WIDTH = parseInt(process.env.THUMB_WIDTH || '320', 10);
    const THUMB_AT_SECONDS = parseFloat(process.env.THUMB_AT_SECONDS || '3');

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(THUMBS_DIR, { recursive: true });

    const db = loadIndex(DATA_DIR, VIDEO_ROOT);
    const oldFiles = db.files || {};

    // ---- Pre-scan (stable order) so we know totals for progress
    const filesNow = [];
    for (const item of walkVideos(VIDEO_ROOT)) filesNow.push(item);
    filesNow.sort((a, b) =>
        a.rel.localeCompare(b.rel, undefined, { numeric: true })
    );

    const total = filesNow.length;
    const t0 = Date.now();

    let completed = 0;
    let generated = 0;
    let cached = 0; // present before this run
    let dupes = 0; // created earlier in this run for same hash
    let renamed = 0;
    let errors = 0;

    const seenPaths = new Set();

    // Reverse map old hash -> paths (helps detect renames)
    const oldHashToPaths = new Map();
    for (const [p, rec] of Object.entries(oldFiles)) {
        if (!rec?.hash) continue;
        if (!oldHashToPaths.has(rec.hash)) oldHashToPaths.set(rec.hash, []);
        oldHashToPaths.get(rec.hash).push(p);
    }

    // Snapshot: which thumbs existed before this run?
    const thumbsBefore = new Set();
    for (const f of fs.readdirSync(THUMBS_DIR, { withFileTypes: true })) {
        if (f.isFile() && f.name.toLowerCase().endsWith('.jpg'))
            thumbsBefore.add(f.name);
    }

    // Track first file path seen for a given content hash within this run
    const seenHashFirstRel = new Map(); // hash -> first relative path

    // Print the fixed status line once
    printInitialStatus(total);

    // ---- Main pass
    for (let i = 0; i < total; i++) {
        const { rel, full, size, mtimeMs } = filesNow[i];
        seenPaths.add(rel);

        logLine(`• Processing ${rel}`);

        const existing = oldFiles[rel];

        // Decide whether we need to hash the file (fast-path if unchanged)
        let fileHash = existing?.hash ?? null;
        let needHash = true;

        if (
            existing &&
            existing.size === size &&
            existing.mtimeMs === mtimeMs
        ) {
            fileHash = existing.hash;
            needHash = false;
        }

        if (needHash) {
            try {
                fileHash = await hashFile(full);
            } catch (e) {
                errors++;
                const lines = String(e?.message || 'hash failed')
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .split('\n');
                logLine(`⚠️  Hash failed for ${rel} - ${lines[0]}`);
                for (let j = 1; j < lines.length; j++)
                    logLine(`    ${lines[j]}`);
                completed++;
                updateStatus({
                    done: completed,
                    total,
                    generated,
                    cached,
                    dupes,
                    renamed,
                    errors,
                });
                continue; // can't proceed without a hash
            }
        }

        // Detect rename: new path not in old index, but same hash existed on a path that is now gone
        if (!existing) {
            const prevPaths = oldHashToPaths.get(fileHash) || [];
            const candidates = prevPaths.filter(
                (p) =>
                    !seenPaths.has(p) &&
                    !fs.existsSync(path.join(VIDEO_ROOT, p))
            );
            if (candidates.length > 0) {
                const oldPath = candidates[0];
                const oldRec = oldFiles[oldPath];
                delete oldFiles[oldPath];
                oldFiles[rel] = { ...oldRec, size, mtimeMs }; // keep same hash & thumb
                renamed++;
                logLine(`↪️  Renamed: ${oldPath} → ${rel}`);
                completed++;
                updateStatus({
                    done: completed,
                    total,
                    generated,
                    cached,
                    dupes,
                    renamed,
                    errors,
                });
                continue;
            }
        }

        // Ensure thumbnail exists (by hash, one thumb shared for duplicates)
        const thumbName = `${fileHash}.jpg`;
        const thumbPath = path.join(THUMBS_DIR, thumbName);

        // Mark first time we see this content in this run
        if (!seenHashFirstRel.has(fileHash)) {
            seenHashFirstRel.set(fileHash, rel);
        }

        if (!fs.existsSync(thumbPath)) {
            // No file on disk yet: either it's the first time for this content,
            // or we haven't generated it yet (should be first occurrence).
            try {
                logLine(`• Generating thumbnail for ${rel}`);
                await generateThumb({
                    filePath: full,
                    hash: fileHash,
                    thumbsDir: THUMBS_DIR,
                    width: THUMB_WIDTH,
                    atSec: THUMB_AT_SECONDS,
                });
                generated++;
            } catch (e) {
                errors++;
                const lines = String(e?.message || 'ffmpeg failed')
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .split('\n');
                logLine(`⚠️  Thumbnail failed for ${rel} - ${lines[0]}`);
                for (let j = 1; j < lines.length; j++)
                    logLine(`    ${lines[j]}`);
                // continue; we’ll still record the file without a thumb
            }
        } else {
            // Thumb file exists on disk. Distinguish cached vs duplicate.
            if (thumbsBefore.has(thumbName)) {
                cached++;
                logLine(`✓ Cached (pre-run) thumbnail for ${rel}`);
            } else {
                dupes++;
                const firstRel =
                    seenHashFirstRel.get(fileHash) || '(earlier file in run)';
                logLine(
                    `↔️  Duplicate content: ${rel} reuses thumbnail from ${firstRel} (hash ${fileHash.slice(
                        0,
                        8
                    )}…)`
                );
            }
        }

        // Upsert record
        let durationMs = existing?.durationMs ?? null;
        if (durationMs === null) {
            try {
                logLine(`• Probing duration for ${rel}`);
                durationMs = await ffprobeDurationMs(full);
            } catch (e) {
                logLine(`⚠️  ffprobe failed for ${rel}: ${e.message}`);
            }
        }

        const rec = { hash: fileHash, size, mtimeMs, durationMs };
        if (fs.existsSync(thumbPath)) rec.thumb = thumbName;
        oldFiles[rel] = rec;

        // Finished this file
        completed++;
        updateStatus({
            done: completed,
            total,
            generated,
            cached,
            dupes,
            renamed,
            errors,
        });
    }

    // Prune records for files that have vanished
    for (const p of Object.keys(oldFiles)) {
        if (!seenPaths.has(p)) delete oldFiles[p];
    }

    db.files = oldFiles;
    saveIndex(DATA_DIR, db);

    // Final status refresh and summary
    updateStatus({
        done: completed,
        total,
        generated,
        cached,
        dupes,
        renamed,
        errors,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    logLine(
        `✅ Sync complete in ${dt}s: files=${completed}, new=${generated}, cached=${cached}, dup=${dupes}, renamed=${renamed}, errors=${errors}`
    );

    return db;
}

// ---- Self-run (Windows-safe main-module check)
if (process.argv[1]) {
    const thisFile = fileURLToPath(import.meta.url);
    const invoked = path.resolve(process.argv[1]);
    if (thisFile === invoked) {
        runSync()
            .then(() => {
                /* done */
            })
            .catch((err) => {
                console.error('Sync failed:', err);
                process.exit(1);
            });
    }
}
