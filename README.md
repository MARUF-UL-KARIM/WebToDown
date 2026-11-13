# ClipFetch — Universal Online Video Downloader

A production-oriented online video downloader supporting genuine stream extraction, format inspection, video/audio stream merging, FFmpeg segment trimming, and playback speed conversion (`0.5x`, `1x`, `1.5x`, `2x`, `3x`) with real-time Server-Sent Events (SSE) progress and cancellation.

## Repository Structure

This repository provides two feature-identical runtime stacks sharing the exact same REST API contract:

1. **Live Web Runtime (Node.js + Express + React/Vite on port 3000)**:
   - `server.ts`, `server/` (`config.ts`, `validators.ts`, `cleanup.ts`, `extractor.ts`, `processor.ts`)
   - `src/` (Mobile-first responsive React + TypeScript + Tailwind CSS UI)
2. **Modular Python + Flask + Vanilla JS Stack**:
   - `backend/` (`app.py`, `config.py`, `routes/`, `services/`, `utils/`)
   - `frontend/` (`index.html`, `css/style.css`, `js/app.js`, `js/analyzer.js`, `js/downloader.js`)
   - `requirements.txt`, `Dockerfile`, `render.yaml`

---

## Core Features

- **Real URL Analysis**: Validates public HTTP/HTTPS URLs, prevents SSRF against private/loopback/metadata IPs, and inspects streams using `yt-dlp` and `ffprobe`.
- **Genuine Formats Only**: Displays only resolutions actually present in the media (`Original`, `2160p`, `1440p`, `1080p`, `720p`, `480p`, `360p`) plus real audio-only streams. Never fabricates unavailable resolutions.
- **Automatic Stream Merging**: Combines separate high-resolution video and audio tracks with FFmpeg when required.
- **Video Trimming**: Extracts custom start/end time ranges (`HH:MM:SS` or slider controls). Uses lossless `-c copy` when container and `1x` speed match.
- **Playback Speed (`0.5x` – `3x`)**: Adjusts video timing (`setpts`) and audio tempo (`atempo`, chaining `2.0,1.5` for `3x`) while verifying audio track presence via `ffprobe`.
- **Real Download Manager**: Streams real `yt-dlp` / HTTP / `ffmpeg` progress over SSE, supports immediate job cancellation (`SIGTERM`/`SIGKILL`), and supports HTTP `Range` requests for mobile browsers.
- **Automatic Cleanup**: Stores each job in an isolated UUID temp directory and deletes files after cancellation or `AUTO_CLEANUP_MINUTES`.

---

## Compatibility Matrix

| Source | Support | Technical Reality |
| --- | --- | --- |
| Direct video URLs (`.mp4`, `.webm`, `.mov`, `.m3u8`) | Full | Extracted via `yt-dlp` or `ffprobe` fallback. Supports trimming & speed conversion. |
| Wikimedia Commons / Internet Archive / Vimeo Public | Full | Works consistently across cloud and local hosts. |
| YouTube (Public Videos) | Conditional | Works reliably on local/residential IPs (and Android Termux). Shared datacenter IPs often receive YouTube bot-verification challenges unless cookies (`YTDLP_COOKIES_FILE`) are supplied. |
| Facebook / Instagram / TikTok / X | Public Only | Works for public posts via `yt-dlp` when not login-gated or rate-limited. |
| DRM / Paywalled / Private Media | Unsupported | Blocked intentionally. Never bypasses DRM, authentication, or access controls. |

---

## Free-Tier Hosting Reality Check

| Provider | Free Limits | FFmpeg & Large Video Feasibility |
| --- | --- | --- |
| **Vercel / Netlify** | 10–60s serverless timeout, no persistent FFmpeg runtime | **Unsuitable for backend** (frontend static files only). |
| **Render Free** | 512 MB RAM, 0.1 CPU, 15m sleep timeout | **Small clips only** (`MAX_FILE_SIZE_MB=250`). 1080p speed re-encoding can exhaust 512 MB RAM. |
| **Hugging Face Spaces (Docker)** | 16 GB RAM, 2 vCPU, 50 GB ephemeral disk | **Recommended free cloud host** for `Dockerfile` deployment with FFmpeg. |
| **Oracle Cloud Always Free** | Up to 24 GB RAM, 4 ARM OCPUs, persistent storage | **Best production free tier** (no sleep, full root control). |
| **Android Termux (Local)** | Device storage + residential mobile IP | **Best reliability** for YouTube & mobile offline saving. |

---

## Local Setup & Running

### Option A: Python + Flask Backend + Vanilla JS Frontend

1. Install system dependencies: `ffmpeg` (`ffprobe` included) and Node.js (recommended for `yt-dlp` JS extraction).
2. Create a virtual environment and install Python packages:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Copy `.env.example` to `.env` and adjust limits if needed.
4. Start the Flask server:
   ```bash
   python -m backend.app
   ```
5. Open `http://localhost:5000` in your browser.

### Option B: Node.js + Express + React/Vite Runtime (Port 3000)

1. Ensure `ffmpeg`, `ffprobe`, and `yt-dlp` (or `./bin/yt-dlp`) are available.
2. Install dependencies and start:
   ```bash
   npm install
   npm run dev
   ```
3. Open `http://localhost:3000`.

### Option C: Android Phone Self-Hosting (Termux)

Running ClipFetch directly inside Termux on Android avoids cloud datacenter IP blocks and writes fast local temp files:

```bash
pkg update && pkg upgrade -y
pkg install -y python ffmpeg nodejs git
pip install flask flask-cors gunicorn python-dotenv yt-dlp
git clone <your-repo-url> clipfetch && cd clipfetch
python -m backend.app
```

Then open `http://127.0.0.1:5000` in Chrome or Firefox on the same Android device.

---

## Testing Checklist

1. **Health Check**: `curl http://localhost:3000/api/health` (or `:5000`) -> confirms `yt-dlp`, `ffmpeg`, and `ffprobe` versions.
2. **Analyze Valid Direct Video**: POST `/api/analyze` with a public `.webm`/`.mp4` URL -> verifies metadata, duration, and genuine resolution list.
3. **SSRF Security Block**: POST `/api/analyze` with `http://127.0.0.1:3000` or `http://169.254.169.254/latest/meta-data` -> returns HTTP `400` security block.
4. **Trim & Playback Speed**: Enable trim (`00:02` to `00:07`), select `1.5x` or `2x`, start download, verify real progress over SSE, and inspect output file duration via `ffprobe`.
5. **Cancellation**: Start a download and click **Cancel** mid-transfer -> verifies `POST /api/jobs/:id/cancel` terminates the child process and removes temp files.
