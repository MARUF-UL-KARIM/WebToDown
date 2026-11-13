import os
import queue
import re
import subprocess
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlparse
from backend.config import Config
from backend.services.extractor import STANDARD_BROWSER_UA
from backend.services.video_processor import process_media_with_ffmpeg
from backend.utils.cleanup import ensure_temp_dir, purge_expired_directories, remove_dir_safe
from backend.utils.validators import safe_urlopen, sanitize_filename

_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {}

YTDLP_PROGRESS_RE = re.compile(
    r"\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\S+)(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?",
    re.IGNORECASE,
)


def _parse_size_to_bytes(text: str) -> int | None:
    match = re.match(r"^([\d.]+)\s*(Ki?B|Mi?B|Gi?B|B)$", text.strip(), re.IGNORECASE)
    if not match:
        return None
    val = float(match.group(1))
    unit = match.group(2).upper()
    multipliers = {
        "B": 1,
        "KB": 1000,
        "KIB": 1024,
        "MB": 1000 * 1000,
        "MIB": 1024 * 1024,
        "GB": 1000 * 1000 * 1000,
        "GIB": 1024 * 1024 * 1024,
    }
    return round(val * multipliers[unit]) if unit in multipliers else None


def to_public_snapshot(job: dict) -> dict:
    return {
        "jobId": job["jobId"],
        "status": job["status"],
        "phaseLabel": job["phaseLabel"],
        "progress": job["progress"],
        "downloadedBytes": job["downloadedBytes"],
        "totalBytes": job["totalBytes"],
        "speedText": job["speedText"],
        "etaText": job["etaText"],
        "filename": job["filename"],
        "fileSize": job["fileSize"],
        "downloadUrl": job["downloadUrl"],
        "error": job["error"],
        "createdAt": job["createdAt"],
    }


def _emit_update(job: dict) -> None:
    snap = to_public_snapshot(job)
    for q in list(job["subscribers"]):
        try:
            q.put_nowait(snap)
        except Exception:
            pass


def _schedule_cleanup(job: dict) -> None:
    def _cleanup():
        time.sleep(Config.AUTO_CLEANUP_MINUTES * 60)
        remove_dir_safe(job["work_dir"])
        with _jobs_lock:
            _jobs.pop(job["jobId"], None)

    t = threading.Thread(target=_cleanup, daemon=True)
    t.start()


def get_active_job_count() -> int:
    with _jobs_lock:
        return sum(
            1
            for j in _jobs.values()
            if j["status"] in ("queued", "downloading", "merging", "processing")
        )


def get_all_job_ids() -> set[str]:
    with _jobs_lock:
        return set(_jobs.keys())


def cleanup_all_active_jobs() -> None:
    with _jobs_lock:
        jobs_list = list(_jobs.values())
    for job in jobs_list:
        proc = job.get("active_proc")
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
        remove_dir_safe(job["work_dir"])


def get_job_snapshot(job_id: str) -> dict | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return to_public_snapshot(job) if job else None


def get_job_output_file(job_id: str) -> tuple[Path, str, int] | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job["status"] != "ready" or not job["output_path"] or not job["filename"]:
            return None
        path = Path(job["output_path"])
        if not path.exists():
            return None
        return path, job["filename"], path.stat().st_size


def subscribe_job(job_id: str) -> queue.Queue | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return None
        q: queue.Queue = queue.Queue()
        job["subscribers"].append(q)
        q.put_nowait(to_public_snapshot(job))
        return q


def unsubscribe_job(job_id: str, q: queue.Queue) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job and q in job["subscribers"]:
            job["subscribers"].remove(q)


def cancel_job(job_id: str) -> bool:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return False
        if job["status"] in ("ready", "error", "cancelled"):
            remove_dir_safe(job["work_dir"])
            return job["status"] == "cancelled"
        job["status"] = "cancelled"
        job["phaseLabel"] = "Cancelled by user"
        job["error"] = "Download cancelled by user."
        proc = job.get("active_proc")

    if proc:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    _emit_update(job)
    remove_dir_safe(job["work_dir"])
    _schedule_cleanup(job)
    return True


