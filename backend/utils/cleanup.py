import shutil
import time
from pathlib import Path
from backend.config import Config


def ensure_temp_dir() -> None:
    Config.TEMP_DIR.mkdir(parents=True, exist_ok=True)


def remove_dir_safe(dir_path: Path) -> None:
    try:
        resolved = dir_path.resolve()
        if not str(resolved).startswith(str(Config.TEMP_DIR)):
            return
        if resolved.exists():
            shutil.rmtree(resolved, ignore_errors=True)
    except Exception:
        pass


def purge_expired_directories(active_job_ids: set[str]) -> int:
    ensure_temp_dir()
    max_age_sec = Config.AUTO_CLEANUP_MINUTES * 60
    now = time.time()
    removed = 0

    try:
        for entry in Config.TEMP_DIR.iterdir():
            if not entry.is_dir() or entry.name in active_job_ids:
                continue
            try:
                if now - entry.stat().st_mtime > max_age_sec:
                    shutil.rmtree(entry, ignore_errors=True)
                    removed += 1
            except Exception:
                pass
    except Exception:
        pass

    return removed
