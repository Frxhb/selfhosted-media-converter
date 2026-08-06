"""App-Konfigurations-Routen (Lesen/Schreiben der persistierten Einstellungen)."""
import os
from fastapi import APIRouter, HTTPException, UploadFile, File

from app.job_manager import job_manager
from app.database import save_app_config
from app.models import AppConfig
from app.core import CONFIG_DIR, COOKIES_DIR, COOKIES_FILE_PATH, get_cookies_status, check_cookies_expiry

router = APIRouter()

# Cookie-Datei soll nicht riesig sein (typische Netscape-cookies.txt liegt im KB-Bereich);
# 1 MB ist ein großzügiges Limit, das versehentliche Fehl-Uploads (z.B. ganze HTML-Seite
# statt Cookie-Export) zuverlässig abfängt, ohne echte Cookie-Dateien zu blockieren.
MAX_COOKIES_FILE_SIZE = 1 * 1024 * 1024


@router.get("/api/config")
def get_config():
    has_saved_config = os.path.exists(os.path.join(CONFIG_DIR, "app_config.json"))
    return {
        "max_concurrent_jobs": job_manager.max_concurrent_jobs,
        "auto_cleanup_days": int(os.getenv("AUTO_CLEANUP_DAYS", "0")),
        "pushover_enabled": os.getenv("PUSHOVER_ENABLED", "false").lower() == "true",
        "pushover_user_key": os.getenv("PUSHOVER_USER_KEY", ""),
        "pushover_token": os.getenv("PUSHOVER_TOKEN", ""),
        "min_free_disk_gb": getattr(job_manager, "min_free_disk_gb", 2.0),
        "prevent_output_overwrite": getattr(job_manager, "prevent_output_overwrite", True),
        "confirm_full_playlist_downloads": os.getenv("CONFIRM_FULL_PLAYLIST", "true").lower() == "true",
        "max_concurrent_per_domain": getattr(job_manager, "max_concurrent_per_domain", 2),
        "max_concurrent_whisper_jobs": getattr(job_manager, "max_concurrent_whisper_jobs", 1),
        "auto_delete_originals": getattr(job_manager, "auto_delete_originals", False),
        "ffmpeg_threads": os.getenv("FFMPEG_THREADS", "Auto") if not has_saved_config else (
            "Auto" if getattr(job_manager, "ffmpeg_threads", 0) == 0 else str(job_manager.ffmpeg_threads)
        ),
        "process_priority": os.getenv("DEFAULT_PRIORITY", "below_normal") if not has_saved_config else next(
            (k for k, v in job_manager.PRIORITY_MAP.items() if v == getattr(job_manager, "process_niceness", 10)),
            "below_normal"
        ),
        # Zeigt der UI an, ob die aktuellen Werte aus gespeicherten Einstellungen (persistente JSON,
        # überlebt Neustarts) oder nur aus den .env-Defaults dieses Starts stammen. Nach dem ersten
        # Speichern in den Settings gewinnt immer die gespeicherte Config, das entspricht dem
        # Standardverhalten vergleichbarer Selfhosted-Projekte (Sonarr/Radarr/Immich etc.) -
        # .env dient nur als Erstinitialisierung, nicht als dauerhafte Quelle der Wahrheit.
        "config_source": "saved" if has_saved_config else "env_defaults",
    }


@router.post("/api/config")
def save_config(config: AppConfig):
    job_manager.max_concurrent_jobs = config.max_concurrent_jobs
    job_manager.min_free_disk_gb = config.min_free_disk_gb
    job_manager.prevent_output_overwrite = config.prevent_output_overwrite
    job_manager.max_concurrent_per_domain = config.max_concurrent_per_domain
    job_manager.max_concurrent_whisper_jobs = config.max_concurrent_whisper_jobs
    job_manager.auto_delete_originals = config.auto_delete_originals
    job_manager.ffmpeg_threads = job_manager.parse_ffmpeg_threads(config.ffmpeg_threads)
    job_manager.process_niceness = job_manager.priority_label_to_niceness(config.process_priority)
    os.environ["PUSHOVER_ENABLED"] = "true" if config.pushover_enabled else "false"
    os.environ["PUSHOVER_USER_KEY"] = config.pushover_user_key
    os.environ["PUSHOVER_TOKEN"] = config.pushover_token
    os.environ["AUTO_CLEANUP_DAYS"] = str(config.auto_cleanup_days)
    os.environ["CONFIRM_FULL_PLAYLIST"] = "true" if config.confirm_full_playlist_downloads else "false"

    try:
        save_app_config(config.model_dump())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Einstellungen konnten nicht gespeichert werden: {e}")

    return {"status": "saved"}


