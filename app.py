from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"
for directory in (DOWNLOAD_DIR, STATIC_DIR, TEMPLATE_DIR):
    directory.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("media_converter_pro")

app = FastAPI(title="Media Converter Pro", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATE_DIR)

# Keep concurrency modest so a local machine is not overwhelmed by conversions.
MAX_ACTIVE_TASKS = 3
MAX_AGE_SECONDS = 12 * 60 * 60
ACTIVE_SEMAPHORE = asyncio.Semaphore(MAX_ACTIVE_TASKS)
TASKS: dict[str, dict[str, Any]] = {}
TASK_ADMISSION_LOCK = asyncio.Lock()

VIDEO_QUALITIES = {"best", "1080", "720", "480", "360"}
AUDIO_QUALITIES = {"128", "192", "256", "320"}
ALLOWED_FORMATS = {"mp4", "mp3"}


class ConvertRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    format: Literal["mp4", "mp3"] = "mp4"
    quality: str = "best"


def validate_media_url(value: str) -> str:
    """Allow only supported public YouTube and Instagram URL hosts."""
    value = value.strip()
    try:
        parsed = urlparse(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Enter a valid YouTube or Instagram URL.") from exc

    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Enter a complete http(s) media URL.")
    host = parsed.hostname.lower().rstrip(".")
    youtube_ok = host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com") or host == "youtube-nocookie.com" or host.endswith(".youtube-nocookie.com")
    instagram_ok = host == "instagram.com" or host.endswith(".instagram.com")
    if not (youtube_ok or instagram_ok):
        raise HTTPException(status_code=400, detail="Only supported YouTube and Instagram URLs are accepted.")
    if parsed.port not in (None, 80, 443):
        raise HTTPException(status_code=400, detail="Custom URL ports are not accepted.")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="URLs containing embedded credentials are not accepted.")
    return value


def validate_quality(fmt: str, quality: str) -> str:
    quality = str(quality).strip().lower()
    allowed = VIDEO_QUALITIES if fmt == "mp4" else AUDIO_QUALITIES
    if quality not in allowed:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported quality for {fmt.upper()}. Choose one of: {', '.join(sorted(allowed))}.",
        )
    return quality


def public_state(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": task["task_id"],
        "status": task["status"],
        "progress": task.get("progress", 0),
        "message": task.get("message", "Waiting to start…"),
        "download_url": f"/download/{task['task_id']}" if task["status"] == "completed" else None,
        "filename": task.get("filename") if task["status"] == "completed" else None,
        "error": task.get("error"),
    }


async def notify_task(task_id: str, **updates: Any) -> None:
    task = TASKS.get(task_id)
    if not task:
        return
    # Late progress hooks from the worker must never overwrite a terminal task state.
    if task.get("status") in {"completed", "failed"} and updates.get("status") not in {"completed", "failed"}:
        return
    task.update(updates)
    task["updated_at"] = time.time()
    message = public_state(task)
    queue: asyncio.Queue = task["queue"]
    # Prevent a slow browser from accumulating an unbounded queue of progress messages.
    if queue.full():
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
    try:
        queue.put_nowait(message)
    except asyncio.QueueFull:
        pass


