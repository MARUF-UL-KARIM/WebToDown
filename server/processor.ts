import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { CONFIG } from './config.ts';
import { ensureTempDir, purgeExpiredDirectories, removeDirSafe } from './cleanup.ts';
import { safeFetchPublic, sanitizeFilename } from './validators.ts';

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'processing'
  | 'ready'
  | 'cancelled'
  | 'error';

export interface TrimConfig {
  enabled: boolean;
  start: number;
  end: number;
}

export interface CreateJobInput {
  url: string;
  title: string;
  mode: 'video' | 'audio';
  formatId: string;
  audioFormatId: string | null;
  needsMerge: boolean;
  container: string;
  isDirectMedia: boolean;
  duration: number | null;
  trim: TrimConfig;
  speed: number;
  cookiesText?: string | null;
}

export interface PublicJobSnapshot {
  jobId: string;
  status: JobStatus;
  phaseLabel: string;
  progress: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  speedText: string | null;
  etaText: string | null;
  filename: string | null;
  fileSize: number | null;
  downloadUrl: string | null;
  error: string | null;
  createdAt: number;
}

interface InternalJob extends PublicJobSnapshot {
  workDir: string;
  outputPath: string | null;
  activeChild: ChildProcess | null;
  abortController: AbortController | null;
  subscribers: Set<Response>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

const STANDARD_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const jobs = new Map<string, InternalJob>();

function toPublicSnapshot(job: InternalJob): PublicJobSnapshot {
  return {
    jobId: job.jobId,
    status: job.status,
    phaseLabel: job.phaseLabel,
    progress: job.progress,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speedText: job.speedText,
    etaText: job.etaText,
    filename: job.filename,
    fileSize: job.fileSize,
    downloadUrl: job.downloadUrl,
    error: job.error,
    createdAt: job.createdAt,
  };
}

function emitJobUpdate(job: InternalJob): void {
  const payload = `data: ${JSON.stringify(toPublicSnapshot(job))}\n\n`;
  for (const res of job.subscribers) {
    try {
      res.write(payload);
    } catch {
      job.subscribers.delete(res);
    }
  }
}

function scheduleJobCleanup(job: InternalJob): void {
  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
  }
  job.cleanupTimer = setTimeout(() => {
    removeDirSafe(job.workDir);
    jobs.delete(job.jobId);
  }, CONFIG.autoCleanupMinutes * 60 * 1000);
}

export function getAllJobIds(): Set<string> {
  return new Set(jobs.keys());
}

export function cleanupAllActiveJobs(): void {
  for (const job of jobs.values()) {
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    job.abortController?.abort();
    try {
      job.activeChild?.kill('SIGKILL');
    } catch {
      // Ignore
    }
    removeDirSafe(job.workDir);
  }
  jobs.clear();
}

export function getActiveJobCount(): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (
      job.status === 'queued' ||
      job.status === 'downloading' ||
      job.status === 'merging' ||
      job.status === 'processing'
    ) {
      count += 1;
    }
  }
  return count;
}

export function getJobSnapshot(jobId: string): PublicJobSnapshot | null {
  const job = jobs.get(jobId);
  return job ? toPublicSnapshot(job) : null;
}

export function getJobOutputFile(jobId: string): { path: string; filename: string; size: number } | null {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'ready' || !job.outputPath || !job.filename) {
    return null;
  }
  if (!fs.existsSync(job.outputPath)) {
    return null;
  }
  const stat = fs.statSync(job.outputPath);
  return {
    path: job.outputPath,
    filename: job.filename,
    size: stat.size,
  };
}

export function subscribeToJob(jobId: string, res: Response): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  job.subscribers.add(res);
  res.write(`data: ${JSON.stringify(toPublicSnapshot(job))}\n\n`);

  res.on('close', () => {
    job.subscribers.delete(res);
  });

  return true;
}

