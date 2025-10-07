import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Loads the video index from a JSON file.
 * If the file does not exist or is invalid, it returns a new, empty index.
 * @param {string} DATA_DIR - The directory where the index file is located.
 * @param {string} videoRoot - The root directory of the video library.
 * @returns {object} The loaded or newly created video index.
 */
export function loadIndex(DATA_DIR, videoRoot) {
    const indexPath = path.join(DATA_DIR, 'thumbs-index.json');
    if (!fs.existsSync(indexPath)) {
        return { version: 1, updatedAt: null, videoRoot, files: {} };
    }
    try {
        const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        if (!data.files) data.files = {};
        if (!data.videoRoot) data.videoRoot = videoRoot;
        return data;
    } catch {
        return { version: 1, updatedAt: null, videoRoot, files: {} };
    }
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
