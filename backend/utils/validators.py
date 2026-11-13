import ipaddress
import re
import socket
from urllib.parse import urlparse

DIRECT_MEDIA_EXTENSIONS = (
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".m4v",
    ".avi",
    ".flv",
    ".mp3",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
    ".wav",
    ".m3u8",
)

BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "0.0.0.0",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
}

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def is_private_or_reserved_ip(ip_str: str) -> bool:
    cleaned = ip_str.split("%")[0].strip()
    try:
        ip_obj = ipaddress.ip_address(cleaned)
    except ValueError:
        return True

    if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped:
        ip_obj = ip_obj.ipv4_mapped

    return (
        ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
    )


def has_direct_media_extension(path_str: str) -> bool:
    lower = path_str.lower()
    return any(lower.endswith(ext) for ext in DIRECT_MEDIA_EXTENSIONS)


def detect_source_name(parsed_url) -> str:
    host = (parsed_url.hostname or "").lower().removeprefix("www.")
    if host in {"youtube.com", "youtu.be"} or host.endswith(".youtube.com"):
        return "YouTube"
    if host in {"facebook.com", "fb.watch"} or host.endswith(".facebook.com"):
        return "Facebook"
    if host == "instagram.com" or host.endswith(".instagram.com"):
        return "Instagram"
    if host == "tiktok.com" or host.endswith(".tiktok.com"):
        return "TikTok"
    if host == "vimeo.com" or host.endswith(".vimeo.com"):
        return "Vimeo"
    if host in {"twitter.com", "x.com"} or host.endswith(".x.com"):
        return "X (Twitter)"
    if host in {"reddit.com", "v.redd.it"} or host.endswith(".reddit.com"):
        return "Reddit"
    if host.endswith("wikimedia.org"):
        return "Wikimedia Commons"
    if host == "archive.org" or host.endswith(".archive.org"):
        return "Internet Archive"
    if has_direct_media_extension(parsed_url.path):
        return "Direct Video URL"
    return host


def validate_public_url(raw_url: str) -> dict:
    if not isinstance(raw_url, str):
        return {"valid": False, "error": "URL must be a text string."}

    trimmed = raw_url.strip()
    if not trimmed:
        return {"valid": False, "error": "Please paste a video URL before analyzing."}
    if len(trimmed) > 2048:
        return {"valid": False, "error": "URL exceeds the 2048-character safety limit."}

    try:
        parsed = urlparse(trimmed)
    except Exception:
        return {"valid": False, "error": "Invalid URL format."}

    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return {"valid": False, "error": "Only public http:// and https:// URLs are permitted."}

    if parsed.username or parsed.password:
        return {"valid": False, "error": "URLs containing embedded credentials are not allowed."}

    hostname = (parsed.hostname or "").lower()
    if (
        not hostname
        or hostname in BLOCKED_HOSTNAMES
        or hostname.endswith(".local")
        or hostname.endswith(".internal")
        or hostname.endswith(".localhost")
    ):
        return {
            "valid": False,
            "error": "Localhost and private internal network addresses are blocked for security.",
        }

    # Direct IP literal check
    try:
        ipaddress.ip_address(hostname)
        if is_private_or_reserved_ip(hostname):
            return {
                "valid": False,
                "error": "Private, loopback, or reserved IP addresses are blocked for security.",
            }
    except ValueError:
        # Resolve DNS and check every returned IP to block SSRF
        try:
            addr_info = socket.getaddrinfo(hostname, None)
        except socket.gaierror:
            return {
                "valid": False,
                "error": f'DNS lookup failed for "{hostname}". Verify the URL spelling.',
            }

        if not addr_info:
            return {"valid": False, "error": f'Could not resolve hostname "{hostname}".'}

        for item in addr_info:
            resolved_ip = item[4][0]
            if is_private_or_reserved_ip(resolved_ip):
                return {
                    "valid": False,
                    "error": "This domain resolves to a private or internal IP and cannot be accessed.",
                }

    return {
        "valid": True,
        "normalized_url": trimmed,
        "hostname": hostname,
        "source_name": detect_source_name(parsed),
        "is_direct_extension": has_direct_media_extension(parsed.path),
    }


import urllib.request


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validation = validate_public_url(newurl)
        if not validation.get("valid"):
            raise ValueError(validation.get("error") or "Redirect to restricted URL blocked.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_safe_opener = urllib.request.build_opener(SafeRedirectHandler)


def safe_urlopen(req: urllib.request.Request, timeout: int = 15):
    return _safe_opener.open(req, timeout=timeout)


def sanitize_filename(raw_title: str) -> str:
    cleaned = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', " ", raw_title or "video")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()[:96]
    return cleaned or "clipfetch_video"


def is_valid_uuid(value: str) -> bool:
    return bool(UUID_RE.match(value or ""))
