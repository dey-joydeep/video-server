import * as fs from 'node:fs';
import * as path from 'node:path';
import config from './config.js';

/** @constant {string} DB_PATH - The absolute path to the JSON database file. */
const DB_PATH = path.join(config.DATA_DIR, 'thumbs-index.json');

/**
 * Reads and parses a JSON file safely, returning a fallback value on error.
 * @param {string} p - The path to the JSON file.
 * @param {any} fallback - The value to return if the file cannot be read or parsed.
 * @returns {any} The parsed JSON data or the fallback value.
 */
function readJsonSafe(p, fallback) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return fallback;
    }
}

/**
 * Loads the video index, handling different data shapes and creating lookups.
 * @returns {{byRel: object, byId: object, raw: object}} An object containing video data indexed by relative path and by ID, and the raw database object.
 */
export function loadIndex() {
    const raw = readJsonSafe(DB_PATH, {});
    const byRel = {};
    const byId = {};

    if (raw && raw.files && typeof raw.files === 'object') {
        for (const [rel, rec] of Object.entries(raw.files)) {
            const r = rec || {};
            byRel[rel] = r;
            if (r.hash) byId[r.hash] = rel;
            if (r.id && !byId[r.id]) byId[r.id] = rel;
        }
    } else if (raw && Array.isArray(raw.items)) {
        for (const it of raw.items) {
            const rel = it.rel || it.relativePath || it.path || null;
            if (!rel) continue;
            const rec = {
                hash: it.id || it.hash || null,
                thumb: it.thumb || (it.id ? `${it.id}.jpg` : null),
                durationMs: it.durationMs ?? null,
                name: it.name || null,
            };
            byRel[rel] = rec;
            if (rec.hash) byId[rec.hash] = rel;
        }
    }
    return { byRel, byId, raw };
}

/**
 * Saves the video index to a JSON file.
 * Updates the `updatedAt` timestamp before saving.
 * @param {string} DATA_DIR - The directory where the index file will be saved.
 * @param {object} db - The video index object to save.
 */
export function saveIndex(DATA_DIR, db) {
    const indexPath = path.join(DATA_DIR, 'thumbs-index.json');
    db.updatedAt = new Date().toISOString();
    fs.writeFileSync(indexPath, JSON.stringify(db, null, 2), 'utf-8');
}
