import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { CONFIG } from './config.ts';
import { detectSourceName, hasDirectMediaExtension } from './validators.ts';

export interface VideoFormatOption {
  id: string;
  label: string;
  qualityTag: string;
  height: number | null;
  width: number | null;
  fps: number | null;
  ext: string;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
  tbr: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  needsMerge: boolean;
  audioFormatId: string | null;
}

export interface AnalyzedMedia {
  url: string;
  webpageUrl: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  durationFormatted: string;
  uploader: string | null;
  source: string;
  extractor: string;
  isDirectMedia: boolean;
  hasAudioTrack: boolean;
  canTrim: boolean;
  canChangeSpeed: boolean;
  videoFormats: VideoFormatOption[];
  audioFormats: VideoFormatOption[];
  limits: {
    maxFileSizeMb: number;
    maxDurationSec: number;
  };
}

interface RawYtDlpFormat {
  format_id?: string;
  ext?: string;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  tbr?: number;
  abr?: number;
  vbr?: number;
  format_note?: string;
  resolution?: string;
  protocol?: string;
  has_drm?: boolean;
}

interface RawYtDlpInfo {
  id?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  channel?: string;
  webpage_url?: string;
  extractor_key?: string;
  extractor?: string;
  formats?: RawYtDlpFormat[];
  url?: string;
  ext?: string;
  width?: number;
  height?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  is_live?: boolean;
  _type?: string;
}

const STANDARD_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return 'Unknown';
  }
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function runCommandWithTimeout(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1500);
        reject(new Error('Media inspection timed out. The remote server took too long to respond.'));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) {
        stdout += chunk.toString('utf-8');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 512 * 1024) {
        stderr += chunk.toString('utf-8');
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: code ?? 1, stdout, stderr });
      }
    });
  });
}

function classifyExtractorError(stderr: string, url: string): string {
  const lower = stderr.toLowerCase();

  if (lower.includes('drm') || lower.includes('widevine') || lower.includes('encrypted')) {
    return 'This media uses DRM or encryption protection and cannot be extracted or downloaded.';
  }
  if (lower.includes('sign in to confirm') || lower.includes('not a bot')) {
    return 'YouTube blocked automated extraction from this server IP (bot verification challenge). Public direct links and self-hosted local/residential instances with cookies bypass this restriction.';
  }
  if (
    lower.includes('private video') ||
    lower.includes('login required') ||
    lower.includes('authentication') ||
    lower.includes('cookies') ||
    lower.includes('account')
  ) {
    return 'This video is private or requires authentication. Only publicly accessible videos are supported.';
  }
  if (lower.includes('geo') || lower.includes('not available in your country')) {
    return 'This video is geo-restricted and unavailable from the server location.';
  }
  if (lower.includes('unsupported url')) {
    return `This URL is not supported by yt-dlp and does not expose a direct video stream (${url}).`;
  }
  if (lower.includes('404') || lower.includes('not found') || lower.includes('video unavailable')) {
    return 'The requested video was not found or has been removed.';
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return 'The remote host denied access (HTTP 403 Forbidden).';
  }
  if (lower.includes('ssl') || lower.includes('certificate')) {
    return 'TLS/SSL verification failed while connecting to the remote host.';
  }

  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('ERROR:'));
  if (lines.length > 0) {
    return lines[0].replace(/^ERROR:\s*/i, '');
  }
  return 'Could not extract playable media from this URL. Verify that it is a public video page or direct media link.';
}

