# Media Converter Pro — Deployable Web App

This is the actual full-stack converter, not only a static mockup. The FastAPI application serves the interactive converter at `/`, the project case study at `/project`, and a health check at `/health`.

## What it does

- Converts supported public YouTube / Instagram media to MP4 or MP3 using yt-dlp and FFmpeg.
- Provides selectable video resolution or audio bitrate.
- Streams task progress over WebSockets, with REST status polling as a fallback.
- Creates task-specific output folders and temporary download links.

Use this only for content you own or are authorized to download, and follow applicable platform terms and copyright rules. Public hosting can be abused, so do not treat this starter deployment as a hardened commercial service.

## Deploy online using Render (Docker)

1. Extract this ZIP.
2. Create a new GitHub repository and upload the **contents** of the `Media-Converter-Pro-Code` folder (so `Dockerfile`, `app.py`, `requirements.txt`, `render.yaml`, `templates/` and `static/` are at repository root).
3. Sign in to Render and choose **New + → Blueprint**.
4. Connect the repository. Render reads `render.yaml`, builds the Docker image, and installs FFmpeg and Node.js for yt-dlp.
5. Wait for deployment to finish, then open the generated `https://...onrender.com` URL. The converter itself is at the root `/`.
6. Check `/health`; it should return `{"status":"ok","ffmpeg_available":true}`.
7. In your portfolio, link the Media Converter Pro card to the deployed service URL. For the case-study page use `https://YOUR-SERVICE.onrender.com/project`.

The first request after an idle period on a free service may take time while the host wakes up. A free service has limited CPU/RAM and may not handle large files or heavy traffic. The local output folder and in-memory task records are temporary; completed files and tasks can be lost on restart/redeploy. Use a persistent disk and a durable job queue before treating this as a production service.

## Run on Windows locally

Install Python 3.10+ and FFmpeg. Ensure `ffmpeg -version` works in a new terminal.

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
py -m pip install --upgrade pip
py -m pip install -r requirements.txt
py -m uvicorn app:app --reload
```

Open `http://127.0.0.1:8000`.

## Run on macOS/Linux

Install Python 3.10+, FFmpeg, and (recommended for some current yt-dlp challenge handling) Node.js. Then run:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m uvicorn app:app --reload
```

## API routes

- `GET /` — working converter UI.
- `GET /project` — portfolio case study.
- `GET /health` — health check and FFmpeg availability.
- `POST /convert` — create a conversion task. Example body: `{"url":"https://www.youtube.com/watch?v=...","format":"mp4","quality":"720"}`.
- `GET /status/{task_id}` — task status.
- `WS /ws/{task_id}` — progress stream.
- `GET /download/{task_id}` — download completed output.

Video qualities: `best`, `1080`, `720`, `480`, `360`. Audio bitrates: `128`, `192`, `256`, `320`.

## Notes

- Some sources may require updated yt-dlp versions or may temporarily block requests.
- Private/login-gated media is not supported by default.
- Do not expose a public instance without abuse controls, usage limits, monitoring, and a plan for temporary file storage.
