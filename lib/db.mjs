import * as fs from 'node:fs';
import * as path from 'node:path';

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

export function saveIndex(DATA_DIR, db) {
    const indexPath = path.join(DATA_DIR, 'thumbs-index.json');
    db.updatedAt = new Date().toISOString();
    fs.writeFileSync(indexPath, JSON.stringify(db, null, 2), 'utf-8');
}
