import dns from 'node:dns/promises';
import net from 'node:net';

export interface ValidatedUrlResult {
  valid: boolean;
  normalizedUrl?: string;
  hostname?: string;
  sourceName?: string;
  isDirectExtension?: boolean;
  error?: string;
}

const DIRECT_MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.m4v',
  '.avi',
  '.flv',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.m3u8',
]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inCidr4(ip: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const cleaned = ip.split('%')[0].toLowerCase();
  const version = net.isIP(cleaned);

  if (version === 4) {
    return (
      inCidr4(cleaned, '0.0.0.0', 8) ||
      inCidr4(cleaned, '10.0.0.0', 8) ||
      inCidr4(cleaned, '100.64.0.0', 10) || // Carrier-grade NAT
      inCidr4(cleaned, '127.0.0.0', 8) || // Loopback
      inCidr4(cleaned, '169.254.0.0', 16) || // Link-local / Cloud metadata
      inCidr4(cleaned, '172.16.0.0', 12) || // Private RFC1918
      inCidr4(cleaned, '192.0.0.0', 24) ||
      inCidr4(cleaned, '192.0.2.0', 24) ||
      inCidr4(cleaned, '192.168.0.0', 16) || // Private RFC1918
      inCidr4(cleaned, '198.18.0.0', 15) ||
      inCidr4(cleaned, '198.51.100.0', 24) ||
      inCidr4(cleaned, '203.0.113.0', 24) ||
      inCidr4(cleaned, '224.0.0.0', 4) || // Multicast
      inCidr4(cleaned, '240.0.0.0', 4) // Reserved
    );
  }

  if (version === 6) {
    if (cleaned === '::' || cleaned === '::1') return true;
    if (cleaned.startsWith('::ffff:')) {
      const mapped = cleaned.slice(7);
      if (net.isIP(mapped) === 4) {
        return isPrivateOrReservedIp(mapped);
      }
    }
    // fc00::/7 (Unique local), fe80::/10 (Link-local), ff00::/8 (Multicast)
    if (
      cleaned.startsWith('fc') ||
      cleaned.startsWith('fd') ||
      cleaned.startsWith('fe8') ||
      cleaned.startsWith('fe9') ||
      cleaned.startsWith('fea') ||
      cleaned.startsWith('feb') ||
      cleaned.startsWith('ff')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

export function detectSourceName(parsedUrl: URL): string {
  const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) {
    return 'YouTube';
  }
  if (host === 'facebook.com' || host === 'fb.watch' || host.endsWith('.facebook.com')) {
    return 'Facebook';
  }
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
    return 'Instagram';
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    return 'TikTok';
  }
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    return 'Vimeo';
  }
  if (host === 'twitter.com' || host === 'x.com' || host.endsWith('.x.com')) {
    return 'X (Twitter)';
  }
  if (host === 'reddit.com' || host === 'v.redd.it' || host.endsWith('.reddit.com')) {
    return 'Reddit';
  }
  if (host.endsWith('wikimedia.org')) {
    return 'Wikimedia Commons';
  }
  if (host === 'archive.org' || host.endsWith('.archive.org')) {
    return 'Internet Archive';
  }
  if (hasDirectMediaExtension(parsedUrl.pathname)) {
    return 'Direct Video URL';
  }
  return host;
}

export function hasDirectMediaExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  for (const ext of DIRECT_MEDIA_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

export async function validatePublicUrl(rawUrl: string): Promise<ValidatedUrlResult> {
  if (typeof rawUrl !== 'string') {
    return { valid: false, error: 'URL must be a text string.' };
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'Please paste a video URL before analyzing.' };
  }
  if (trimmed.length > 2048) {
    return { valid: false, error: 'URL exceeds the 2048-character safety limit.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      error: 'Invalid URL format. Enter a complete http:// or https:// address.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: 'Only public http:// and https:// URLs are permitted.',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: 'URLs containing embedded credentials are not allowed.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost')
  ) {
    return {
      valid: false,
      error: 'Localhost and private internal network addresses are blocked for security.',
    };
  }

  if (net.isIP(hostname) !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      return {
        valid: false,
        error: 'Private, loopback, or reserved IP addresses are blocked for security.',
      };
    }
  } else {
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      if (!addresses || addresses.length === 0) {
        return {
          valid: false,
          error: `Could not resolve hostname "${hostname}". Check the URL spelling.`,
        };
      }
      for (const entry of addresses) {
        if (isPrivateOrReservedIp(entry.address)) {
          return {
            valid: false,
            error: 'This domain resolves to a private or internal network address and cannot be accessed.',
          };
        }
      }
    } catch {
      return {
        valid: false,
        error: `DNS lookup failed for "${hostname}". Verify the URL and network connection.`,
      };
    }
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
    hostname,
    sourceName: detectSourceName(parsed),
    isDirectExtension: hasDirectMediaExtension(parsed.pathname),
  };
}

export function sanitizeFilename(rawTitle: string): string {
  const cleaned = (rawTitle || 'video')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  return cleaned.length > 0 ? cleaned : 'clipfetch_video';
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export async function safeFetchPublic(
  initialUrl: string,
  options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  maxRedirects = 5
): Promise<globalThis.Response> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = await validatePublicUrl(currentUrl);
    if (!check.valid || !check.normalizedUrl) {
      throw new Error(check.error || 'Redirect target blocked by SSRF security policy.');
    }

    const res = await fetch(check.normalizedUrl, {
      headers: options.headers,
      signal: options.signal,
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) {
        throw new Error(`Remote server returned redirect HTTP ${res.status} without a Location header.`);
      }
      currentUrl = new URL(location, check.normalizedUrl).toString();
      continue;
    }

    return res;
  }

  throw new Error('Too many HTTP redirects while fetching remote media.');
}
