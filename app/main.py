import os
import shutil
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
from app.supported_sites import ensure_supported_sites_cache_fresh
from app.watch_folder import init_watch_folder_service

from app.routers import system, stats, files, media, config, pipelines, jobs, subscriptions

load_dotenv()
logger = logging.getLogger("Main")


for directory in [INPUT_DIR, OUTPUT_DIR, CONFIG_DIR, FFMPEG_STATIC_DIR, DOWNLOAD_TEMP_DIR]:
    try:
        if not os.path.exists(directory):
            os.makedirs(directory, exist_ok=True)
    except Exception:
        pass


def cleanup_stale_download_temp_dir():
    """Räumt beim Start verwaiste Dateien/Ordner aus DOWNLOAD_TEMP_DIR auf.

    job_manager selbst hält keine Job-Warteschlange auf Platte vor (self.jobs ist rein
    In-Memory) - läuft der Container neu an, ist die Job-Liste also einfach leer, es gibt
    keine "hängengebliebenen" Job-Einträge zu bereinigen. Was aber tatsächlich zurückbleiben
    kann: DOWNLOAD_TEMP_DIR liegt unter /tmp und wird bei einem reinen Prozess-Neustart
    (docker-compose 'restart: unless-stopped' startet i.d.R. denselben Container neu, keinen
    frischen) NICHT automatisch geleert. Wurde ein Abo-Download durch einen Absturz/Neustart
    mittendrin unterbrochen, bleibt die dortige Teildatei liegen und sammelt sich über die Zeit
    an. Alles darin ist per Definition unvollständig - ein erfolgreich abgeschlossener Download
    wird von yt-dlp selbst aus dem Temp-Verzeichnis in den finalen Output-Ordner verschoben.
    """
    if not os.path.isdir(DOWNLOAD_TEMP_DIR):
        return
    removed_count = 0
    removed_bytes = 0
    for entry in os.listdir(DOWNLOAD_TEMP_DIR):
        full_path = os.path.join(DOWNLOAD_TEMP_DIR, entry)
        try:
            if os.path.isfile(full_path) or os.path.islink(full_path):
                removed_bytes += os.path.getsize(full_path)
                os.remove(full_path)
                removed_count += 1
            elif os.path.isdir(full_path):
                for root, _, filenames in os.walk(full_path):
                    for name in filenames:
                        try:
                            removed_bytes += os.path.getsize(os.path.join(root, name))
                        except Exception:
                            pass
                shutil.rmtree(full_path, ignore_errors=True)
                removed_count += 1
        except Exception as e:
            logger.warning(f"Konnte verwaiste Datei/Ordner im Download-Staging-Verzeichnis nicht entfernen: {entry} ({e})")

    if removed_count > 0:
        logger.info(
            f"Beim Start: {removed_count} verwaiste Datei(en)/Ordner aus dem Download-"
            f"Staging-Verzeichnis entfernt ({removed_bytes / (1024 * 1024):.1f} MB) - "
            f"vermutlich Reste eines durch Absturz/Neustart unterbrochenen Downloads."
        )


cleanup_stale_download_temp_dir()


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
    job_manager.watch_folder_enabled = cfg.watch_folder_enabled
    job_manager.watch_folder_pipeline_id = cfg.watch_folder_pipeline_id
    job_manager.watch_folder_interval_seconds = cfg.watch_folder_interval_seconds
    os.environ["PUSHOVER_ENABLED"] = "true" if cfg.pushover_enabled else "false"
    os.environ["PUSHOVER_USER_KEY"] = cfg.pushover_user_key
    os.environ["PUSHOVER_TOKEN"] = cfg.pushover_token
    os.environ["AUTO_CLEANUP_DAYS"] = str(cfg.auto_cleanup_days)
    os.environ["CONFIRM_FULL_PLAYLIST"] = "true" if cfg.confirm_full_playlist_downloads else "false"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    apply_persisted_config()
    asyncio.create_task(asyncio.to_thread(perform_auto_cleanup))
    asyncio.create_task(ensure_local_ffmpeg_wasm_assets())  # non-blocking: Server startet sofort
    asyncio.create_task(ensure_supported_sites_cache_fresh())  # non-blocking, max. 1x/Woche
    await job_manager.start()
    subscription_manager = init_subscription_manager(job_manager)
    await subscription_manager.start()
    init_watch_folder_service(job_manager).start()
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
