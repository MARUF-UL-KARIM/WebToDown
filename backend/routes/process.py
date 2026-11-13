from flask import Blueprint, jsonify
from backend.config import Config
from backend.services.downloader import get_active_job_count
from backend.services.extractor import get_tool_versions

process_bp = Blueprint("process", __name__)


@process_bp.get("/api/health")
def health_endpoint():
    return jsonify(
        {
            "status": "ok",
            "tools": get_tool_versions(),
            "activeJobs": get_active_job_count(),
            "limits": {
                "maxFileSizeMb": Config.MAX_FILE_SIZE_MB,
                "maxDurationSec": Config.MAX_DURATION_SEC,
                "maxConcurrentJobs": Config.MAX_CONCURRENT_JOBS,
            },
        }
    )