async function probeDirectMedia(url: string): Promise<AnalyzedMedia | null> {
  const host = new URL(url).hostname.toLowerCase();
  const ua = host.endsWith('wikimedia.org')
    ? 'ClipFetch/1.0 (+https://github.com/clipfetch)'
    : STANDARD_BROWSER_UA;
  const args = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-user_agent',
    ua,
    url,
  ];

  const { code, stdout } = await runCommandWithTimeout(CONFIG.ffprobeBin, args, 20_000);
  if (code !== 0 || !stdout.trim()) {
    return null;
  }

  let parsed: {
    format?: {
      filename?: string;
      format_name?: string;
      duration?: string;
      size?: string;
      bit_rate?: string;
      tags?: Record<string, string>;
    };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      bit_rate?: string;
    }>;
  };

  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const streams = parsed.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream && !audioStream) {
    return null;
  }

  const durationRaw = parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : null;
  const duration = durationRaw && Number.isFinite(durationRaw) ? durationRaw : null;
  const sizeRaw = parsed.format?.size ? Number.parseInt(parsed.format.size, 10) : null;
  const filesize = sizeRaw && Number.isFinite(sizeRaw) ? sizeRaw : null;
  const bitrateRaw = parsed.format?.bit_rate ? Number.parseInt(parsed.format.bit_rate, 10) / 1000 : null;

  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);
  const lastSegment = pathParts[pathParts.length - 1] || 'direct_media';
  const cleanTitle =
    parsed.format?.tags?.title ||
    decodeURIComponent(lastSegment).replace(/\.[a-z0-9]{2,5}$/i, '') ||
    'Direct Media Stream';

  let ext = 'mp4';
  const extMatch = lastSegment.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  if (extMatch) {
    ext = extMatch[1] === 'm3u8' ? 'mp4' : extMatch[1];
  } else if (parsed.format?.format_name?.includes('webm')) {
    ext = 'webm';
  }

  let fps: number | null = null;
  if (videoStream?.avg_frame_rate && videoStream.avg_frame_rate.includes('/')) {
    const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
    if (den > 0 && Number.isFinite(num / den)) {
      fps = Math.round(num / den);
    }
  }

  const height = videoStream?.height ?? null;
  const width = videoStream?.width ?? null;
  const qualityTag = height ? `${height}p` : 'Original';

  const videoFormats: VideoFormatOption[] = videoStream
    ? [
        {
          id: 'direct',
          label: height ? `Original (${height}p)` : 'Original Stream',
          qualityTag,
          height,
          width,
          fps,
          ext,
          vcodec: videoStream.codec_name ?? null,
          acodec: audioStream?.codec_name ?? null,
          filesize,
          tbr: bitrateRaw ? Math.round(bitrateRaw) : null,
          hasVideo: true,
          hasAudio: Boolean(audioStream),
          needsMerge: false,
          audioFormatId: null,
        },
      ]
    : [];

  const audioFormats: VideoFormatOption[] = audioStream
    ? [
        {
          id: 'direct-audio',
          label: `Original Audio (${(audioStream.codec_name || 'audio').toUpperCase()})`,
          qualityTag: 'Audio',
          height: null,
          width: null,
          fps: null,
          ext: ext === 'mp3' || ext === 'm4a' ? ext : 'm4a',
          vcodec: null,
          acodec: audioStream.codec_name ?? null,
          filesize: videoStream ? null : filesize,
          tbr: audioStream.bit_rate ? Math.round(Number.parseInt(audioStream.bit_rate, 10) / 1000) : null,
          hasVideo: false,
          hasAudio: true,
          needsMerge: false,
          audioFormatId: null,
        },
      ]
    : [];

  return {
    url,
    webpageUrl: url,
    title: cleanTitle,
    thumbnail: null,
    duration,
    durationFormatted: formatDuration(duration),
    uploader: urlObj.hostname,
    source: detectSourceName(urlObj),
    extractor: 'ffprobe-direct',
    isDirectMedia: true,
    hasAudioTrack: Boolean(audioStream),
    canTrim: Boolean(duration && duration > 0),
    canChangeSpeed: Boolean(videoStream),
    videoFormats,
    audioFormats,
    limits: {
      maxFileSizeMb: CONFIG.maxFileSizeMb,
      maxDurationSec: CONFIG.maxDurationSec,
    },
  };
}

