"""Geteilte Konstanten und Hilfsfunktionen, die von mehreren Routern genutzt werden.

Enthält Pfad-Sicherheits-Helpers (Traversal-Schutz), Verzeichnis-Konstanten und
System-/Speicherplatz-Utilities. Bewusst ohne Abhängigkeit auf FastAPI-Router,
damit es von jedem Router-Modul ohne Zirkelimport genutzt werden kann.
"""
import os
import re
import shutil
import logging
from datetime import datetime
from typing import Optional
from fastapi import HTTPException
import psutil

logger = logging.getLogger("Main")

INPUT_DIR = os.getenv("INPUT_DIR", "/media/inputs")
OUTPUT_DIR = os.getenv("OUTPUT_DIR", "/media/outputs")
CONFIG_DIR = os.getenv("CONFIG_DIR", "/app/config")
FFMPEG_STATIC_DIR = os.path.join("static", "vendor", "ffmpeg")

# Temporärer Arbeitsordner für yt-dlp Downloads (via --paths temp:...). Bewusst AUSSERHALB
# von OUTPUT_DIR, damit Zwischen-Dateien (z.B. das zuerst geladene .webm, bevor yt-dlp es zu
# MP3 extrahiert oder nach MP4 remuxt) nie in der Bibliotheks-Ansicht auftauchen - list_output_files
# durchläuft nur OUTPUT_DIR selbst, nicht diesen Ordner.
DOWNLOAD_TEMP_DIR = "/tmp/ytdlp_staging"

# Unterordner für neu erstellte Dateien, nach Kategorie sortiert. Bestehende Dateien direkt
# in OUTPUT_DIR (aus der Zeit vor dieser Struktur) bleiben bewusst unangetastet - list_output_files
# durchläuft OUTPUT_DIR ohnehin rekursiv (os.walk), findet also sowohl alte flache als auch neue
# einsortierte Dateien gleichermaßen.
OUTPUT_SUBDIR_VIDEO = "videos"
OUTPUT_SUBDIR_AUDIO = "audio"
OUTPUT_SUBDIR_IMAGE = "images"
OUTPUT_SUBDIR_TRANSCRIPT = "transcripts"
OUTPUT_SUBDIR_SCHEDULED = "scheduled"  # Downloads aus Kanal-Abonnements, je Kanal ein eigener Unterordner darunter

# Archiv-Dateien für yt-dlp's --download-archive, eine pro Subscription (Dateiname = subscription_id).
SUBSCRIPTION_ARCHIVE_DIR = os.path.join(CONFIG_DIR, "subscription_archives")

# Cookies-Datei für yt-dlp (Netscape-Format, per GUI-Upload befüllt). Liegt in einem
# eigenen Unterordner statt direkt in CONFIG_DIR, damit sie beim Config-Backup/Restore-ZIP
# NICHT versehentlich mit exportiert wird (enthält Session-Tokens, ist sensibel).
COOKIES_DIR = os.path.join(CONFIG_DIR, "cookies")
COOKIES_FILE_PATH = os.path.join(COOKIES_DIR, "cookies.txt")

MEDIA_TAG_EXTENSIONS = {".mp3", ".m4a", ".flac", ".mp4", ".mkv", ".ogg", ".wav"}


def sanitize_folder_name(name: str, fallback: str = "unbenannt") -> str:
    """Macht einen String sicher als Ordnername verwendbar: entfernt Pfad-Trennzeichen und
    andere problematische Zeichen, kürzt auf eine vernünftige Länge. Wird für Kanal-Namen
    (Subscription-Unterordner) verwendet, die vom Nutzer frei vergeben werden können."""
    if not name:
        return fallback
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" ._")
    cleaned = re.sub(r"_+", "_", cleaned)
    return cleaned[:80] or fallback