def _download_sync(task_id: str, url: str, fmt: str, quality: str, loop: asyncio.AbstractEventLoop) -> tuple[Path, dict[str, Any]]:
    task_dir = DOWNLOAD_DIR / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    last_percent = {-1}

    def progress_hook(data: dict[str, Any]) -> None:
        status = data.get("status")
        if status == "downloading":
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            downloaded = data.get("downloaded_bytes") or 0
            percent = int(max(0, min(99, (downloaded / total * 100) if total else 0)))
            # Emit when the visible percentage changes, not for every tiny network chunk.
            if percent not in last_percent:
                last_percent.add(percent)
                message = f"Downloading media · {percent}%" if total else "Downloading media…"
                asyncio.run_coroutine_threadsafe(
                    notify_task(task_id, status="processing", progress=percent, message=message), loop
                )
        elif status == "finished":
            asyncio.run_coroutine_threadsafe(
                notify_task(task_id, status="processing", progress=99, message="Processing media…"), loop
            )


    common: dict[str, Any] = {
    "outtmpl": str(task_dir / "%(title).120B [%(id)s].%(ext)s"),
    "noplaylist": True,
    "quiet": False,
    "verbose": True,
    "no_warnings": False,
    "restrictfilenames": True,
    "windowsfilenames": True,
    "overwrites": False,
    "progress_hooks": [progress_hook],
    "continuedl": True,
    "retries": 3,
    "fragment_retries": 3,
    "socket_timeout": 25,
    "js_runtimes": {
        "node": {}
    },
}


    if fmt == "mp4":
        if quality == "best":
            format_selector = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        else:
            format_selector = f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<={quality}][ext=mp4]/best"
        common.update({
            "format": format_selector,
            "merge_output_format": "mp4",
            "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
        })
    else:
        common.update({
            "format": "bestaudio/best",
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": quality,
            }],
        })

    asyncio.run_coroutine_threadsafe(
        notify_task(task_id, status="processing", progress=0, message="Connecting to media source…"), loop
    )
    with yt_dlp.YoutubeDL(common) as ydl:
        info = ydl.extract_info(url, download=True)

    # Find the completed output within this task's isolated directory; never trust a client filename.
    candidates = [
        p for p in task_dir.rglob("*")
        if p.is_file() and not p.name.endswith((".part", ".ytdl", ".temp")) and p.suffix.lower() not in {".json", ".description", ".jpg", ".webp", ".png"}
    ]
    preferred_ext = ".mp3" if fmt == "mp3" else ".mp4"
    preferred = [p for p in candidates if p.suffix.lower() == preferred_ext]
    if preferred:
        candidates = preferred
    if not candidates:
        expected = "MP3" if fmt == "mp3" else "MP4"
        raise RuntimeError(f"No final {expected} file was produced. Check FFmpeg installation and the available media formats.")
    # Prefer the selected output format; among those files use the largest final output.
    if not any(p.suffix.lower() == preferred_ext for p in candidates):
        raise RuntimeError(f"The source did not produce a compatible {preferred_ext[1:].upper()} output. Try another quality setting.")
    output_path = max(candidates, key=lambda p: (p.stat().st_size, p.stat().st_mtime))
    return output_path, info


async def run_conversion(task_id: str, url: str, fmt: str, quality: str) -> None:
    task = TASKS[task_id]
    try:
        async with ACTIVE_SEMAPHORE:
            await notify_task(task_id, status="processing", progress=0, message="Starting conversion…")
            loop = asyncio.get_running_loop()
            output_path, info = await asyncio.to_thread(_download_sync, task_id, url, fmt, quality, loop)
            await notify_task(
                task_id,
                status="completed",
                progress=100,
                message="Your file is ready to download.",
                file_path=output_path,
                filename=output_path.name,
                title=(info or {}).get("title", output_path.stem),
            )
    except Exception as exc:
        logger.exception("Media task %s failed", task_id)
        detail = str(exc).lower()
        if "ffmpeg" in detail:
            message = "FFmpeg is missing or could not process this media. Install FFmpeg and try again."
        elif "sign in" in detail or "private" in detail or "login" in detail:
            message = "This media may be private or require sign-in. Only publicly accessible media is supported by this app."
        else:
            message = "Couldn't process this media. Check the URL and try again. Some sources may temporarily block downloads."
        await notify_task(task_id, status="failed", progress=0, message=message, error=message)


def cleanup_old_files() -> None:
    """Best-effort cleanup for old task folders to limit disk use."""
    now = time.time()
    try:
        for child in DOWNLOAD_DIR.iterdir():
            if child.is_dir():
                try:
                    if now - child.stat().st_mtime > MAX_AGE_SECONDS:
                        shutil.rmtree(child, ignore_errors=True)
                except OSError:
                    continue
    except OSError:
        logger.warning("Could not inspect download directory for cleanup")
    for task_id, task in list(TASKS.items()):
        if now - task.get("updated_at", now) > MAX_AGE_SECONDS and task.get("status") in {"completed", "failed"}:
            TASKS.pop(task_id, None)


@app.get("/")
async def home(request: Request):
    return templates.TemplateResponse(request=request, name="index.html", context={})