# --- YT-DLP COOKIES ---
@router.get("/api/config/cookies")
def get_cookies():
    """Gibt Status der aktuell hinterlegten yt-dlp Cookies-Datei zurück (aktiv/nicht aktiv,
    Upload-Datum, Größe). Der Inhalt der Datei selbst wird nie über die API ausgegeben,
    da Cookies sensible Session-Tokens enthalten."""
    return get_cookies_status()


@router.get("/api/config/cookies/test")
def test_cookies():
    """Prüft lokal (kein Netzwerk-Request, kein yt-dlp-Aufruf), ob die hinterlegten Cookies
    laut ihrem eigenen Ablaufdatum bereits abgelaufen sind. Kein Login-Test - siehe
    check_cookies_expiry() in app/core.py für die genaue Einschränkung."""
    return check_cookies_expiry()


@router.post("/api/config/cookies")
async def upload_cookies(file: UploadFile = File(...)):
    """
    Nimmt eine im Netscape-Format exportierte cookies.txt entgegen (z.B. per Browser-Addon
    wie 'Get cookies.txt LOCALLY' erzeugt) und speichert sie in einem eigenen Unterordner
    von CONFIG_DIR. Wird von yt-dlp über --cookies bei jedem Download-Job automatisch
    mitgegeben, sobald eine gültige Datei vorliegt.
    """
    raw = await file.read()

    if len(raw) > MAX_COOKIES_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"Datei zu groß (max. {MAX_COOKIES_FILE_SIZE // 1024} KB erwartet für eine Cookies-Datei).")

    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        raise HTTPException(status_code=400, detail="Datei konnte nicht als Text gelesen werden.")

    # Grobe Validierung des Netscape-Cookie-Formats: entweder die Standard-Kopfzeile,
    # oder zumindest mehrere Tab-getrennte Zeilen mit der erwarteten Spaltenanzahl (7).
    # Verhindert, dass versehentlich eine falsche Datei (HTML-Export, JSON, etc.) übernommen wird.
    has_header = "# Netscape HTTP Cookie File" in text or "# HTTP Cookie File" in text
    data_lines = [l for l in text.splitlines() if l.strip() and not l.startswith("#")]
    looks_valid = has_header or any(len(l.split("\t")) == 7 for l in data_lines)

    if not looks_valid or not data_lines:
        raise HTTPException(
            status_code=400,
            detail="Das sieht nicht nach einer gültigen Netscape cookies.txt aus. "
                   "Bitte mit einer Browser-Erweiterung (z.B. 'Get cookies.txt LOCALLY') exportieren."
        )

    try:
        os.makedirs(COOKIES_DIR, exist_ok=True)
        tmp_path = COOKIES_FILE_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_path, COOKIES_FILE_PATH)
        try:
            os.chmod(COOKIES_FILE_PATH, 0o600)  # nur der Container-Nutzer soll lesen können (Session-Tokens)
        except Exception:
            pass
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cookies-Datei konnte nicht gespeichert werden: {e}")

    return get_cookies_status()


@router.delete("/api/config/cookies")
def delete_cookies():
    """Entfernt die hinterlegte Cookies-Datei wieder. Downloads laufen danach ohne
    Anmeldung/Session (z.B. keine altersbeschränkten oder Mitglieder-Videos mehr)."""
    if os.path.exists(COOKIES_FILE_PATH):
        try:
            os.remove(COOKIES_FILE_PATH)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Cookies-Datei konnte nicht gelöscht werden: {e}")
    return get_cookies_status()
