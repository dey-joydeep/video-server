import fs from 'fs';
import path from 'path';
import config from './config.js';
import { SUPPORTED_VIDEO_EXTENSIONS } from './constants.js';

import { loadIndex } from './db.js';

/**
 * Removes the file extension from a filename.
 * @param {string} name - The filename.
 * @returns {string} The filename without its extension.
 */
export function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * Lists all video files in the configured VIDEO_ROOT, enriching them with metadata from the index.
 * @returns {Array<object>} An array of video objects with their metadata.
 */
export function listAllVideos() {
  const { byRel } = loadIndex();
  const out = [];

  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (!SUPPORTED_VIDEO_EXTENSIONS.has(ext)) continue;

      const stat = fs.statSync(full);
      const rel = path.relative(config.VIDEO_ROOT, full).replaceAll('\\', '/');
      const rec = byRel[rel] || {};
      out.push({
        id: rec.hash || null,
        name: stripExt(ent.name),
        rel,
        mtimeMs: stat.mtimeMs,
        durationMs: rec.durationMs ?? null,
        thumb: rec.thumb ?? (rec.hash ? `${rec.hash}.jpg` : null),
      });
    }
  };
  walk(config.VIDEO_ROOT);

  out.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );
  return out;
}