def _download_direct_http(job: dict, url: str, target_path: Path) -> None:
    hostname = (urlparse(url).hostname or "").lower()
    ua = "ClipFetch/1.0 (+https://github.com/clipfetch)" if hostname.endswith("wikimedia.org") else STANDARD_BROWSER_UA
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    max_bytes = Config.MAX_FILE_SIZE_MB * 1024 * 1024

    with safe_urlopen(req, timeout=30) as resp:
        total_header = resp.headers.get("Content-Length")
        total_bytes = int(total_header) if total_header and total_header.isdigit() else None
        if total_bytes and total_bytes > max_bytes:
            raise ValueError(f"File exceeds {Config.MAX_FILE_SIZE_MB} MB limit.")

        job["totalBytes"] = total_bytes
        job["downloadedBytes"] = 0
        job["progress"] = 0 if total_bytes else None
        _emit_update(job)

        last_emit = time.time()
        bytes_since = 0
        last_speed = time.time()

        with open(target_path, "wb") as fh:
            while True:
                if job["status"] == "cancelled":
                    raise RuntimeError("Download cancelled by user.")
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                fh.write(chunk)
                job["downloadedBytes"] += len(chunk)
                bytes_since += len(chunk)
                if job["downloadedBytes"] > max_bytes:
                    raise ValueError(f"Download aborted: exceeded {Config.MAX_FILE_SIZE_MB} MB limit.")

                now = time.time()
                if now - last_emit >= 0.25:
                    dt = max(now - last_speed, 0.1)
                    bps = bytes_since / dt
                    job["speedText"] = (
                        f"{bps / (1024 * 1024):.2f} MB/s"
                        if bps > 1024 * 1024
                        else f"{bps / 1024:.0f} KB/s"
                    )
                    if total_bytes:
                        job["progress"] = min(99, round((job["downloadedBytes"] / total_bytes) * 100))
                        rem = max(0, total_bytes - job["downloadedBytes"])
                        if bps > 0:
                            job["etaText"] = f"{round(rem / bps)}s"
                    _emit_update(job)
                    last_emit = now
                    bytes_since = 0
                    last_speed = now


def _download_with_ytdlp(job: dict, payload: dict, output_template: str) -> Path:
    cmd = [
        Config.YTDLP_BIN,
        "--no-playlist",
        "--newline",
        "--progress",
        "--no-part",
        "--max-filesize",
        f"{Config.MAX_FILE_SIZE_MB}M",
        "--user-agent",
        STANDARD_BROWSER_UA,
        "--ffmpeg-location",
        str(Path(Config.FFMPEG_BIN).parent),
        "-o",
        output_template,
    ]
    if Config.NODE_BIN and os.path.exists(Config.NODE_BIN):
        cmd.extend(["--js-runtimes", f"node:{Config.NODE_BIN}"])

    ephemeral_cookies_path: Path | None = None
    cookies_text = payload.get("cookiesText")
    if isinstance(cookies_text, str) and cookies_text.strip():
        ephemeral_cookies_path = job["work_dir"] / "cookies.txt"
        ephemeral_cookies_path.write_text(cookies_text.strip() + "\n", encoding="utf-8")
        os.chmod(ephemeral_cookies_path, 0o600)
        cmd.extend(["--cookies", str(ephemeral_cookies_path)])
    elif Config.COOKIES_FILE:
        cmd.extend(["--cookies", Config.COOKIES_FILE])

    mode = payload["mode"]
    fmt_id = payload["formatId"]
    if mode == "audio":
        cmd.extend(["-f", f"{fmt_id}/bestaudio/best" if fmt_id != "best" else "bestaudio/best"])
    elif payload.get("needsMerge") and payload.get("audioFormatId"):
        cmd.extend(["-f", f"{fmt_id}+{payload['audioFormatId']}/bestvideo+bestaudio/best"])
        cmd.extend(["--merge-output-format", "mp4"])
    elif fmt_id not in ("best", "direct", ""):
        cmd.extend(["-f", f"{fmt_id}/best"])
    else:
        cmd.extend(["-f", "bestvideo+bestaudio/best"])

    cmd.append(payload["url"])

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    job["active_proc"] = proc
    error_lines = []

    try:
        if proc.stdout:
            for raw_line in proc.stdout:
                if job["status"] == "cancelled":
                    proc.terminate()
                    raise RuntimeError("Download cancelled by user.")
                line = raw_line.strip()
                if line.startswith("ERROR:"):
                    error_lines.append(line[6:].strip())
                if "[Merger]" in line or "Merging formats" in line:
                    job["status"] = "merging"
                    job["phaseLabel"] = "Merging video & audio streams with FFmpeg"
                    job["progress"] = 95
                    _emit_update(job)
                    continue
                m = YTDLP_PROGRESS_RE.search(line)
                if m:
                    pct = float(m.group(1))
                    total_b = _parse_size_to_bytes(m.group(2))
                    job["status"] = "downloading"
                    job["phaseLabel"] = "Downloading media stream"
                    job["progress"] = min(99, round(pct))
                    if total_b:
                        job["totalBytes"] = total_b
                        job["downloadedBytes"] = round(total_b * (job["progress"] / 100.0))
                    job["speedText"] = m.group(3)
                    job["etaText"] = m.group(4)
                    _emit_update(job)

        rc = proc.wait(timeout=Config.JOB_TIMEOUT_SEC)
        if job["status"] == "cancelled":
            raise RuntimeError("Download cancelled by user.")
        if rc != 0:
            raise RuntimeError(error_lines[0] if error_lines else f"yt-dlp exited with code {rc}")
    finally:
        job["active_proc"] = None
        if proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
        if ephemeral_cookies_path and ephemeral_cookies_path.exists():
            try:
                ephemeral_cookies_path.unlink(missing_ok=True)
            except Exception:
                pass

    files = [p for p in job["work_dir"].iterdir() if p.name.startswith("source.")]
    if not files:
        raise RuntimeError("Download finished but no source file was produced.")
    return files[0]


