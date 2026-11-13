import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { ensureTempDir, purgeExpiredDirectories } from './server/cleanup.ts';
import { CONFIG, ensureYtDlpBinary } from './server/config.ts';
import { analyzeMediaUrl, getToolVersions } from './server/extractor.ts';
import {
  cancelJob,
  cleanupAllActiveJobs,
  createDownloadJob,
  getActiveJobCount,
  getAllJobIds,
  getJobOutputFile,
  getJobSnapshot,
  subscribeToJob,
} from './server/processor.ts';
import { isValidUuid, safeFetchPublic, validatePublicUrl } from './server/validators.ts';

async function startServer() {
  ensureTempDir();
  await ensureYtDlpBinary();
  purgeExpiredDirectories(new Set());

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/api/health', async (_req: Request, res: Response) => {
    const tools = await getToolVersions();
    res.json({
      status: 'ok',
      tools,
      activeJobs: getActiveJobCount(),
      limits: {
        maxFileSizeMb: CONFIG.maxFileSizeMb,
        maxDurationSec: CONFIG.maxDurationSec,
        maxConcurrentJobs: CONFIG.maxConcurrentJobs,
      },
    });
  });

  app.post('/api/analyze', async (req: Request, res: Response) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const validation = await validatePublicUrl(rawUrl);

    if (!validation.valid || !validation.normalizedUrl) {
      res.status(400).json({ error: validation.error || 'Invalid URL.' });
      return;
    }

    const rawCookies = typeof req.body?.cookiesText === 'string' ? req.body.cookiesText : null;
    if (rawCookies && rawCookies.length > 256 * 1024) {
      res.status(400).json({ error: 'Cookies text exceeds 256 KB safety limit.' });
      return;
    }

    try {
      const media = await analyzeMediaUrl(validation.normalizedUrl, rawCookies);
      res.json(media);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to analyze URL.';
      res.status(422).json({ error: message });
    }
  });

  app.get('/api/thumbnail', async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    const validation = await validatePublicUrl(rawUrl);
    if (!validation.valid || !validation.normalizedUrl) {
      res.status(400).end();
      return;
    }

    try {
      const upstream = await safeFetchPublic(validation.normalizedUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      });
      if (!upstream.ok) {
        res.status(404).end();
        return;
      }
      const contentType = upstream.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        res.status(415).end();
        return;
      }
      const arrayBuf = await upstream.arrayBuffer();
      if (arrayBuf.byteLength > 8 * 1024 * 1024) {
        res.status(413).end();
        return;
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(Buffer.from(arrayBuf));
    } catch {
      res.status(502).end();
    }
  });

  app.post('/api/jobs', async (req: Request, res: Response) => {
    const body = req.body || {};
    const validation = await validatePublicUrl(typeof body.url === 'string' ? body.url : '');
    if (!validation.valid || !validation.normalizedUrl) {
      res.status(400).json({ error: validation.error || 'Invalid URL.' });
      return;
    }

    const mode = body.mode === 'audio' ? 'audio' : 'video';
    const requestedContainer =
      typeof body.container === 'string' ? body.container.toLowerCase() : mode === 'audio' ? 'mp3' : 'mp4';

    const validContainers =
      mode === 'audio' ? CONFIG.allowedAudioContainers : CONFIG.allowedVideoContainers;
    if (!(validContainers as readonly string[]).includes(requestedContainer)) {
      res.status(400).json({ error: `Unsupported output format "${requestedContainer}".` });
      return;
    }

    const speed = Number(body.speed ?? 1);
    if (!(CONFIG.allowedSpeeds as readonly number[]).includes(speed)) {
      res.status(400).json({ error: 'Playback speed must be 0.5, 1, 1.5, 2, or 3.' });
      return;
    }

    const trimEnabled = Boolean(body.trim?.enabled);
    const trimStart = Number(body.trim?.start ?? 0);
    const trimEnd = Number(body.trim?.end ?? 0);

    if (trimEnabled) {
      if (!Number.isFinite(trimStart) || !Number.isFinite(trimEnd) || trimStart < 0 || trimEnd <= trimStart) {
        res.status(400).json({ error: 'Trim end time must be greater than start time.' });
        return;
      }
      if (trimEnd - trimStart > CONFIG.maxDurationSec) {
        res.status(400).json({
          error: `Trimmed segment exceeds maximum allowed duration (${CONFIG.maxDurationSec}s).`,
        });
        return;
      }
    }

    try {
      const snapshot = createDownloadJob({
        url: validation.normalizedUrl,
        title: typeof body.title === 'string' ? body.title : 'video',
        mode,
        formatId: typeof body.formatId === 'string' && body.formatId ? body.formatId : 'best',
        audioFormatId: typeof body.audioFormatId === 'string' ? body.audioFormatId : null,
        needsMerge: Boolean(body.needsMerge),
        container: requestedContainer,
        isDirectMedia: Boolean(body.isDirectMedia),
        duration: typeof body.duration === 'number' && Number.isFinite(body.duration) ? body.duration : null,
        trim: {
          enabled: trimEnabled,
          start: trimStart,
          end: trimEnd,
        },
        speed,
        cookiesText: typeof body.cookiesText === 'string' ? body.cookiesText.slice(0, 256 * 1024) : null,
      });

      res.status(202).json(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to start download job.';
      res.status(429).json({ error: msg });
    }
  });

  app.get('/api/jobs/:jobId', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId || '');
    if (!isValidUuid(jobId)) {
      res.status(400).json({ error: 'Invalid job identifier.' });
      return;
    }
    const snapshot = getJobSnapshot(jobId);
    if (!snapshot) {
      res.status(404).json({ error: 'Job not found or already expired.' });
      return;
    }
    res.json(snapshot);
  });

  app.get('/api/jobs/:jobId/events', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId || '');
    if (!isValidUuid(jobId)) {
      res.status(400).json({ error: 'Invalid job identifier.' });
      return;
    }
    const subscribed = subscribeToJob(jobId, res);
    if (!subscribed) {
      res.status(404).json({ error: 'Job not found or already expired.' });
    }
  });

  app.post('/api/jobs/:jobId/cancel', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId || '');
    if (!isValidUuid(jobId)) {
      res.status(400).json({ error: 'Invalid job identifier.' });
      return;
    }
    const ok = cancelJob(jobId);
    if (!ok) {
      res.status(404).json({ error: 'Active job not found.' });
      return;
    }
    res.json({ status: 'cancelled', jobId });
  });

  app.get('/api/jobs/:jobId/file', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId || '');
    if (!isValidUuid(jobId)) {
      res.status(400).json({ error: 'Invalid job identifier.' });
      return;
    }

    const fileInfo = getJobOutputFile(jobId);
    if (!fileInfo) {
      res.status(404).json({ error: 'File is not ready or has been cleaned up.' });
      return;
    }

    const ext = path.extname(fileInfo.filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';
    const encodedFilename = encodeURIComponent(fileInfo.filename);
    const asciiFallback =
      fileInfo.filename
        .replace(/[^\x20-\x7e]/g, '_')
        .replace(/["\\]/g, '_')
        .trim() || `download${ext}`;

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`
    );
    res.setHeader('Accept-Ranges', 'bytes');

    const streamFile = (start?: number, end?: number) => {
      const rs =
        start !== undefined && end !== undefined
          ? fs.createReadStream(fileInfo.path, { start, end })
          : fs.createReadStream(fileInfo.path);
      rs.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      rs.pipe(res);
    };

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (match && (match[1] !== '' || match[2] !== '')) {
        let start: number;
        let end: number;
        if (match[1] === '') {
          const suffixLen = Number.parseInt(match[2], 10);
          start = Math.max(0, fileInfo.size - suffixLen);
          end = fileInfo.size - 1;
        } else {
          start = Number.parseInt(match[1], 10);
          end = match[2]
            ? Math.min(Number.parseInt(match[2], 10), fileInfo.size - 1)
            : fileInfo.size - 1;
        }

        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < fileInfo.size) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${fileInfo.size}`);
          res.setHeader('Content-Length', String(end - start + 1));
          streamFile(start, end);
          return;
        }
        res.status(416);
        res.setHeader('Content-Range', `bytes */${fileInfo.size}`);
        res.end();
        return;
      }
    }

    res.setHeader('Content-Length', String(fileInfo.size));
    streamFile();
  });

  if (!CONFIG.isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const cleanupTimer = setInterval(() => {
    purgeExpiredDirectories(getAllJobIds());
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  const server = app.listen(CONFIG.port, '0.0.0.0', () => {
    console.log(`ClipFetch server listening on http://0.0.0.0:${CONFIG.port}`);
  });

  const shutdown = () => {
    clearInterval(cleanupTimer);
    cleanupAllActiveJobs();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void startServer();
