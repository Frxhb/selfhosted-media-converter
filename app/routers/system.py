"""System-, Health-, Log- und Backup/Restore-Routen, sowie die Index-Seite und der WebSocket-Endpunkt."""
import os
import shutil
import zipfile
import subprocess
import logging
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, Request, Query, File
from fastapi.responses import FileResponse
from fastapi.templating import Jinja2Templates

from app.logging_config import LOG_DIR
from app.job_manager import job_manager
from app.core import CONFIG_DIR

logger = logging.getLogger("Main")
router = APIRouter()
templates = Jinja2Templates(directory="templates")


# --- HTML & WEBSOCKET ---
@router.get("/")
def render_index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await job_manager.register_websocket(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        job_manager.unregister_websocket(websocket)


@router.get("/api/health")
def health_check():
    """Leichter Healthcheck für Docker HEALTHCHECK / Uptime-Kuma o.ä. Prüft nur, dass der Prozess antwortet."""
    return {"status": "ok"}


@router.get("/api/config/backup")
def backup_config():
    """
    Exportiert app_config.json und die Stats-Datenbank als ZIP, für Umzug auf einen
    anderen Server oder als Sicherung vor größeren Änderungen.
    """
    backup_zip_path = os.path.join(CONFIG_DIR, "_config_backup_export.zip")
    try:
        with zipfile.ZipFile(backup_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            config_json_path = os.path.join(CONFIG_DIR, "app_config.json")
            if os.path.exists(config_json_path):
                zipf.write(config_json_path, arcname="app_config.json")
            db_path = os.path.join(CONFIG_DIR, "mcp_stats.db")
            if os.path.exists(db_path):
                zipf.write(db_path, arcname="mcp_stats.db")
        return FileResponse(backup_zip_path, filename="media_converter_backup.zip", media_type="application/zip")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Backup fehlgeschlagen: {e}")


@router.post("/api/config/restore")
def restore_config(file: UploadFile = File(...)):
    """
    Importiert ein zuvor über /api/config/backup exportiertes ZIP. Überschreibt die
    aktuelle app_config.json und Stats-Datenbank. Ein Neustart des Containers wird
    danach empfohlen, damit alle Werte sauber neu geladen werden.
    """
    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="Bitte eine .zip Backup-Datei hochladen.")

    tmp_path = os.path.join(CONFIG_DIR, "_restore_upload.zip")
    try:
        with open(tmp_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        with zipfile.ZipFile(tmp_path, 'r') as zipf:
            names = zipf.namelist()
            allowed = {"app_config.json", "mcp_stats.db"}
            if not any(n in allowed for n in names):
                raise HTTPException(status_code=400, detail="ZIP enthält keine erkennbaren Backup-Dateien.")
            for name in names:
                if name in allowed:
                    zipf.extract(name, CONFIG_DIR)

        return {"status": "restored", "detail": "Bitte den Container neu starten, damit alle Einstellungen sauber geladen werden."}
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Ungültige oder beschädigte ZIP-Datei.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Wiederherstellung fehlgeschlagen: {e}")
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@router.get("/api/logs")
def get_logs(lines: int = Query(300, ge=10, le=5000), level: str = Query("app")):
    """Liest die letzten N Zeilen aus app.log oder error.log für die UI-Anzeige."""
    filename = "error.log" if level == "error" else "app.log"
    path = os.path.join(LOG_DIR, filename)
    if not os.path.exists(path):
        return {"lines": [], "file": filename}
    try:
        from collections import deque
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            tail = deque(f, maxlen=lines)
        return {"lines": [l.rstrip("\n") for l in tail], "file": filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Log konnte nicht gelesen werden: {e}")


@router.get("/api/logs/download")
def download_logs():
    path = os.path.join(LOG_DIR, "app.log")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Kein Log vorhanden")
    return FileResponse(path, filename="media_converter_app.log")


@router.get("/api/system/ytdlp-version")
def get_ytdlp_version():
    try:
        result = subprocess.run(["yt-dlp", "--version"], capture_output=True, text=True, timeout=10)
        return {"version": result.stdout.strip() or "unbekannt"}
    except Exception as e:
        return {"version": "unbekannt", "error": str(e)}


@router.post("/api/system/ytdlp-update")
def update_ytdlp():
    """
    Aktualisiert yt-dlp zur Laufzeit über dessen eingebauten Self-Updater (yt-dlp -U).
    Das Docker-Image pinnt yt-dlp bewusst auf eine feste Version (siehe Dockerfile);
    dieser Endpunkt ist der bewusste, manuelle Weg, trotzdem ohne Rebuild zu aktualisieren.
    Änderung ist nur bis zum nächsten Container-Neustart persistent, falls /usr/local/bin
    nicht separat gemountet ist (Standard-Setup: nicht gemountet -> Rebuild bleibt die
    dauerhafte Update-Quelle, dies hier ist der schnelle Zwischenweg).
    """
    try:
        result = subprocess.run(["yt-dlp", "-U"], capture_output=True, text=True, timeout=60)
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Update fehlgeschlagen: {output.strip()[-500:]}")
        version_result = subprocess.run(["yt-dlp", "--version"], capture_output=True, text=True, timeout=10)
        return {"status": "ok", "output": output.strip(), "version": version_result.stdout.strip()}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Zeitüberschreitung beim yt-dlp Update.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