def _run_pipeline(job: dict, payload: dict) -> None:
    try:
        job["status"] = "downloading"
        job["phaseLabel"] = "Connecting to media source"
        _emit_update(job)

        if payload.get("isDirectMedia") and payload["formatId"] == "direct" and not payload.get("needsMerge"):
            ext = Path(urlparse(payload["url"]).path).suffix.lower() or f".{payload['container']}"
            source_path = job["work_dir"] / f"source{ext}"
            job["phaseLabel"] = "Downloading direct video stream"
            _emit_update(job)
            _download_direct_http(job, payload["url"], source_path)
        else:
            source_path = _download_with_ytdlp(job, payload, str(job["work_dir"] / "source.%(ext)s"))

        if job["status"] == "cancelled":
            return

        source_ext = source_path.suffix.lstrip(".").lower()
        trim = payload.get("trim") or {}
        trim_enabled = bool(trim.get("enabled"))
        speed = float(payload.get("speed") or 1.0)
        needs_ffmpeg = (
            payload["mode"] == "audio"
            or trim_enabled
            or abs(speed - 1.0) > 1e-6
            or source_ext != payload["container"]
        )

        clean_title = sanitize_filename(payload.get("title") or "video")
        suffix_parts = []
        if trim_enabled:
            suffix_parts.append("trimmed")
        if abs(speed - 1.0) > 1e-6:
            suffix_parts.append(f"{speed:g}x")
        suffix = f"_{'_'.join(suffix_parts)}" if suffix_parts else ""
        final_filename = f"{clean_title}{suffix}.{payload['container']}"
        final_path = job["work_dir"] / f"final.{payload['container']}"

        if needs_ffmpeg:
            job["status"] = "processing"
            job["phaseLabel"] = (
                f"Adjusting playback speed ({speed:g}x) with FFmpeg"
                if abs(speed - 1.0) > 1e-6
                else "Trimming video segment with FFmpeg"
                if trim_enabled
                else f"Converting media to {payload['container'].upper()}"
            )
            job["progress"] = 0
            job["speedText"] = None
            job["etaText"] = None
            _emit_update(job)

            def _on_ffmpeg_pct(pct: int) -> None:
                job["progress"] = pct
                _emit_update(job)

            process_media_with_ffmpeg(
                job=job,
                source_path=source_path,
                output_path=final_path,
                mode=payload["mode"],
                container=payload["container"],
                trim_enabled=trim_enabled,
                trim_start=float(trim.get("start") or 0),
                trim_end=float(trim.get("end") or 0),
                speed=speed,
                on_progress=_on_ffmpeg_pct,
            )
            if source_path != final_path and source_path.exists():
                source_path.unlink(missing_ok=True)
        else:
            source_path.rename(final_path)

        if job["status"] == "cancelled":
            return

        final_size = final_path.stat().st_size
        if final_size <= 0:
            raise RuntimeError("Output media file is empty.")

        job["output_path"] = str(final_path)
        job["filename"] = final_filename
        job["fileSize"] = final_size
        job["downloadedBytes"] = final_size
        job["totalBytes"] = final_size
        job["progress"] = 100
        job["status"] = "ready"
        job["phaseLabel"] = "Ready to save"
        job["speedText"] = None
        job["etaText"] = None
        job["downloadUrl"] = f"/api/jobs/{job['jobId']}/file"
        _emit_update(job)
        _schedule_cleanup(job)
    except Exception as exc:
        if job["status"] != "cancelled":
            job["status"] = "error"
            job["phaseLabel"] = "Failed"
            job["error"] = str(exc)
            _emit_update(job)
            remove_dir_safe(job["work_dir"])
            _schedule_cleanup(job)


def create_download_job(payload: dict) -> dict:
    ensure_temp_dir()
    with _jobs_lock:
        active_ids = set(_jobs.keys())
    purge_expired_directories(active_ids)

    if get_active_job_count() >= Config.MAX_CONCURRENT_JOBS:
        raise RuntimeError(
            f"Server is processing {Config.MAX_CONCURRENT_JOBS} active jobs. Wait or cancel one."
        )

    job_id = str(uuid.uuid4())
    work_dir = Config.TEMP_DIR / job_id
    work_dir.mkdir(parents=True, exist_ok=True)

    job = {
        "jobId": job_id,
        "status": "queued",
        "phaseLabel": "Queued",
        "progress": 0,
        "downloadedBytes": 0,
        "totalBytes": None,
        "speedText": None,
        "etaText": None,
        "filename": None,
        "fileSize": None,
        "downloadUrl": None,
        "error": None,
        "createdAt": int(time.time() * 1000),
        "duration": payload.get("duration"),
        "work_dir": work_dir,
        "output_path": None,
        "active_proc": None,
        "subscribers": [],
    }

    with _jobs_lock:
        _jobs[job_id] = job

    worker = threading.Thread(target=_run_pipeline, args=(job, payload), daemon=True)
    worker.start()
    return to_public_snapshot(job)
