import json
import os
import subprocess
import tempfile
from urllib.parse import urlparse
from backend.config import Config
from backend.utils.validators import detect_source_name, has_direct_media_extension

STANDARD_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def format_duration(seconds: float | None) -> str:
    if seconds is None or seconds < 0:
        return "Unknown"
    total = round(seconds)
    hrs = total // 3600
    mins = (total % 3600) // 60
    secs = total % 60
    if hrs > 0:
        return f"{hrs}:{mins:02d}:{secs:02d}"
    return f"{mins}:{secs:02d}"


def _classify_error(stderr: str, url: str) -> str:
    lower = stderr.lower()
    if "drm" in lower or "widevine" in lower or "encrypted" in lower:
        return "This media uses DRM or encryption protection and cannot be downloaded."
    if "sign in to confirm" in lower or "not a bot" in lower:
        return (
            "YouTube blocked automated extraction from this server IP (bot verification challenge). "
            "Self-hosted residential/Termux instances or configured cookies avoid this limit."
        )
    if any(k in lower for k in ("private video", "login required", "authentication", "cookies")):
        return "This video is private or requires authentication. Only public videos are supported."
    if "geo" in lower or "not available in your country" in lower:
        return "This video is geo-restricted and unavailable from the server location."
    if "unsupported url" in lower:
        return f"This URL is not supported by yt-dlp and does not expose a direct video stream ({url})."
    if any(k in lower for k in ("404", "not found", "video unavailable")):
        return "The requested video was not found or has been removed."
    if "403" in lower or "forbidden" in lower:
        return "The remote host denied access (HTTP 403 Forbidden)."

    for line in stderr.splitlines():
        stripped = line.strip()
        if stripped.startswith("ERROR:"):
            return stripped[6:].strip()
    return "Could not extract playable media from this URL."