function buildVideoFormats(info: RawYtDlpInfo, url: string): {
  videoFormats: VideoFormatOption[];
  audioFormats: VideoFormatOption[];
  hasAudioTrack: boolean;
} {
  const rawFormats = Array.isArray(info.formats) ? info.formats : [];

  if (rawFormats.some((f) => f.has_drm)) {
    throw new Error('This media contains DRM-protected streams and cannot be downloaded.');
  }

  const audioOnlyRaw = rawFormats.filter(
    (f) =>
      f.format_id &&
      f.acodec &&
      f.acodec !== 'none' &&
      (!f.vcodec || f.vcodec === 'none')
  );

  // Sort audio streams by bitrate descending
  audioOnlyRaw.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
  const bestAudio = audioOnlyRaw[0] ?? null;

  const videoRaw = rawFormats.filter(
    (f) => f.format_id && f.vcodec && f.vcodec !== 'none'
  );

  const hasMuxedAudio = videoRaw.some((f) => f.acodec && f.acodec !== 'none');
  const hasAudioTrack = Boolean(bestAudio || hasMuxedAudio || (info.acodec && info.acodec !== 'none'));

  // Group by height tier (e.g. 2160, 1440, 1080, 720, 480, 360, 240)
  // Prefer mp4/h264 or muxed streams within same height tier
  const byHeight = new Map<number, VideoFormatOption>();

  for (const f of videoRaw) {
    const height = f.height && f.height > 0 ? f.height : 0;
    const isMuxed = Boolean(f.acodec && f.acodec !== 'none');
    const needsMerge = !isMuxed && Boolean(bestAudio);
    const estSize = f.filesize ?? f.filesize_approx ?? null;
    const mergedSize =
      needsMerge && estSize && (bestAudio?.filesize || bestAudio?.filesize_approx)
        ? estSize + (bestAudio.filesize ?? bestAudio.filesize_approx ?? 0)
        : estSize;

    const option: VideoFormatOption = {
      id: f.format_id!,
      label: height > 0 ? `${height}p` : f.format_note || 'Original',
      qualityTag: height > 0 ? `${height}p` : 'Original',
      height: height > 0 ? height : null,
      width: f.width && f.width > 0 ? f.width : null,
      fps: f.fps ? Math.round(f.fps) : null,
      ext: f.ext || 'mp4',
      vcodec: f.vcodec || null,
      acodec: isMuxed ? f.acodec || null : bestAudio?.acodec || null,
      filesize: mergedSize,
      tbr: f.tbr ? Math.round(f.tbr) : null,
      hasVideo: true,
      hasAudio: isMuxed || Boolean(bestAudio),
      needsMerge,
      audioFormatId: needsMerge && bestAudio?.format_id ? bestAudio.format_id : null,
    };

    const existing = byHeight.get(height);
    if (!existing) {
      byHeight.set(height, option);
    } else {
      // Score preference: mp4 container + muxed > mp4 + merge > higher tbr
      const score = (opt: VideoFormatOption) => {
        let s = 0;
        if (opt.ext === 'mp4') s += 1000;
        if (!opt.needsMerge) s += 500;
        if (opt.vcodec?.startsWith('avc1') || opt.vcodec?.startsWith('h264')) s += 200;
        s += (opt.tbr || 0) / 100;
        return s;
      };
      if (score(option) > score(existing)) {
        byHeight.set(height, option);
      }
    }
  }

  const sortedHeights = Array.from(byHeight.entries())
    .sort((a, b) => b[0] - a[0])
    .map((entry) => entry[1]);

  // If yt-dlp returned single flat metadata without formats array
  if (sortedHeights.length === 0 && info.url) {
    const height = info.height ?? null;
    sortedHeights.push({
      id: 'best',
      label: height ? `Original (${height}p)` : 'Original',
      qualityTag: height ? `${height}p` : 'Original',
      height,
      width: info.width ?? null,
      fps: null,
      ext: info.ext || 'mp4',
      vcodec: info.vcodec && info.vcodec !== 'none' ? info.vcodec : null,
      acodec: info.acodec && info.acodec !== 'none' ? info.acodec : null,
      filesize: info.filesize ?? info.filesize_approx ?? null,
      tbr: null,
      hasVideo: true,
      hasAudio: Boolean(info.acodec && info.acodec !== 'none'),
      needsMerge: false,
      audioFormatId: null,
    });
  }

  // Prepend "Original (Best Available)" referencing the genuinely highest available format without duplicating it
  const videoFormats: VideoFormatOption[] = [];
  if (sortedHeights.length > 0) {
    const top = sortedHeights[0];
    videoFormats.push({
      ...top,
      id: top.id,
      label: top.height ? `Original (${top.height}p)` : 'Original (Best Available)',
      qualityTag: top.height ? `${top.height}p` : 'Original',
    });
    for (const fmt of sortedHeights.slice(1)) {
      if (fmt.height) {
        videoFormats.push(fmt);
      }
    }
  }

  const audioFormats: VideoFormatOption[] = [];
  const seenAbr = new Set<string>();
  for (const a of audioOnlyRaw.slice(0, 4)) {
    const kbps = Math.round(a.abr || a.tbr || 0);
    const key = `${a.ext}-${kbps}`;
    if (seenAbr.has(key)) continue;
    seenAbr.add(key);
    audioFormats.push({
      id: a.format_id!,
      label: kbps > 0 ? `${kbps} kbps (${(a.ext || 'audio').toUpperCase()})` : `Audio (${(a.ext || 'm4a').toUpperCase()})`,
      qualityTag: kbps > 0 ? `${kbps}kbps` : 'Audio',
      height: null,
      width: null,
      fps: null,
      ext: a.ext || 'm4a',
      vcodec: null,
      acodec: a.acodec || null,
      filesize: a.filesize ?? a.filesize_approx ?? null,
      tbr: kbps || null,
      hasVideo: false,
      hasAudio: true,
      needsMerge: false,
      audioFormatId: null,
    });
  }

  if (audioFormats.length === 0 && hasAudioTrack) {
    audioFormats.push({
      id: sortedHeights[0]?.id || 'best',
      label: 'Extract Audio from Video',
      qualityTag: 'Extracted',
      height: null,
      width: null,
      fps: null,
      ext: 'mp3',
      vcodec: null,
      acodec: 'mp3',
      filesize: null,
      tbr: 192,
      hasVideo: false,
      hasAudio: true,
      needsMerge: false,
      audioFormatId: null,
    });
  }

  // Unused param lint guard
  void url;

  return { videoFormats, audioFormats, hasAudioTrack };
}

