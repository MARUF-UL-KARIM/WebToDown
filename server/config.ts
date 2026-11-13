import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

function resolveBinary(envValue: string | undefined, candidates: string[], fallback: string): string {
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

const cwd = process.cwd();
export const RUNTIME_YTDLP_PATH = '/tmp/clipfetch_bin/yt-dlp';

export const CONFIG = {
  port: Number.parseInt(process.env.PORT || '3000', 10) || 3000,
  isProduction: process.env.NODE_ENV === 'production',
  tempDir: path.resolve(process.env.TEMP_DIR || '/tmp/clipfetch_jobs'),
  maxFileSizeMb: Number.parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10) || 500,
  maxDurationSec: Number.parseInt(process.env.MAX_DURATION_SEC || '3600', 10) || 3600,
  maxConcurrentJobs: Number.parseInt(process.env.MAX_CONCURRENT_JOBS || '4', 10) || 4,
  jobTimeoutSec: Number.parseInt(process.env.JOB_TIMEOUT_SEC || '600', 10) || 600,
  autoCleanupMinutes: Number.parseInt(process.env.AUTO_CLEANUP_MINUTES || '15', 10) || 15,
  ytdlpBin: resolveBinary(
    process.env.YTDLP_BIN,
    [RUNTIME_YTDLP_PATH, path.join(cwd, 'bin', 'yt-dlp'), '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'],
    RUNTIME_YTDLP_PATH
  ),
  ffmpegBin: resolveBinary(
    process.env.FFMPEG_BIN,
    ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
    'ffmpeg'
  ),
  ffprobeBin: resolveBinary(
    process.env.FFPROBE_BIN,
    ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe'],
    'ffprobe'
  ),
  nodeBin: resolveBinary(
    process.env.NODE_BIN,
    [process.execPath, '/usr/local/bin/node', '/usr/bin/node'],
    'node'
  ),
  cookiesFile:
    process.env.YTDLP_COOKIES_FILE && fs.existsSync(process.env.YTDLP_COOKIES_FILE)
      ? process.env.YTDLP_COOKIES_FILE
      : null,
  allowedSpeeds: [0.5, 1, 1.5, 2, 3] as const,
  allowedVideoContainers: ['mp4', 'webm', 'mkv'] as const,
  allowedAudioContainers: ['mp3', 'm4a'] as const,
};

export async function ensureYtDlpBinary(): Promise<void> {
  if (fs.existsSync(CONFIG.ytdlpBin)) {
    return;
  }

  // Check if yt-dlp is already in system PATH
  const pathDirs = (process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'yt-dlp');
    if (fs.existsSync(candidate)) {
      CONFIG.ytdlpBin = candidate;
      return;
    }
  }

  // Bootstrap standalone yt-dlp_linux binary into /tmp/clipfetch_bin/yt-dlp
  try {
    const targetDir = path.dirname(RUNTIME_YTDLP_PATH);
    fs.mkdirSync(targetDir, { recursive: true });
    const response = await fetch(
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
      { redirect: 'follow' }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(RUNTIME_YTDLP_PATH, buf, { mode: 0o755 });
    fs.chmodSync(RUNTIME_YTDLP_PATH, 0o755);
    CONFIG.ytdlpBin = RUNTIME_YTDLP_PATH;
  } catch (err) {
    console.warn('Could not auto-download yt-dlp binary:', err);
  }
}
