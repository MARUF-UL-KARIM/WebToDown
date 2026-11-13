window.ClipFetchAnalyzer = {
  async analyzeUrl(url) {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not analyze URL.');
    }
    return data;
  },

  formatBytes(bytes) {
    if (!bytes || bytes <= 0) return 'Size unknown';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    if (mb >= 1) return mb.toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
  },

  secondsToTimestamp(total) {
    const s = Math.max(0, Math.floor(total || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  },

  timestampToSeconds(text) {
    const cleaned = String(text || '').trim();
    if (/^\d+(\.\d+)?$/.test(cleaned)) return parseFloat(cleaned);
    const parts = cleaned.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  },
};
