from collections import deque
import subprocess
import threading
from pathlib import Path
from backend.config import Config


def probe_has_audio(file_path: Path) -> bool:
    try:
        proc = subprocess.run(
            [
                Config.FFPROBE_BIN,
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return bool(proc.stdout.strip())
    except Exception:
        return False


def probe_duration(file_path: Path) -> float | None:
    try:
        proc = subprocess.run(
            [
                Config.FFPROBE_BIN,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        val = float(proc.stdout.strip())
        return val if val > 0 else None
    except Exception:
        return None


def build_atempo_chain(speed: float) -> str:
    if speed == 0.5:
        return "atempo=0.5"
    if speed == 1.5:
        return "atempo=1.5"
    if speed == 2.0:
        return "atempo=2.0"
    if speed == 3.0:
        return "atempo=2.0,atempo=1.5"
    return "atempo=1.0"


def process_media_with_ffmpeg(
    job: dict,
    source_path: Path,
    output_path: Path,
    mode: str,
    container: str,
    trim_enabled: bool,
    trim_start: float,
    trim_end: float,
    speed: float,
    on_progress,
) -> None:
    source_duration = probe_duration(source_path) or job.get("duration") or 0.0
    has_audio = probe_has_audio(source_path)

    if mode == "audio" and not has_audio:
        raise RuntimeError("Source media contains no audio track to extract.")

    t_start = max(0.0, trim_start) if trim_enabled else 0.0
    t_end = trim_end if (trim_enabled and trim_end > t_start) else source_duration
    clip_duration = (t_end - t_start) if t_end > t_start else source_duration
    expected_out_dur = clip_duration / speed if clip_duration > 0 else 0.0

    cmd = [Config.FFMPEG_BIN, "-y", "-progress", "pipe:1", "-nostats"]
    if trim_enabled and t_start > 0:
        cmd.extend(["-ss", str(t_start)])
    if trim_enabled and t_end > t_start:
        cmd.extend(["-t", str(t_end - t_start)])
    cmd.extend(["-i", str(source_path)])

    speed_changed = abs(speed - 1.0) > 1e-6
    source_ext = source_path.suffix.lstrip(".").lower()

    if mode == "audio":
        cmd.append("-vn")
        if speed_changed and has_audio:
            cmd.extend(["-filter:a", f"asetpts=PTS-STARTPTS,{build_atempo_chain(speed)}"])
        if container == "mp3":
            cmd.extend(["-c:a", "libmp3lame", "-b:a", "192k"])
        else:
            cmd.extend(["-c:a", "aac", "-b:a", "192k"])
    elif (not speed_changed) and source_ext == container:
        cmd.extend(["-c", "copy"])
        if container == "mp4":
            cmd.extend(["-movflags", "+faststart"])
    else:
        if speed_changed:
            cmd.extend(["-filter:v", f"setpts=(PTS-STARTPTS)/{speed}"])
            if has_audio:
                cmd.extend(["-filter:a", f"asetpts=PTS-STARTPTS,{build_atempo_chain(speed)}"])
        if container == "webm":
            cmd.extend(["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-deadline", "realtime"])
            if has_audio:
                cmd.extend(["-c:a", "libopus", "-b:a", "128k"])
        else:
            cmd.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"])
            if has_audio:
                cmd.extend(["-c:a", "aac", "-b:a", "192k"])
            if container == "mp4":
                cmd.extend(["-movflags", "+faststart"])

    cmd.append(str(output_path))

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    job["active_proc"] = proc

    stderr_tail: deque[str] = deque(maxlen=40)

    def _drain_stderr() -> None:
        if not proc.stderr:
            return
        try:
            for err_line in proc.stderr:
                stderr_tail.append(err_line.rstrip())
        except Exception:
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    try:
        if proc.stdout:
            for line in proc.stdout:
                if job["status"] == "cancelled":
                    proc.terminate()
                    raise RuntimeError("Processing cancelled by user.")
                line = line.strip()
                if line.startswith("out_time_us=") and expected_out_dur > 0:
                    try:
                        us = int(line.split("=", 1)[1])
                        pct = min(99, max(0, round((us / 1_000_000.0 / expected_out_dur) * 100)))
                        on_progress(pct)
                    except ValueError:
                        pass

        returncode = proc.wait(timeout=Config.JOB_TIMEOUT_SEC)
        stderr_thread.join(timeout=2)
        if job["status"] == "cancelled":
            raise RuntimeError("Processing cancelled by user.")
        if returncode != 0:
            tail = " ".join(list(stderr_tail)[-3:])
            raise RuntimeError(f"FFmpeg processing failed: {tail or f'exit code {returncode}'}")
    finally:
        job["active_proc"] = None
        if proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