export function cancelJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;

  if (job.status === 'ready' || job.status === 'cancelled' || job.status === 'error') {
    removeDirSafe(job.workDir);
    if (job.status !== 'cancelled') {
      return false;
    }
    return true;
  }

  job.status = 'cancelled';
  job.phaseLabel = 'Cancelled by user';
  job.error = 'Download cancelled by user.';

  if (job.timeoutTimer) {
    clearTimeout(job.timeoutTimer);
    job.timeoutTimer = null;
  }

  if (job.abortController) {
    job.abortController.abort();
  }

  if (job.activeChild) {
    const child = job.activeChild;
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited
      }
    }, 1000);
  }

  emitJobUpdate(job);
  setTimeout(() => {
    removeDirSafe(job.workDir);
  }, 500);
  scheduleJobCleanup(job);
  return true;
}

function parseHumanSizeToBytes(sizeText: string): number | null {
  const match = sizeText.trim().match(/^([\d.]+)\s*(Ki?B|Mi?B|Gi?B|B)$/i);
  if (!match) return null;
  const val = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (!Number.isFinite(val)) return null;
  if (unit === 'B') return Math.round(val);
  if (unit === 'KB') return Math.round(val * 1000);
  if (unit === 'KIB') return Math.round(val * 1024);
  if (unit === 'MB') return Math.round(val * 1000 * 1000);
  if (unit === 'MIB') return Math.round(val * 1024 * 1024);
  if (unit === 'GB') return Math.round(val * 1000 * 1000 * 1000);
  if (unit === 'GIB') return Math.round(val * 1024 * 1024 * 1024);
  return null;
}

async function probeHasAudio(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(CONFIG.ffprobeBin, [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      filePath,
    ]);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    child.on('close', () => {
      resolve(out.trim().length > 0);
    });
    child.on('error', () => resolve(false));
  });
}

async function probeDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(CONFIG.ffprobeBin, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    child.on('close', () => {
      const val = Number.parseFloat(out.trim());
      resolve(Number.isFinite(val) && val > 0 ? val : null);
    });
    child.on('error', () => resolve(null));
  });
}

