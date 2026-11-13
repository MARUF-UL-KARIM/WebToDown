import atexit
import threading
import time
from pathlib import Path
from flask import Flask, send_from_directory
from flask_cors import CORS
from backend.config import Config
from backend.routes.analyze import analyze_bp
from backend.routes.download import download_bp
from backend.routes.process import process_bp
from backend.services.downloader import cleanup_all_active_jobs, get_all_job_ids
from backend.utils.cleanup import ensure_temp_dir, purge_expired_directories


def _start_periodic_cleanup() -> None:
    def _loop() -> None:
        while True:
            time.sleep(300)
            try:
                purge_expired_directories(get_all_job_ids())
            except Exception:
                pass

    t = threading.Thread(target=_loop, daemon=True)
    t.start()


def create_app() -> Flask:
    ensure_temp_dir()
    purge_expired_directories(set())
    _start_periodic_cleanup()
    atexit.register(cleanup_all_active_jobs)

    frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
    app = Flask(__name__, static_folder=str(frontend_dir), static_url_path="")
    app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024

    CORS(app, resources={r"/api/*": {"origins": Config.CORS_ORIGINS}})

    app.register_blueprint(analyze_bp)
    app.register_blueprint(download_bp)
    app.register_blueprint(process_bp)

    @app.after_request
    def add_security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/")
    def index():
        return send_from_directory(str(frontend_dir), "index.html")

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG, threaded=True)
