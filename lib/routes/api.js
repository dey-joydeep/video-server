import express from 'express';
import fs from 'fs';
import path from 'path';
import config from '../config.js';

/**
 * Creates an Express router for API endpoints.
 * @param {object} options - The options for creating the router.
 * @param {function(string): {status: string, hlsUrl?: string}} options.getHlsJobStatus - A function to get the status of an HLS job.
 * @param {function(): {byId: object, byRel: object}} options.loadIndex - A function to load the video index.
 * @param {function(string): Promise<number>} options.ffprobeDurationMs - A function to get the duration of a video.
 * @param {function(): Array<object>} options.listAllVideos - A function to list all videos.
 * @returns {express.Router} The Express router.
 */
const createApiRouter = (services) => {
  const router = express.Router();

  /**
   * @swagger
   * /api/list:
   *   get:
   *     summary: Lists videos with search and pagination.
   *     parameters:
   *       - in: query
   *         name: q
   *         schema:
   *           type: string
   *         description: Search query.
   *       - in: query
   *         name: sort
   *         schema:
   *           type: string
   *         description: Sort order.
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *         description: Offset for pagination.
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *         description: Limit for pagination.
   *     responses:
   *       200:
   *         description: A list of videos.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 total:
   *                   type: integer
   *                 offset:
   *                   type: integer
   *                 limit:
   *                   type: integer
   *                 items:
   *                   type: array
   *                   items:
   *                     type: object
   */
  router.get('/list', (req, res) => {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const sort = (req.query.sort || 'name-asc').toString();
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    const limit = Math.max(
      Math.min(parseInt(req.query.limit || '21', 10), 200),
      1
    );

    let items = services.video.listAll();
    if (q) items = items.filter((v) => v.name.toLowerCase().includes(q));

    const [key, dir] = sort.split('-');
    const mul = dir === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      if (key === 'name')
        return a.name.localeCompare(b.name, undefined, { numeric: true }) * mul;
      if (key === 'date') return (a.mtimeMs - b.mtimeMs) * mul;
      return 0;
    });

    const total = items.length;
    const page = items
      .slice(offset, offset + limit)
      .map(({ id, name, mtimeMs, durationMs }) => {
        const item = { id, name, mtimeMs, durationMs };
        if (id) {
          const assetDir = path.join(config.THUMBS_DIR, id);
          const thumbPath = path.join(
            assetDir,
            `${id}${process.env.SUFFIX_THUMB || '_thumb.jpg'}`
          );
          if (fs.existsSync(thumbPath)) {
            item.thumb = `${id}/${id}${process.env.SUFFIX_THUMB || '_thumb.jpg'}`;
          }

          const clipPath = path.join(
            assetDir,
            `${id}${process.env.SUFFIX_PREVIEW_CLIP || '_preview.mp4'}`
          );
          if (fs.existsSync(clipPath)) {
            item.previewClip = `/thumbs/${id}/${id}${
              process.env.SUFFIX_PREVIEW_CLIP || '_preview.mp4'
            }`;
          }
        }
        return item;
      });
    res.json({ total, offset, limit, items: page });
  });

  /**
   * @swagger
   * /api/meta:
   *   get:
   *     summary: Gets metadata for a single video.
   *     parameters:
   *       - in: query
   *         name: id
   *         schema:
   *           type: string
   *         description: The ID of the video.
   *       - in: query
   *         name: f
   *         schema:
   *           type: string
   *         description: Legacy parameter for the relative path of the video.
   *     responses:
   *       200:
   *         description: The video metadata.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *       400:
   *         description: Missing ID.
   *       403:
   *         description: Forbidden.
   *       404:
   *         description: Not found.
   */
  router.get('/meta', async (req, res) => {
    const id = (req.query.id || '').toString();
    const f = (req.query.f || '').toString();
    const { byId, byRel } = services.db.loadIndex();
    let rel = null;
    let hash = null;

    if (id) {
      rel = byId[id];
      hash = id;
    }
    if (!rel && f && f !== 'undefined') {
      rel = f;
      const rec = byRel[f] || {};
      hash = rec.hash || null;
    }

    if (!rel) return res.status(400).json({ error: 'missing id' });

    const abs = path.resolve(path.join(config.VIDEO_ROOT, rel));
    if (!abs.startsWith(config.VIDEO_ROOT)) return res.sendStatus(403);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
      return res.sendStatus(404);

    const stat = fs.statSync(abs);
    let durationMs = null;
    try {
      durationMs = await services.video.getDuration(abs);
    } catch {
      /* Ignored */
    }

    const response = { id: hash, mtimeMs: stat.mtimeMs, durationMs };

    if (hash) {
      const vttPath = path.join(
        config.THUMBS_DIR,
        hash,
        `${hash}${process.env.SUFFIX_SPRITE_VTT || '_sprite.vtt'}`
      );
      if (fs.existsSync(vttPath)) {
        response.sprite = `/thumbs/${hash}/${hash}${
          process.env.SUFFIX_SPRITE_VTT || '_sprite.vtt'
        }`;
      }
    }

    res.json(response);
  });

  /**
   * @swagger
   * /api/session/status:
   *   get:
   *     summary: Gets the status of an HLS session.
   *     parameters:
   *       - in: query
   *         name: token
   *         schema:
   *           type: string
   *         description: The session token.
   *     responses:
   *       200:
   *         description: The session status.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                 hlsUrl:
   *                   type: string
   */
  router.get('/session/status', (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'missing token' });
    }
    const status = services.hls.getJobStatus(token);
    if (
      !config.isProduction ||
      process.env.DEBUG_HLS === '1' ||
      process.env.DEBUG_HLS === 'true'
    ) {
      try {
        console.log('[SSE][status]', token, status);
      } catch {
        /* ignore */
      }
    }
    res.json(status);
  });

  // Server-Sent Events: stream session status changes for a token
  router.get('/session/events', (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).end();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try {
      services.hls.addWatcher && services.hls.addWatcher(token);
    } catch {
      /* ignore */
    }

    let last = null;
    const send = (obj) => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        // ignore write errors
      }
    };

    // send initial status
    try {
      last = services.hls.getJobStatus(token) || null;
      if (last) send(last);
    } catch {
      /* ignore */
    }

    const interval = setInterval(() => {
      try {
        const cur = services.hls.getJobStatus(token);
        if (!cur) return;
        if (!last || cur.status !== last.status || cur.hlsUrl !== last.hlsUrl) {
          last = cur;
          send(cur);
          if (
            !config.isProduction ||
            process.env.DEBUG_HLS === '1' ||
            process.env.DEBUG_HLS === 'true'
          ) {
            try {
              console.log('[SSE][tick]', token, cur);
            } catch {
              /* ignore */
            }
          }
          if (cur.status === 'ready') {
            clearInterval(interval);
            res.end();
          }
        }
      } catch {
        // ignore
      }
    }, 500);

    req.on('close', () => {
      clearInterval(interval);
      try {
        services.hls.removeWatcher && services.hls.removeWatcher(token);
      } catch {
        /* ignore */
      }
      if (
        !config.isProduction ||
        process.env.DEBUG_HLS === '1' ||
        process.env.DEBUG_HLS === 'true'
      ) {
        try {
          console.log('[SSE][close]', token);
        } catch {
          /* ignore */
        }
      }
    });
  });

  return router;
};

export default createApiRouter;
