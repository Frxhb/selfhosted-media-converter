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
    """
    Berechnet RAM-Auslastung präzise, indem `/proc/meminfo` (für LXC/Bare-Metal)
    als Primärquelle und cgroups (für Docker ohne lxcfs) als Fallback priorisiert wird.
    Vermeidet Syscalls von psutil, die in LXC auf den Host-RAM durchschlagen.
    """
    meminfo_total = 0
    meminfo_avail = 0
    meminfo_free = 0
    meminfo_buffers = 0
    meminfo_cached = 0

    # 1. /proc/meminfo parsen (wird auch von `free -h` genutzt, lxcfs biegt das für LXC passend um)
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    meminfo_total = int(line.split()[1]) * 1024
                elif line.startswith("MemAvailable:"):
                    meminfo_avail = int(line.split()[1]) * 1024
                elif line.startswith("MemFree:"):
                    meminfo_free = int(line.split()[1]) * 1024
                elif line.startswith("Buffers:"):
                    meminfo_buffers = int(line.split()[1]) * 1024
                elif line.startswith("Cached:"):
                    meminfo_cached = int(line.split()[1]) * 1024
    except Exception:
        pass

    # Fallback auf psutil, falls meminfo fehlschlägt (unwahrscheinlich unter Linux)
    if meminfo_total == 0:
        try:
            mem = psutil.virtual_memory()
            meminfo_total = mem.total
            meminfo_avail = mem.available
        except Exception:
            pass

    # Genutzten RAM exakt wie `free` kalkulieren
    if meminfo_avail > 0:
        meminfo_used = meminfo_total - meminfo_avail
    else:
        meminfo_used = max(0, meminfo_total - meminfo_free - meminfo_buffers - meminfo_cached)

    # 2. Cgroups auslesen (Nur relevant, falls Docker ohne lxcfs läuft und meminfo den Host zeigt)
    cgroup_limit = None
    cgroup_usage = None
    inactive_file = 0
    rel_path = ""

    try:
        with open("/proc/self/cgroup", "r") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) == 3 and (parts[1] == "" or "memory" in parts[1]):
                    rel_path = parts[2].lstrip("/")
                    break
    except Exception:
        pass

    possible_limit_paths = [
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ]
    possible_usage_paths = [
        "/sys/fs/cgroup/memory.current",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ]
    possible_stat_paths = [
        "/sys/fs/cgroup/memory.stat",
        "/sys/fs/cgroup/memory/memory.stat",
    ]

    if rel_path:
        possible_limit_paths.insert(0, f"/sys/fs/cgroup/{rel_path}/memory.max")
        possible_limit_paths.insert(0, f"/sys/fs/cgroup/memory/{rel_path}/memory.limit_in_bytes")
        possible_usage_paths.insert(0, f"/sys/fs/cgroup/{rel_path}/memory.current")
        possible_usage_paths.insert(0, f"/sys/fs/cgroup/memory/{rel_path}/memory.usage_in_bytes")
        possible_stat_paths.insert(0, f"/sys/fs/cgroup/{rel_path}/memory.stat")
        possible_stat_paths.insert(0, f"/sys/fs/cgroup/memory/{rel_path}/memory.stat")

    def read_cgroup_val(paths):
        for p in paths:
            if os.path.exists(p):
                try:
                    with open(p, "r") as f:
                        val = f.read().strip()
                        if val.isdigit():
                            ival = int(val)
                            # Ignoriere Cgroup-"Uncapped" Dummy-Werte (z.B. 9223372036854771712)
                            if 0 < ival < 10**14:
                                return ival
                        elif val.lower() == "max":
                            return None
                except Exception:
                    pass
        return None

    cgroup_limit = read_cgroup_val(possible_limit_paths)
    cgroup_usage = read_cgroup_val(possible_usage_paths)

    for p in possible_stat_paths:
        if os.path.exists(p):
            try:
                with open(p, "r") as f:
                    for line in f:
                        if line.startswith("inactive_file ") or line.startswith("total_inactive_file "):
                            inactive_file = int(line.split()[1])
                            break
            except Exception:
                pass

    # 3. Entscheidungslogik für das finales Ergebnis
    total_bytes = meminfo_total if meminfo_total > 0 else 1
    used_bytes = meminfo_used if meminfo_total > 0 else 0

    # Falls ein Cgroup-Limit greift, UND dieses signifikant kleiner ist als meminfo,
    # wissen wir: meminfo lügt (Standard-Docker) und wir müssen Cgroups priorisieren.
    # Bei dir (LXC) sind Cgroup und Meminfo nahezu identisch, wodurch dieser Block ignoriert 
    # und dein korrekter meminfo-Wert priorisiert wird!
    if cgroup_limit is not None and cgroup_limit < (meminfo_total * 0.95):
        total_bytes = cgroup_limit
        if cgroup_usage is not None:
            net_usage = max(0, cgroup_usage - inactive_file)
            used_bytes = min(net_usage, total_bytes)

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


def check_cookies_expiry() -> dict:
    """Prüft rein lokal (kein Netzwerk-Zugriff, kein yt-dlp-Aufruf), ob die hinterlegten
    Cookies laut ihrem eigenen Ablaufdatum bereits abgelaufen sind - anhand des
    Expiration-Feldes im Netscape-Cookie-Format (Spalte 5, Unix-Timestamp, 0 = reiner
    Session-Cookie ohne festes Ablaufdatum).

    WICHTIG: Das ist KEIN Login-Test - ob eine Seite die Cookies noch als gültig
    akzeptiert, kann nur ein echter Request an diese Seite beantworten (und selbst dann
    site-abhängig unzuverlässig). Diese Funktion beantwortet nur die deutlich engere,
    aber lokal und ohne Netzwerk zuverlässig beantwortbare Frage: "ist das im Cookie
    selbst hinterlegte Ablaufdatum schon in der Vergangenheit?" - der häufigste, am
    einfachsten erkennbare Grund für "Downloads mit Cookies funktionieren plötzlich
    nicht mehr"."""
    if not os.path.exists(COOKIES_FILE_PATH):
        return {"has_cookies": False}

    now = datetime.now().timestamp()
    total = 0
    expired = 0
    session_only = 0
    soonest_valid_expiry = None

    try:
        with open(COOKIES_FILE_PATH, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line.strip() or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) != 7:
                    continue  # Zeile entspricht nicht dem erwarteten Netscape-Format, überspringen
                total += 1
                try:
                    expiry = float(parts[4])
                except ValueError:
                    continue
                if expiry == 0:
                    session_only += 1
                elif expiry < now:
                    expired += 1
                elif soonest_valid_expiry is None or expiry < soonest_valid_expiry:
                    soonest_valid_expiry = expiry
    except Exception as e:
        return {"has_cookies": True, "error": f"Cookies-Datei konnte nicht gelesen werden: {e}"}

    if total == 0:
        return {"has_cookies": True, "total": 0, "expired": 0, "all_expired": False}

    with_expiry = total - session_only
    return {
        "has_cookies": True,
        "total": total,
        "expired": expired,
        "session_only": session_only,
        "all_expired": with_expiry > 0 and expired == with_expiry,
        "earliest_expiry": (
            datetime.fromtimestamp(soonest_valid_expiry).isoformat() if soonest_valid_expiry else None
        ),
    }
