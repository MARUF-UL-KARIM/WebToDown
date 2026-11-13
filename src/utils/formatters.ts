export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) {
    return 'Size unknown';
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  if (mb >= 1) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

export function secondsToTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function timestampToSeconds(input: string): number | null {
  const cleaned = input.trim();
  if (!cleaned) return null;

  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    const val = Number.parseFloat(cleaned);
    return Number.isFinite(val) && val >= 0 ? val : null;
  }

  const parts = cleaned.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  if (parts.length === 2) {
    const [m, s] = nums;
    if (s >= 60) return null;
    return m * 60 + s;
  }

  const [h, m, s] = nums;
  if (m >= 60 || s >= 60) return null;
  return h * 3600 + m * 60 + s;
}

export function shortCodec(codec: string | null | undefined): string {
  if (!codec || codec === 'none') return '';
  const lower = codec.toLowerCase();
  if (lower.startsWith('avc1') || lower === 'h264') return 'H.264';
  if (lower.startsWith('hev1') || lower.startsWith('hvc1') || lower === 'hevc') return 'H.265';
  if (lower.startsWith('vp9') || lower.startsWith('vp09')) return 'VP9';
  if (lower.startsWith('av01') || lower === 'av1') return 'AV1';
  if (lower.startsWith('mp4a') || lower === 'aac') return 'AAC';
  if (lower === 'opus') return 'Opus';
  return codec.split('.')[0].toUpperCase();
}
