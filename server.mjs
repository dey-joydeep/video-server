import express from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import dotenv from 'dotenv';
import mime from 'mime';
import { fileURLToPath } from 'node:url';
import { runSync } from './tools/sync.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---- Env / paths ----
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || '');
if (!VIDEO_ROOT) {
  console.error('ERROR: VIDEO_ROOT is not set in .env');
  process.exit(1);
}
const BIND = process.env.BIND || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '8200', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const THUMBS_DIR = path.resolve(process.env.THUMBS_DIR || path.join(__dirname, 'thumbs'));
const AUTO_SYNC_ON_START = (process.env.AUTO_SYNC_ON_START || '1') === '1';

// Ensure dirs
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

// Static: UI and thumbs
app.use('/thumbs', express.static(THUMBS_DIR));
app.use('/', express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// API: list videos (reads JSON index)
app.get('/api/list', (req, res) => {
  try {
    const indexPath = path.join(DATA_DIR, 'thumbs-index.json');
    if (!fs.existsSync(indexPath)) return res.json({ files: [], root: VIDEO_ROOT });
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    res.json({ files: data.files || {}, root: data.videoRoot || VIDEO_ROOT });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read index' });
  }
});

// Streaming endpoint (RegExp route to avoid path-to-regexp pitfalls)
app.get(/^\/video\/(.+)$/, (req, res) => {
  const rel = req.params[0];
  const filePath = path.join(VIDEO_ROOT, rel);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(VIDEO_ROOT))) return res.sendStatus(403);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return res.sendStatus(404);

  const stat = fs.statSync(resolved);
  const fileSize = stat.size;
  const contentType = mime.getType(resolved) || 'application/octet-stream';
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(resolved).pipe(res);
    return;
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return res.status(416).end();
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
  if (start >= fileSize || end >= fileSize) return res.status(416).end();

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(resolved, { start, end }).pipe(res);
});

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Start (optionally sync first)
const start = async () => {
  if (AUTO_SYNC_ON_START) {
    console.log('🔄 Running initial sync...');
    try {
      await runSync({ VIDEO_ROOT, DATA_DIR, THUMBS_DIR });
      console.log('✅ Sync complete.');
    } catch (e) {
      console.error('❌ Sync failed:', e.message);
    }
  }
  app.listen(PORT, BIND, () => {
    console.log(`📺 Serving ${VIDEO_ROOT} at http://${BIND}:${PORT}`);
  });
};
start();