@app.get("/project", response_class=HTMLResponse)
async def project_page():
    case_study = BASE_DIR / "media-converter-pro.html"
    if not case_study.is_file():
        raise HTTPException(status_code=404, detail="Project page not found.")
    return HTMLResponse(case_study.read_text(encoding="utf-8"))


@app.get("/health")
async def health():
    return {"status": "ok", "ffmpeg_available": shutil.which("ffmpeg") is not None}


@app.get("/diagnostics")
async def diagnostics():
    import subprocess

    def check(command):
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.stdout.strip() or result.stderr.strip()
        except Exception as exc:
            return str(exc)

    return {
    "node_version": check(["node", "--version"]),
    "yt_dlp_version": check([
        "python", "-m", "pip", "show", "yt-dlp"
    ]),
    "yt_dlp_ejs": check([
        "python", "-m", "pip", "show", "yt-dlp-ejs"
    ]),
}



@app.post("/convert")
async def convert(payload: ConvertRequest):
    url = validate_media_url(payload.url)
    fmt = payload.format.lower()
    quality = validate_quality(fmt, payload.quality)

    if not shutil.which("ffmpeg"):
        raise HTTPException(status_code=503, detail="FFmpeg is required for media conversion/merging. Install FFmpeg, add it to PATH, and restart the app.")

    cleanup_old_files()
    async with TASK_ADMISSION_LOCK:
        active_count = sum(1 for task in TASKS.values() if task["status"] in {"queued", "processing"})
        if active_count >= MAX_ACTIVE_TASKS:
            raise HTTPException(status_code=429, detail="The converter is busy. Please try again in a minute.")

        task_id = uuid.uuid4().hex
        now = time.time()
        TASKS[task_id] = {
            "task_id": task_id,
            "status": "queued",
            "progress": 0,
            "message": "Queued for processing…",
            "error": None,
            "filename": None,
            "file_path": None,
            "created_at": now,
            "updated_at": now,
            "queue": asyncio.Queue(maxsize=32),
        }
        asyncio.create_task(run_conversion(task_id, url, fmt, quality))

    return JSONResponse({"task_id": task_id, "status_url": f"/status/{task_id}", "websocket_url": f"/ws/{task_id}"})


@app.get("/status/{task_id}")
async def status(task_id: str):
    task = TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found or expired.")
    return public_state(task)


@app.websocket("/ws/{task_id}")
async def websocket_progress(websocket: WebSocket, task_id: str):
    task = TASKS.get(task_id)
    await websocket.accept()
    if not task:
        await websocket.send_json({"status": "failed", "progress": 0, "message": "Task not found or expired.", "error": "Task not found or expired."})
        await websocket.close(code=1008)
        return
    await websocket.send_json(public_state(task))
    if task["status"] in {"completed", "failed"}:
        await websocket.close()
        return
    try:
        while True:
            try:
                update = await asyncio.wait_for(task["queue"].get(), timeout=25)
            except asyncio.TimeoutError:
                update = public_state(task)
            await websocket.send_json(update)
            if update.get("status") in {"completed", "failed"}:
                break
    except WebSocketDisconnect:
        return
    except Exception:
        logger.debug("WebSocket progress stream ended for task %s", task_id, exc_info=True)
    finally:
        with contextlib.suppress(Exception):
            await websocket.close()


@app.get("/download/{task_id}")
async def download_result(task_id: str):
    task = TASKS.get(task_id)
    if not task or task.get("status") != "completed":
        raise HTTPException(status_code=404, detail="The file is not ready or has expired.")
    path: Path = task["file_path"]
    try:
        resolved = path.resolve()
        resolved.relative_to((DOWNLOAD_DIR / task_id).resolve())
    except (OSError, ValueError, AttributeError):
        raise HTTPException(status_code=404, detail="The file is no longer available.")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="The file is no longer available.")
    suffix = resolved.suffix.lower()
    media_type = "audio/mpeg" if suffix == ".mp3" else "video/mp4" if suffix == ".mp4" else "application/octet-stream"
    return FileResponse(resolved, media_type=media_type, filename=resolved.name)
