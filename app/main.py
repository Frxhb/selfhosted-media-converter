import os
import asyncio
import urllib.request
import logging
from datetime import datetime
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from dotenv import load_dotenv

from app.logging_config import setup_logging
setup_logging()

from app.models import AppConfig
from app.job_manager import job_manager
from app.database import init_db, load_app_config
from app.core import INPUT_DIR, OUTPUT_DIR, CONFIG_DIR, FFMPEG_STATIC_DIR, DOWNLOAD_TEMP_DIR
from app.subscription_manager import init_subscription_manager

from app.routers import system, stats, files, media, config, pipelines, jobs, subscriptions

load_dotenv()
logger = logging.getLogger("Main")


for directory in [INPUT_DIR, OUTPUT_DIR, CONFIG_DIR, FFMPEG_STATIC_DIR, DOWNLOAD_TEMP_DIR]:
    try:
        if not os.path.exists(directory):
            os.makedirs(directory, exist_ok=True)
    except Exception:
        pass


def download_asset_sync(filename: str, url: str):
    dest = os.path.join(FFMPEG_STATIC_DIR, filename)
    if not os.path.exists(dest) or os.path.getsize(dest) == 0:
        try:
            logger.info(f"[WASM Local] Lade {filename} herunter...")
            urllib.request.urlretrieve(url, dest)
        except Exception as e:
            logger.warning(f"[WASM Local] Konnte {filename} nicht herunterladen: {e}")


async def ensure_local_ffmpeg_wasm_assets():
    assets = {
        "ffmpeg.js": "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js",
        "814.ffmpeg.js": "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js",
        "util.js": "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js",
        "ffmpeg-core.js": "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js",
        "ffmpeg-core.wasm": "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm",
    }
    for filename, url in assets.items():
        try:
            await asyncio.wait_for(asyncio.to_thread(download_asset_sync, filename, url), timeout=5.0)
        except Exception:
            pass


def perform_auto_cleanup():
    try:
        days = int(os.getenv("AUTO_CLEANUP_DAYS", "0"))
        if days <= 0:
            return
        cutoff = datetime.now().timestamp() - (days * 86400)
        for root, _, filenames in os.walk(OUTPUT_DIR):
            for name in filenames:
                file_path = os.path.join(root, name)
                if os.path.getmtime(file_path) < cutoff:
                    try:
                        os.remove(file_path)
                    except Exception:
                        pass
    except Exception:
        pass


def apply_persisted_config():
    """Lädt gespeicherte Konfiguration von der Festplatte und wendet sie an (überlebt Neustarts)."""
    saved = load_app_config()
    if not saved:
        return
    try:
        cfg = AppConfig(**saved)
    except Exception as e:
        logger.warning(f"Gespeicherte Konfiguration ungültig, nutze Defaults: {e}")
        return

    job_manager.max_concurrent_jobs = cfg.max_concurrent_jobs
    job_manager.min_free_disk_gb = cfg.min_free_disk_gb
    job_manager.prevent_output_overwrite = cfg.prevent_output_overwrite
    job_manager.max_concurrent_per_domain = cfg.max_concurrent_per_domain
    job_manager.max_concurrent_whisper_jobs = cfg.max_concurrent_whisper_jobs
    job_manager.auto_delete_originals = cfg.auto_delete_originals
    job_manager.ffmpeg_threads = job_manager.parse_ffmpeg_threads(cfg.ffmpeg_threads)
    job_manager.process_niceness = job_manager.priority_label_to_niceness(cfg.process_priority)
    os.environ["PUSHOVER_ENABLED"] = "true" if cfg.pushover_enabled else "false"
    os.environ["PUSHOVER_USER_KEY"] = cfg.pushover_user_key
    os.environ["PUSHOVER_TOKEN"] = cfg.pushover_token
    os.environ["AUTO_CLEANUP_DAYS"] = str(cfg.auto_cleanup_days)
    os.environ["CONFIRM_FULL_PLAYLIST"] = "true" if cfg.confirm_full_playlist_downloads else "false"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    apply_persisted_config()
    perform_auto_cleanup()
    asyncio.create_task(ensure_local_ffmpeg_wasm_assets())  # non-blocking: Server startet sofort
    await job_manager.start()
    subscription_manager = init_subscription_manager(job_manager)
    await subscription_manager.start()
    yield

app = FastAPI(title="Media Converter Pro API", lifespan=lifespan)


# CUSTOM ASGI MIDDLEWARE THAT DOES NOT INTERCEPT WEBSOCKETS
class WASMSecurityHeadersMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Cross-Origin-Opener-Policy"] = "same-origin"
                headers["Cross-Origin-Embedder-Policy"] = "credentialless"
            await send(message)

        await self.app(scope, receive, send_wrapper)

app.add_middleware(WASMSecurityHeadersMiddleware)

app.mount("/static", StaticFiles(directory="static"), name="static")

app.include_router(system.router)
app.include_router(stats.router)
app.include_router(files.router)
app.include_router(media.router)
app.include_router(config.router)
app.include_router(pipelines.router)
app.include_router(jobs.router)
app.include_router(subscriptions.router)