export async function analyzeMediaUrl(
  url: string,
  cookiesText?: string | null
): Promise<AnalyzedMedia> {
  const parsedUrl = new URL(url);
  const directExt = hasDirectMediaExtension(parsedUrl.pathname);

  const args = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout',
    '20',
    '--user-agent',
    STANDARD_BROWSER_UA,
  ];

  if (CONFIG.nodeBin && fs.existsSync(CONFIG.nodeBin)) {
    args.push('--js-runtimes', `node:${CONFIG.nodeBin}`);
  }

  let ephemeralCookiesPath: string | null = null;
  if (cookiesText && cookiesText.trim().length > 0) {
    const tempCookiesDir = CONFIG.tempDir;
    fs.mkdirSync(tempCookiesDir, { recursive: true, mode: 0o700 });
    ephemeralCookiesPath = `${tempCookiesDir}/cookies_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
    fs.writeFileSync(ephemeralCookiesPath, cookiesText.trim() + '\n', { mode: 0o600 });
    args.push('--cookies', ephemeralCookiesPath);
  } else if (CONFIG.cookiesFile) {
    args.push('--cookies', CONFIG.cookiesFile);
  }
  args.push(url);

  let ytdlpError: string | null = null;
  try {
    const res = await runCommandWithTimeout(CONFIG.ytdlpBin, args, 35_000);
    if (res.code === 0 && res.stdout.trim()) {
      const info = JSON.parse(res.stdout) as RawYtDlpInfo;

      if (info.is_live) {
        throw new Error('Live streams cannot be pre-analyzed or downloaded as finite files.');
      }

      const { videoFormats, audioFormats, hasAudioTrack } = buildVideoFormats(info, url);

      // If yt-dlp generic extractor yielded a single format with no resolution info on a direct media file, enrich via ffprobe
      if (
        directExt &&
        videoFormats.length <= 1 &&
        (!videoFormats[0]?.height || !info.duration)
      ) {
        const probed = await probeDirectMedia(url);
        if (probed) {
          return probed;
        }
      }

      if (videoFormats.length === 0 && audioFormats.length === 0) {
        throw new Error('No downloadable video or audio formats were found at this URL.');
      }

      const duration =
        typeof info.duration === 'number' && Number.isFinite(info.duration)
          ? info.duration
          : null;

      if (duration && duration > CONFIG.maxDurationSec) {
        throw new Error(
          `Video duration (${formatDuration(duration)}) exceeds the server limit of ${formatDuration(CONFIG.maxDurationSec)}.`
        );
      }

      return {
        url,
        webpageUrl: info.webpage_url || url,
        title: info.title || 'Untitled Media',
        thumbnail: info.thumbnail || null,
        duration,
        durationFormatted: formatDuration(duration),
        uploader: info.uploader || info.channel || null,
        source: detectSourceName(parsedUrl),
        extractor: info.extractor_key || info.extractor || 'yt-dlp',
        isDirectMedia: directExt,
        hasAudioTrack,
        canTrim: Boolean(duration && duration > 0),
        canChangeSpeed: videoFormats.length > 0,
        videoFormats,
        audioFormats,
        limits: {
          maxFileSizeMb: CONFIG.maxFileSizeMb,
          maxDurationSec: CONFIG.maxDurationSec,
        },
      };
    }

    ytdlpError = classifyExtractorError(res.stderr, url);
  } catch (err) {
    ytdlpError = err instanceof Error ? err.message : 'Extraction failed.';
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

  // Fallback to ffprobe for direct media links (e.g., CDNs that reject yt-dlp generic scraper)
  if (directExt || !ytdlpError.toLowerCase().includes('drm')) {
    try {
      const probed = await probeDirectMedia(url);
      if (probed) {
        if (probed.duration && probed.duration > CONFIG.maxDurationSec) {
          throw new Error(
            `Video duration (${formatDuration(probed.duration)}) exceeds the server limit of ${formatDuration(CONFIG.maxDurationSec)}.`
          );
        }
        return probed;
      }
    } catch (probeErr) {
      if (probeErr instanceof Error && probeErr.message.includes('exceeds the server limit')) {
        throw probeErr;
      }
    }
  }

  throw new Error(ytdlpError || 'Unable to analyze this URL.');
}

export async function getToolVersions(): Promise<{
  ytdlp: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
}> {
  const check = async (bin: string, arg: string): Promise<string | null> => {
    try {
      const res = await runCommandWithTimeout(bin, [arg], 4000);
      if (res.code === 0 && res.stdout.trim()) {
        return res.stdout.trim().split('\n')[0].slice(0, 80);
      }
      return null;
    } catch {
      return null;
    }
  };

  const [ytdlp, ffmpeg, ffprobe] = await Promise.all([
    check(CONFIG.ytdlpBin, '--version'),
    check(CONFIG.ffmpegBin, '-version'),
    check(CONFIG.ffprobeBin, '-version'),
  ]);

  return { ytdlp, ffmpeg, ffprobe };
}