def safe_join_within(base_dir: str, rel_path: str) -> str:
    """
    Löst rel_path relativ zu base_dir auf und garantiert, dass das Ergebnis
    innerhalb von base_dir bleibt. Verhindert Path-Traversal (z.B. '../../etc/passwd').
    Wirft HTTPException(400) bei Traversal-Versuchen.
    """
    if not rel_path:
        raise HTTPException(status_code=400, detail="Kein Pfad angegeben")
    base_real = os.path.realpath(base_dir)
    candidate = os.path.realpath(os.path.join(base_real, rel_path))
    if candidate != base_real and not candidate.startswith(base_real + os.sep):
        raise HTTPException(status_code=400, detail="Ungültiger Pfad")
    return candidate


def get_free_disk_gb(path: str) -> float:
    try:
        return shutil.disk_usage(path).free / (1024 ** 3)
    except Exception:
        return float("inf")  # fail open on stat error rather than blocking all jobs


def _resolve_media_path_safely(file_path: str) -> Optional[str]:
    """Löst einen vom Client übergebenen Datei-Pfad sicher auf, egal ob relativ oder absolut angegeben.
    Erlaubt NUR Pfade innerhalb von OUTPUT_DIR oder INPUT_DIR - auch bei absoluten Pfaden wird die
    Traversal-Prüfung nie umgangen. Gibt None zurück, wenn der Pfad außerhalb beider Verzeichnisse liegt."""
    if not file_path:
        return None
    for base_dir in (OUTPUT_DIR, INPUT_DIR):
        base_real = os.path.realpath(base_dir)
        candidate_input = file_path if os.path.isabs(file_path) else os.path.join(base_real, file_path)
        candidate = os.path.realpath(candidate_input)
        if candidate == base_real or candidate.startswith(base_real + os.sep):
            return candidate
    return None


def get_container_memory():
    total_bytes, avail_bytes = 0, 0
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    total_bytes = int(line.split()[1]) * 1024
                elif line.startswith("MemAvailable:"):
                    avail_bytes = int(line.split()[1]) * 1024
    except Exception:
        pass

    used_bytes = max(0, total_bytes - avail_bytes)

    cgroup_limits, cgroup_usages = [], []
    for root, _, files in os.walk("/sys/fs/cgroup"):
        for fname in ["memory.max", "memory.limit_in_bytes"]:
            if fname in files:
                try:
                    with open(os.path.join(root, fname), "r") as f:
                        val = f.read().strip()
                        if val.isdigit() and 0 < int(val) < 10**14:
                            cgroup_limits.append(int(val))
                except Exception:
                    pass
        for fname in ["memory.current", "memory.usage_in_bytes"]:
            if fname in files:
                try:
                    with open(os.path.join(root, fname), "r") as f:
                        val = f.read().strip()
                        if val.isdigit():
                            cgroup_usages.append(int(val))
                except Exception:
                    pass

    if cgroup_limits:
        min_limit = min(cgroup_limits)
        if min_limit < total_bytes or total_bytes == 0:
            total_bytes = min_limit
            if cgroup_usages:
                used_bytes = min(max(cgroup_usages), total_bytes)
            else:
                used_bytes = min(used_bytes, total_bytes)

    if total_bytes == 0:
        mem = psutil.virtual_memory()
        return mem.used, mem.total

    return used_bytes, total_bytes


def get_cookies_status() -> dict:
    """Prüft, ob eine yt-dlp Cookies-Datei vorhanden ist (per GUI hochgeladen).
    Gibt Existenz, Dateigröße und letztes Änderungsdatum zurück, für die Anzeige
    in den Einstellungen (z.B. 'Cookies aktiv seit ...')."""
    if not os.path.exists(COOKIES_FILE_PATH):
        return {"active": False, "uploaded_at": None, "size_bytes": 0}
    try:
        stat = os.stat(COOKIES_FILE_PATH)
        return {
            "active": stat.st_size > 0,
            "uploaded_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "size_bytes": stat.st_size,
        }
    except Exception:
        return {"active": False, "uploaded_at": None, "size_bytes": 0}