async function downloadDirectHttp(job: InternalJob, url: string, targetPath: string): Promise<void> {
  const controller = new AbortController();
  job.abortController = controller;

  const parsed = new URL(url);
  const userAgent = parsed.hostname.endsWith('wikimedia.org')
    ? 'ClipFetch/1.0 (+https://github.com/clipfetch)'
    : STANDARD_BROWSER_UA;

  const response = await safeFetchPublic(url, {
    headers: { 'User-Agent': userAgent },
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Remote server returned HTTP ${response.status} while downloading media.`);
  }

  const contentLengthHeader = response.headers.get('content-length');
  const totalBytes = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
  const maxBytes = CONFIG.maxFileSizeMb * 1024 * 1024;

  if (totalBytes && totalBytes > maxBytes) {
    controller.abort();
    await response.body.cancel().catch(() => {});
    throw new Error(
      `File size (${(totalBytes / (1024 * 1024)).toFixed(1)} MB) exceeds the ${CONFIG.maxFileSizeMb} MB limit.`
    );
  }

  job.totalBytes = totalBytes && Number.isFinite(totalBytes) ? totalBytes : null;
  job.downloadedBytes = 0;
  job.progress = totalBytes ? 0 : null;
  emitJobUpdate(job);

  const fileStream = fs.createWriteStream(targetPath);
  let streamError: Error | null = null;
  fileStream.on('error', (err) => {
    streamError = err;
  });

  const reader = response.body.getReader();
  let lastEmit = Date.now();
  let bytesSinceLast = 0;
  let lastSpeedCheck = Date.now();

  try {
    while (true) {
      if (job.status === 'cancelled') {
        await reader.cancel().catch(() => {});
        throw new Error('Download cancelled by user.');
      }
      if (streamError) {
        throw streamError;
      }

      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        job.downloadedBytes += value.byteLength;
        bytesSinceLast += value.byteLength;

        if (job.downloadedBytes > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw new Error(`Download aborted: file exceeded ${CONFIG.maxFileSizeMb} MB safety limit.`);
        }

        const ok = fileStream.write(value);
        if (!ok) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              fileStream.off('error', onErr);
              resolve();
            };
            const onErr = (err: Error) => {
              fileStream.off('drain', onDrain);
              reject(err);
            };
            fileStream.once('drain', onDrain);
            fileStream.once('error', onErr);
          });
        }

        const now = Date.now();
        if (now - lastEmit >= 250) {
          const dtSec = Math.max((now - lastSpeedCheck) / 1000, 0.1);
          const bps = bytesSinceLast / dtSec;
          job.speedText =
            bps > 1024 * 1024
              ? `${(bps / (1024 * 1024)).toFixed(2)} MB/s`
              : `${(bps / 1024).toFixed(0)} KB/s`;
          if (job.totalBytes && job.totalBytes > 0) {
            job.progress = Math.min(99, Math.round((job.downloadedBytes / job.totalBytes) * 100));
            const remaining = Math.max(0, job.totalBytes - job.downloadedBytes);
            if (bps > 0) {
              const etaSec = Math.round(remaining / bps);
              job.etaText = `${etaSec}s`;
            }
          }
          emitJobUpdate(job);
          lastEmit = now;
          bytesSinceLast = 0;
          lastSpeedCheck = now;
        }
      }
    }
    if (streamError) {
      throw streamError;
    }
  } finally {
    await new Promise<void>((resolve) => fileStream.end(() => resolve()));
    job.abortController = null;
  }
}

async function downloadWithYtDlp(
  job: InternalJob,
  input: CreateJobInput,
  outputTemplate: string
): Promise<string> {
  const args = [
    '--no-playlist',
    '--newline',
    '--progress',
    '--no-part',
    '--max-filesize',
    `${CONFIG.maxFileSizeMb}M`,
    '--user-agent',
    STANDARD_BROWSER_UA,
    '--ffmpeg-location',
    path.dirname(CONFIG.ffmpegBin),
    '-o',
    outputTemplate,
  ];

  if (CONFIG.nodeBin && fs.existsSync(CONFIG.nodeBin)) {
    args.push('--js-runtimes', `node:${CONFIG.nodeBin}`);
  }

  let ephemeralCookiesPath: string | null = null;
  if (input.cookiesText && input.cookiesText.trim().length > 0) {
    ephemeralCookiesPath = path.join(job.workDir, 'cookies.txt');
    fs.writeFileSync(ephemeralCookiesPath, input.cookiesText.trim() + '\n', { mode: 0o600 });
    args.push('--cookies', ephemeralCookiesPath);
  } else if (CONFIG.cookiesFile) {
    args.push('--cookies', CONFIG.cookiesFile);
  }

  if (input.mode === 'audio') {
    if (input.formatId && input.formatId !== 'best') {
      args.push('-f', `${input.formatId}/bestaudio/best`);
    } else {
      args.push('-f', 'bestaudio/best');
    }
  } else if (input.needsMerge && input.audioFormatId) {
    args.push('-f', `${input.formatId}+${input.audioFormatId}/bestvideo+bestaudio/best`);
    args.push('--merge-output-format', 'mp4');
  } else if (input.formatId && input.formatId !== 'best' && input.formatId !== 'direct') {
    args.push('-f', `${input.formatId}/best`);
  } else {
    args.push('-f', 'bestvideo+bestaudio/best');
  }

  args.push(input.url);

  try {
    await new Promise<void>((resolve, reject) => {
    const child = spawn(CONFIG.ytdlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.activeChild = child;

    let stderrBuffer = '';

    const handleLine = (line: string) => {
      if (job.status === 'cancelled') return;

      if (line.includes('[Merger]') || line.includes('Merging formats')) {
        job.status = 'merging';
        job.phaseLabel = 'Merging video & audio streams with FFmpeg';
        job.progress = 95;
        emitJobUpdate(job);
        return;
      }

      // Example: [download]  45.2% of ~ 12.34MiB at  2.15MiB/s ETA 00:03
      const pctMatch = line.match(
        /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\S+)(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/i
      );
      if (pctMatch) {
        const pct = Number.parseFloat(pctMatch[1]);
        const totalBytes = parseHumanSizeToBytes(pctMatch[2]);
        job.status = 'downloading';
        job.phaseLabel = 'Downloading media stream';
        job.progress = Number.isFinite(pct) ? Math.min(99, Math.round(pct)) : job.progress;
        if (totalBytes) {
          job.totalBytes = totalBytes;
          job.downloadedBytes = Math.round((totalBytes * (job.progress || 0)) / 100);
        }
        job.speedText = pctMatch[3] || null;
        job.etaText = pctMatch[4] || null;
        emitJobUpdate(job);
      }
    };

    let stdoutRemainder = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutRemainder + chunk.toString('utf-8');
      const lines = text.split(/\r?\n/);
      stdoutRemainder = lines.pop() || '';
      for (const l of lines) handleLine(l);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf-8');
      if (stderrBuffer.length < 256 * 1024) {
        stderrBuffer += str;
      }
      for (const l of str.split(/\r?\n/)) {
        handleLine(l);
      }
    });

    child.on('error', (err) => {
      job.activeChild = null;
      reject(err);
    });

    child.on('close', (code) => {
      job.activeChild = null;
      if (job.status === 'cancelled') {
        reject(new Error('Download cancelled by user.'));
        return;
      }
      if (code !== 0) {
        const errLine = stderrBuffer
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('ERROR:'));
        reject(new Error(errLine ? errLine.replace(/^ERROR:\s*/i, '') : `yt-dlp exited with code ${code}`));
        return;
      }
      resolve();
    });
    });
  } finally {
    if (ephemeralCookiesPath) {
      try {
        if (fs.existsSync(ephemeralCookiesPath)) {
          fs.unlinkSync(ephemeralCookiesPath);
        }
      } catch {
        // Best-effort unlink
      }
    }
  }

  const files = fs
    .readdirSync(job.workDir)
    .filter((name) => name.startsWith('source.'))
    .map((name) => path.join(job.workDir, name));

  if (files.length === 0) {
    throw new Error('Download finished but no source file was produced.');
  }
  return files[0];
}

function buildAtempoFilterChain(speed: number): string {
  // FFmpeg atempo supports [0.5, 2.0]. Chain filters for 3x.
  if (speed === 0.5) return 'atempo=0.5';
  if (speed === 1.5) return 'atempo=1.5';
  if (speed === 2) return 'atempo=2.0';
  if (speed === 3) return 'atempo=2.0,atempo=1.5';
  return 'atempo=1.0';
}

async function processWithFfmpeg(
  job: InternalJob,
  sourcePath: string,
  outputPath: string,
  input: CreateJobInput
): Promise<void> {
  const sourceDuration = (await probeDuration(sourcePath)) ?? input.duration ?? 0;
  const hasAudio = await probeHasAudio(sourcePath);

  const trimEnabled = input.trim.enabled && (input.trim.start > 0 || input.trim.end > 0);
  const trimStart = trimEnabled ? Math.max(0, input.trim.start) : 0;
  const trimEnd =
    trimEnabled && input.trim.end > trimStart
      ? input.trim.end
      : sourceDuration > 0
        ? sourceDuration
        : 0;
  const clipDuration = trimEnd > trimStart ? trimEnd - trimStart : sourceDuration;
  const expectedOutputDuration = clipDuration > 0 ? clipDuration / input.speed : 0;

  const args: string[] = ['-y', '-progress', 'pipe:1', '-nostats'];

  if (trimEnabled && trimStart > 0) {
    args.push('-ss', String(trimStart));
  }
  if (trimEnabled && trimEnd > trimStart) {
    args.push('-t', String(trimEnd - trimStart));
  }
  args.push('-i', sourcePath);

  const isSpeedChanged = input.speed !== 1;
  const sourceExt = path.extname(sourcePath).replace('.', '').toLowerCase();

  if (input.mode === 'audio') {
    if (!hasAudio) {
      throw new Error('Source media contains no audio track to extract.');
    }
    args.push('-vn');
    if (isSpeedChanged && hasAudio) {
      args.push('-filter:a', `asetpts=PTS-STARTPTS,${buildAtempoFilterChain(input.speed)}`);
    }
    if (input.container === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', '192k');
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k');
    }
  } else if (!isSpeedChanged && sourceExt === input.container) {
    // Lossless fast stream copy when container matches and speed is 1x
    args.push('-c', 'copy');
    if (input.container === 'mp4') {
      args.push('-movflags', '+faststart');
    }
  } else {
    // Re-encode cleanly for speed adjustment or container conversion
    if (isSpeedChanged) {
      args.push('-filter:v', `setpts=(PTS-STARTPTS)/${input.speed}`);
      if (hasAudio) {
        args.push('-filter:a', `asetpts=PTS-STARTPTS,${buildAtempoFilterChain(input.speed)}`);
      }
    }

    if (input.container === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-deadline', 'realtime');
      if (hasAudio) args.push('-c:a', 'libopus', '-b:a', '128k');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p');
      if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
      if (input.container === 'mp4') {
        args.push('-movflags', '+faststart');
      }
    }
  }

  args.push(outputPath);

  job.status = 'processing';
  job.phaseLabel = isSpeedChanged
    ? `Adjusting playback speed (${input.speed}x) with FFmpeg`
    : trimEnabled
      ? 'Trimming video segment with FFmpeg'
      : `Converting media to ${input.container.toUpperCase()}`;
  job.progress = 0;
  job.speedText = null;
  job.etaText = null;
  emitJobUpdate(job);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(CONFIG.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.activeChild = child;

    let stderrText = '';
    let remainder = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (job.status === 'cancelled') return;
      const text = remainder + chunk.toString('utf-8');
      const lines = text.split(/\r?\n/);
      remainder = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const us = Number.parseInt(line.slice('out_time_us='.length), 10);
          if (Number.isFinite(us) && expectedOutputDuration > 0) {
            const pct = Math.min(99, Math.max(0, Math.round((us / 1_000_000 / expectedOutputDuration) * 100)));
            job.progress = pct;
            emitJobUpdate(job);
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrText.length < 128 * 1024) {
        stderrText += chunk.toString('utf-8');
      }
    });

    child.on('error', (err) => {
      job.activeChild = null;
      reject(err);
    });

    child.on('close', (code) => {
      job.activeChild = null;
      if (job.status === 'cancelled') {
        reject(new Error('Processing cancelled by user.'));
        return;
      }
      if (code !== 0) {
        const lastLines = stderrText.trim().split('\n').slice(-3).join(' ');
        reject(new Error(`FFmpeg processing failed: ${lastLines || `exit code ${code}`}`));
        return;
      }
      resolve();
    });
  });
}

function isJobCancelled(job: InternalJob): boolean {
  return job.status === 'cancelled';
}

async function runJobPipeline(job: InternalJob, input: CreateJobInput): Promise<void> {
  try {
    job.status = 'downloading';
    job.phaseLabel = 'Connecting to media source';
    emitJobUpdate(job);

    let sourcePath: string;
    const isDirectFastPath =
      input.isDirectMedia && input.formatId === 'direct' && !input.needsMerge;

    if (isDirectFastPath) {
      const urlPathExt = path.extname(new URL(input.url).pathname).toLowerCase() || `.${input.container}`;
      sourcePath = path.join(job.workDir, `source${urlPathExt}`);
      job.phaseLabel = 'Downloading direct video stream';
      emitJobUpdate(job);
      await downloadDirectHttp(job, input.url, sourcePath);
    } else {
      const outputTemplate = path.join(job.workDir, 'source.%(ext)s');
      sourcePath = await downloadWithYtDlp(job, input, outputTemplate);
    }

    if (isJobCancelled(job)) return;

    const sourceStat = fs.statSync(sourcePath);
    const maxBytes = CONFIG.maxFileSizeMb * 1024 * 1024;
    if (sourceStat.size > maxBytes) {
      throw new Error(`Downloaded media exceeds the ${CONFIG.maxFileSizeMb} MB server limit.`);
    }

    const sourceExt = path.extname(sourcePath).replace('.', '').toLowerCase();
    const needsFfmpeg =
      input.mode === 'audio' ||
      input.trim.enabled ||
      input.speed !== 1 ||
      sourceExt !== input.container;

    const cleanTitle = sanitizeFilename(input.title);
    const suffixParts: string[] = [];
    if (input.trim.enabled) suffixParts.push('trimmed');
    if (input.speed !== 1) suffixParts.push(`${input.speed}x`);
    const suffix = suffixParts.length > 0 ? `_${suffixParts.join('_')}` : '';
    const finalFilename = `${cleanTitle}${suffix}.${input.container}`;
    const finalOutputPath = path.join(job.workDir, `final.${input.container}`);

    if (needsFfmpeg) {
      await processWithFfmpeg(job, sourcePath, finalOutputPath, input);
      try {
        if (sourcePath !== finalOutputPath && fs.existsSync(sourcePath)) {
          fs.unlinkSync(sourcePath);
        }
      } catch {
        // Ignore temp source unlink error
      }
    } else {
      fs.renameSync(sourcePath, finalOutputPath);
    }

    if (isJobCancelled(job)) return;

    const finalStat = fs.statSync(finalOutputPath);
    if (finalStat.size <= 0) {
      throw new Error('Output media file is empty.');
    }

    job.outputPath = finalOutputPath;
    job.filename = finalFilename;
    job.fileSize = finalStat.size;
    job.downloadedBytes = finalStat.size;
    job.totalBytes = finalStat.size;
    job.progress = 100;
    job.status = 'ready';
    job.phaseLabel = 'Ready to save';
    job.speedText = null;
    job.etaText = null;
    job.downloadUrl = `/api/jobs/${job.jobId}/file`;

    if (job.timeoutTimer) {
      clearTimeout(job.timeoutTimer);
      job.timeoutTimer = null;
    }

    emitJobUpdate(job);
    scheduleJobCleanup(job);
  } catch (err) {
    if (job.timeoutTimer) {
      clearTimeout(job.timeoutTimer);
      job.timeoutTimer = null;
    }
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.phaseLabel = 'Failed';
      job.error = err instanceof Error ? err.message : 'Download or processing failed.';
      emitJobUpdate(job);
      removeDirSafe(job.workDir);
      scheduleJobCleanup(job);
    }
  }
}

export function createDownloadJob(input: CreateJobInput): PublicJobSnapshot {
  ensureTempDir();
  purgeExpiredDirectories(new Set(jobs.keys()));

  if (getActiveJobCount() >= CONFIG.maxConcurrentJobs) {
    throw new Error(
      `Server is currently processing ${CONFIG.maxConcurrentJobs} active jobs. Wait for one to finish or cancel an active job.`
    );
  }

  const jobId = crypto.randomUUID();
  const workDir = path.join(CONFIG.tempDir, jobId);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });

  const job: InternalJob = {
    jobId,
    status: 'queued',
    phaseLabel: 'Queued',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: null,
    speedText: null,
    etaText: null,
    filename: null,
    fileSize: null,
    downloadUrl: null,
    error: null,
    createdAt: Date.now(),
    workDir,
    outputPath: null,
    activeChild: null,
    abortController: null,
    subscribers: new Set(),
    cleanupTimer: null,
    timeoutTimer: null,
  };

  job.timeoutTimer = setTimeout(() => {
    if (
      job.status === 'queued' ||
      job.status === 'downloading' ||
      job.status === 'merging' ||
      job.status === 'processing'
    ) {
      job.status = 'error';
      job.phaseLabel = 'Timed out';
      job.error = `Job exceeded the ${CONFIG.jobTimeoutSec}-second server execution limit.`;
      job.abortController?.abort();
      job.activeChild?.kill('SIGKILL');
      emitJobUpdate(job);
      removeDirSafe(job.workDir);
      scheduleJobCleanup(job);
    }
  }, CONFIG.jobTimeoutSec * 1000);

  jobs.set(jobId, job);
  void runJobPipeline(job, input);
  return toPublicSnapshot(job);
}
