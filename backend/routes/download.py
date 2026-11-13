import json
import mimetypes
import queue
from urllib.parse import quote
from flask import Blueprint, Response, jsonify, request, send_file
from backend.config import Config
from backend.services.downloader import (
    cancel_job,
    create_download_job,
    get_job_output_file,
    get_job_snapshot,
    subscribe_job,
    unsubscribe_job,
)
from backend.utils.validators import is_valid_uuid, validate_public_url

download_bp = Blueprint("download", __name__)


@download_bp.post("/api/jobs")
def create_job_endpoint():
    body = request.get_json(silent=True) or {}
    validation = validate_public_url(body.get("url", ""))
    if not validation.get("valid"):
        return jsonify({"error": validation.get("error", "Invalid URL.")}), 400

    mode = "audio" if body.get("mode") == "audio" else "video"
    container = str(body.get("container") or ("mp3" if mode == "audio" else "mp4")).lower()
    allowed_containers = (
        Config.ALLOWED_AUDIO_CONTAINERS if mode == "audio" else Config.ALLOWED_VIDEO_CONTAINERS
    )
    if container not in allowed_containers:
        return jsonify({"error": f'Unsupported output format "{container}".'}), 400

    try:
        speed = float(body.get("speed", 1.0))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid playback speed."}), 400
    if speed not in Config.ALLOWED_SPEEDS:
        return jsonify({"error": "Playback speed must be 0.5, 1, 1.5, 2, or 3."}), 400

    trim = body.get("trim") or {}
    trim_enabled = bool(trim.get("enabled"))
    try:
        trim_start = float(trim.get("start") or 0)
        trim_end = float(trim.get("end") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid trim time values."}), 400

    if trim_enabled:
        if trim_start < 0 or trim_end <= trim_start:
            return jsonify({"error": "Trim end time must be greater than start time."}), 400
        if trim_end - trim_start > Config.MAX_DURATION_SEC:
            return jsonify({"error": "Trimmed segment exceeds maximum duration limit."}), 400

    cookies_text = body.get("cookiesText")
    payload = {
        "url": validation["normalized_url"],
        "title": str(body.get("title") or "video"),
        "mode": mode,
        "formatId": str(body.get("formatId") or "best"),
        "audioFormatId": body.get("audioFormatId"),
        "needsMerge": bool(body.get("needsMerge")),
        "container": container,
        "isDirectMedia": bool(body.get("isDirectMedia")),
        "duration": body.get("duration"),
        "trim": {"enabled": trim_enabled, "start": trim_start, "end": trim_end},
        "speed": speed,
        "cookiesText": cookies_text[: 256 * 1024] if isinstance(cookies_text, str) else None,
    }

    try:
        snapshot = create_download_job(payload)
        return jsonify(snapshot), 202
    except RuntimeError as err:
        return jsonify({"error": str(err)}), 429


@download_bp.get("/api/jobs/<job_id>")
def job_status_endpoint(job_id: str):
    if not is_valid_uuid(job_id):
        return jsonify({"error": "Invalid job identifier."}), 400
    snap = get_job_snapshot(job_id)
    if not snap:
        return jsonify({"error": "Job not found or already expired."}), 404
    return jsonify(snap)


@download_bp.get("/api/jobs/<job_id>/events")
def job_events_endpoint(job_id: str):
    if not is_valid_uuid(job_id):
        return jsonify({"error": "Invalid job identifier."}), 400
    sub_q = subscribe_job(job_id)
    if not sub_q:
        return jsonify({"error": "Job not found or already expired."}), 404

    def _stream():
        try:
            while True:
                try:
                    snap = sub_q.get(timeout=15)
                    yield f"data: {json.dumps(snap)}\n\n"
                    if snap["status"] in ("ready", "error", "cancelled"):
                        break
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            unsubscribe_job(job_id, sub_q)

    return Response(
        _stream(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@download_bp.post("/api/jobs/<job_id>/cancel")
def cancel_job_endpoint(job_id: str):
    if not is_valid_uuid(job_id):
        return jsonify({"error": "Invalid job identifier."}), 400
    if not cancel_job(job_id):
        return jsonify({"error": "Active job not found."}), 404
    return jsonify({"status": "cancelled", "jobId": job_id})


@download_bp.get("/api/jobs/<job_id>/file")
def serve_job_file(job_id: str):
    if not is_valid_uuid(job_id):
        return jsonify({"error": "Invalid job identifier."}), 400
    result = get_job_output_file(job_id)
    if not result:
        return jsonify({"error": "File is not ready or has been cleaned up."}), 404

    file_path, filename, _size = result
    mime_type, _ = mimetypes.guess_type(filename)
    resp = send_file(
        file_path,
        mimetype=mime_type or "application/octet-stream",
        as_attachment=True,
        download_name=filename,
        conditional=True,
    )
    ascii_fallback = (
        "".join(ch if 32 <= ord(ch) <= 126 and ch not in '"\\' else "_" for ch in filename).strip()
        or "download"
    )
    resp.headers["Content-Disposition"] = (
        f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{quote(filename)}'
    )
    return resp