def _probe_direct_media(url: str) -> dict | None:
    host = (urlparse(url).hostname or "").lower()
    ua = "ClipFetch/1.0 (+https://github.com/clipfetch)" if host.endswith("wikimedia.org") else STANDARD_BROWSER_UA
    cmd = [
        Config.FFPROBE_BIN,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-user_agent",
        ua,
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception:
        return None

    if proc.returncode != 0 or not proc.stdout.strip():
        return None

    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None

    streams = parsed.get("streams") or []
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video_stream and not audio_stream:
        return None

    fmt_info = parsed.get("format") or {}
    duration = float(fmt_info["duration"]) if fmt_info.get("duration") else None
    filesize = int(fmt_info["size"]) if fmt_info.get("size") else None
    tbr = round(int(fmt_info["bit_rate"]) / 1000) if fmt_info.get("bit_rate") else None

    parsed_url = urlparse(url)
    last_seg = (parsed_url.path.split("/") or ["direct_media"])[-1] or "direct_media"
    tags = fmt_info.get("tags") or {}
    title = tags.get("title") or last_seg.rsplit(".", 1)[0] or "Direct Media Stream"
    ext = last_seg.rsplit(".", 1)[-1].lower() if "." in last_seg else "mp4"
    if ext == "m3u8":
        ext = "mp4"

    fps = None
    avg_rate = (video_stream or {}).get("avg_frame_rate", "")
    if "/" in avg_rate:
        num, den = avg_rate.split("/", 1)
        if float(den) > 0:
            fps = round(float(num) / float(den))

    height = (video_stream or {}).get("height")
    width = (video_stream or {}).get("width")
    quality_tag = f"{height}p" if height else "Original"

    video_formats = []
    if video_stream:
        video_formats.append(
            {
                "id": "direct",
                "label": f"Original ({height}p)" if height else "Original Stream",
                "qualityTag": quality_tag,
                "height": height,
                "width": width,
                "fps": fps,
                "ext": ext,
                "vcodec": video_stream.get("codec_name"),
                "acodec": audio_stream.get("codec_name") if audio_stream else None,
                "filesize": filesize,
                "tbr": tbr,
                "hasVideo": True,
                "hasAudio": bool(audio_stream),
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    audio_formats = []
    if audio_stream:
        audio_formats.append(
            {
                "id": "direct-audio",
                "label": f"Original Audio ({(audio_stream.get('codec_name') or 'audio').upper()})",
                "qualityTag": "Audio",
                "height": None,
                "width": None,
                "fps": None,
                "ext": ext if ext in ("mp3", "m4a") else "m4a",
                "vcodec": None,
                "acodec": audio_stream.get("codec_name"),
                "filesize": None if video_stream else filesize,
                "tbr": round(int(audio_stream["bit_rate"]) / 1000)
                if audio_stream.get("bit_rate")
                else None,
                "hasVideo": False,
                "hasAudio": True,
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    return {
        "url": url,
        "webpageUrl": url,
        "title": title,
        "thumbnail": None,
        "duration": duration,
        "durationFormatted": format_duration(duration),
        "uploader": parsed_url.hostname,
        "source": detect_source_name(parsed_url),
        "extractor": "ffprobe-direct",
        "isDirectMedia": True,
        "hasAudioTrack": bool(audio_stream),
        "canTrim": bool(duration and duration > 0),
        "canChangeSpeed": bool(video_stream),
        "videoFormats": video_formats,
        "audioFormats": audio_formats,
        "limits": {
            "maxFileSizeMb": Config.MAX_FILE_SIZE_MB,
            "maxDurationSec": Config.MAX_DURATION_SEC,
        },
    }


def _build_formats(info: dict) -> tuple[list[dict], list[dict], bool]:
    raw_formats = info.get("formats") or []
    if any(f.get("has_drm") for f in raw_formats):
        raise ValueError("This media contains DRM-protected streams and cannot be downloaded.")

    audio_raw = [
        f
        for f in raw_formats
        if f.get("format_id")
        and f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")
    ]
    audio_raw.sort(key=lambda f: f.get("abr") or f.get("tbr") or 0, reverse=True)
    best_audio = audio_raw[0] if audio_raw else None

    video_raw = [
        f for f in raw_formats if f.get("format_id") and f.get("vcodec") not in (None, "none")
    ]
    has_muxed = any(f.get("acodec") not in (None, "none") for f in video_raw)
    has_audio_track = bool(best_audio or has_muxed or info.get("acodec") not in (None, "none"))

    by_height: dict[int, dict] = {}
    for f in video_raw:
        height = f.get("height") or 0
        is_muxed = f.get("acodec") not in (None, "none")
        needs_merge = (not is_muxed) and (best_audio is not None)
        est_size = f.get("filesize") or f.get("filesize_approx")
        audio_size = (best_audio or {}).get("filesize") or (best_audio or {}).get("filesize_approx")
        merged_size = (est_size + audio_size) if (needs_merge and est_size and audio_size) else est_size

        opt = {
            "id": f["format_id"],
            "label": f"{height}p" if height > 0 else (f.get("format_note") or "Original"),
            "qualityTag": f"{height}p" if height > 0 else "Original",
            "height": height if height > 0 else None,
            "width": f.get("width") if (f.get("width") or 0) > 0 else None,
            "fps": round(f["fps"]) if f.get("fps") else None,
            "ext": f.get("ext") or "mp4",
            "vcodec": f.get("vcodec"),
            "acodec": f.get("acodec") if is_muxed else (best_audio or {}).get("acodec"),
            "filesize": merged_size,
            "tbr": round(f["tbr"]) if f.get("tbr") else None,
            "hasVideo": True,
            "hasAudio": is_muxed or (best_audio is not None),
            "needsMerge": needs_merge,
            "audioFormatId": best_audio["format_id"] if needs_merge and best_audio else None,
        }

        def _score(item: dict) -> float:
            s = 0.0
            if item["ext"] == "mp4":
                s += 1000
            if not item["needsMerge"]:
                s += 500
            vc = (item.get("vcodec") or "").lower()
            if vc.startswith("avc1") or vc.startswith("h264"):
                s += 200
            s += (item.get("tbr") or 0) / 100.0
            return s

        if height not in by_height or _score(opt) > _score(by_height[height]):
            by_height[height] = opt

    sorted_heights = [by_height[h] for h in sorted(by_height.keys(), reverse=True)]
    if not sorted_heights and info.get("url"):
        h = info.get("height")
        sorted_heights.append(
            {
                "id": "best",
                "label": f"Original ({h}p)" if h else "Original",
                "qualityTag": f"{h}p" if h else "Original",
                "height": h,
                "width": info.get("width"),
                "fps": None,
                "ext": info.get("ext") or "mp4",
                "vcodec": info.get("vcodec") if info.get("vcodec") != "none" else None,
                "acodec": info.get("acodec") if info.get("acodec") != "none" else None,
                "filesize": info.get("filesize") or info.get("filesize_approx"),
                "tbr": None,
                "hasVideo": True,
                "hasAudio": info.get("acodec") not in (None, "none"),
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    video_formats = []
    if sorted_heights:
        top = dict(sorted_heights[0])
        top["label"] = f"Original ({top['height']}p)" if top.get("height") else "Original (Best Available)"
        top["qualityTag"] = "Original"
        video_formats.append(top)
        for fmt in sorted_heights[1:]:
            if fmt.get("height"):
                video_formats.append(fmt)

    audio_formats = []
    seen_abr = set()
    for a in audio_raw[:4]:
        kbps = round(a.get("abr") or a.get("tbr") or 0)
        ext = a.get("ext") or "m4a"
        key = f"{ext}-{kbps}"
        if key in seen_abr:
            continue
        seen_abr.add(key)
        audio_formats.append(
            {
                "id": a["format_id"],
                "label": f"{kbps} kbps ({ext.upper()})" if kbps > 0 else f"Audio ({ext.upper()})",
                "qualityTag": f"{kbps}kbps" if kbps > 0 else "Audio",
                "height": None,
                "width": None,
                "fps": None,
                "ext": ext,
                "vcodec": None,
                "acodec": a.get("acodec"),
                "filesize": a.get("filesize") or a.get("filesize_approx"),
                "tbr": kbps or None,
                "hasVideo": False,
                "hasAudio": True,
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    if not audio_formats and has_audio_track:
        audio_formats.append(
            {
                "id": sorted_heights[0]["id"] if sorted_heights else "best",
                "label": "Extract Audio from Video",
                "qualityTag": "Extracted",
                "height": None,
                "width": None,
                "fps": None,
                "ext": "mp3",
                "vcodec": None,
                "acodec": "mp3",
                "filesize": None,
                "tbr": 192,
                "hasVideo": False,
                "hasAudio": True,
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    return video_formats, audio_formats, has_audio_track


def analyze_media_url(url: str, cookies_text: str | None = None) -> dict:
    parsed = urlparse(url)
    direct_ext = has_direct_media_extension(parsed.path)

    cmd = [
        Config.YTDLP_BIN,
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--socket-timeout",
        "20",
        "--user-agent",
        STANDARD_BROWSER_UA,
    ]
    if Config.NODE_BIN and os.path.exists(Config.NODE_BIN):
        cmd.extend(["--js-runtimes", f"node:{Config.NODE_BIN}"])

    ephemeral_cookies_path: str | None = None
    if cookies_text and cookies_text.strip():
        Config.TEMP_DIR.mkdir(parents=True, exist_ok=True)
        fd, ephemeral_cookies_path = tempfile.mkstemp(
            prefix="cookies_", suffix=".txt", dir=str(Config.TEMP_DIR)
        )
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(cookies_text.strip() + "\n")
        os.chmod(ephemeral_cookies_path, 0o600)
        cmd.extend(["--cookies", ephemeral_cookies_path])
    elif Config.COOKIES_FILE:
        cmd.extend(["--cookies", Config.COOKIES_FILE])
    cmd.append(url)

    ytdlp_error = None
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=35)
        if proc.returncode == 0 and proc.stdout.strip():
            info = json.loads(proc.stdout)
            if info.get("is_live"):
                raise ValueError("Live streams cannot be pre-analyzed or downloaded as finite files.")

            video_formats, audio_formats, has_audio_track = _build_formats(info)
            if direct_ext and len(video_formats) <= 1 and (not video_formats or not video_formats[0].get("height")):
                probed = _probe_direct_media(url)
                if probed:
                    return probed

            if not video_formats and not audio_formats:
                raise ValueError("No downloadable video or audio formats were found at this URL.")

            duration = info.get("duration")
            if duration is not None and duration > Config.MAX_DURATION_SEC:
                raise ValueError(
                    f"Video duration ({format_duration(duration)}) exceeds server limit of {format_duration(Config.MAX_DURATION_SEC)}."
                )

            return {
                "url": url,
                "webpageUrl": info.get("webpage_url") or url,
                "title": info.get("title") or "Untitled Media",
                "thumbnail": info.get("thumbnail"),
                "duration": duration,
                "durationFormatted": format_duration(duration),
                "uploader": info.get("uploader") or info.get("channel"),
                "source": detect_source_name(parsed),
                "extractor": info.get("extractor_key") or info.get("extractor") or "yt-dlp",
                "isDirectMedia": direct_ext,
                "hasAudioTrack": has_audio_track,
                "canTrim": bool(duration and duration > 0),
                "canChangeSpeed": len(video_formats) > 0,
                "videoFormats": video_formats,
                "audioFormats": audio_formats,
                "limits": {
                    "maxFileSizeMb": Config.MAX_FILE_SIZE_MB,
                    "maxDurationSec": Config.MAX_DURATION_SEC,
                },
            }

        ytdlp_error = _classify_error(proc.stderr or "", url)
    except subprocess.TimeoutExpired:
        ytdlp_error = "Media inspection timed out. The remote server took too long to respond."
    except ValueError as err:
        ytdlp_error = str(err)
    except Exception as err:
        ytdlp_error = str(err)
    finally:
        if ephemeral_cookies_path and os.path.exists(ephemeral_cookies_path):
            try:
                os.unlink(ephemeral_cookies_path)
            except Exception:
                pass

    if direct_ext or (ytdlp_error and "drm" not in ytdlp_error.lower()):
        probed = _probe_direct_media(url)
        if probed:
            if probed["duration"] and probed["duration"] > Config.MAX_DURATION_SEC:
                raise ValueError(
                    f"Video duration ({format_duration(probed['duration'])}) exceeds server limit."
                )
            return probed

    raise ValueError(ytdlp_error or "Unable to analyze this URL.")


def get_tool_versions() -> dict:
    def _ver(binary: str, flag: str) -> str | None:
        try:
            proc = subprocess.run([binary, flag], capture_output=True, text=True, timeout=4)
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout.splitlines()[0][:80]
        except Exception:
            pass
        return None

    return {
        "ytdlp": _ver(Config.YTDLP_BIN, "--version"),
        "ffmpeg": _ver(Config.FFMPEG_BIN, "-version"),
        "ffprobe": _ver(Config.FFPROBE_BIN, "-version"),
    }
