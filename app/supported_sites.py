"""
Pflegt eine lokal gecachte Liste unterstützter yt-dlp Extraktor-Namen, um vor
einem tatsächlichen yt-dlp-Aufruf eine schnelle, rein lokale Heuristik-Prüfung zu ermöglichen:
"wird diese URL wahrscheinlich unterstützt?". yt-dlp exportiert die echten Extraktor-Regexe
nicht als einfache Liste über die CLI, daher wird stattdessen die Namensliste aus den
yt-dlp Docs geladen und der Domain-Name der eingegebenen URL dagegen abgeglichen.

Bewusst nur eine Heuristik, kein Ersatz für die echte Extraktor-Zuordnung:
- False Positives sind unwahrscheinlich (führt höchstens zu einer übersehenen Warnung)
- False Negatives (fälschlich als "nicht unterstützt" markiert) sind möglich, z.B. bei
  Namen wie "video.google:search" oder stark abweichenden Kurznamen
Deshalb wird das Ergebnis im Frontend nur als Warnung angezeigt, NIE als Blockade -
der eigentliche yt-dlp-Aufruf entscheidet am Ende ohnehin verbindlich.

Die Liste wird höchstens einmal pro Woche neu geladen (CACHE_TTL_SECONDS) und dauerhaft
in CONFIG_DIR zwischengespeichert, damit nicht bei jeder URL-Eingabe (oder gar nie, falls
offline) ein Netzwerk-Request an GitHub nötig ist.
"""
import os
import re
import json
import time
import asyncio
import logging
import urllib.request
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger("Main")

# Updated to the official yt-dlp repository documentation source
SUPPORTED_SITES_URL = "https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/supportedsites.md"
CACHE_TTL_SECONDS = 7 * 24 * 3600  # einmal pro Woche
FETCH_TIMEOUT_SECONDS = 10

# Markdown-Zeilen sehen aus wie "  - **10play**", "  - **10play:season**" oder "  - **1News**: 1news.co.nz"
_SITE_NAME_RE = re.compile(r"^\s*-\s+\*\*(.+?)\*\*")

# In-Memory Cache, um Festplattenzugriffe (Disk-I/O) bei jeder URL-Prüfung zu vermeiden
_MEMORY_CACHE: Optional[list] = None


def _cache_path() -> str:
    from app.core import CONFIG_DIR
    return os.path.join(CONFIG_DIR, "ytdlp_supported_sites.json")


def _parse_supported_sites_md(text: str) -> list:
    names = []
    for line in text.splitlines():
        m = _SITE_NAME_RE.match(line)
        if m:
            names.append(m.group(1).strip())
    return names


def _load_cache() -> Optional[dict]:
    path = _cache_path()
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_cache(names: list):
    global _MEMORY_CACHE
    _MEMORY_CACHE = names
    path = _cache_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"fetched_at": time.time(), "sites": names}, f)
    except Exception as e:
        logger.warning(f"Konnte Cache für unterstützte Seiten nicht schreiben: {e}")


def _fetch_and_cache_sync() -> list:
    req = urllib.request.Request(SUPPORTED_SITES_URL, headers={"User-Agent": "media-converter-pro"})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_SECONDS) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    names = _parse_supported_sites_md(text)
    if names:
        _save_cache(names)
        logger.info(f"Liste unterstützter yt-dlp Seiten aktualisiert ({len(names)} Einträge).")
    else:
        logger.warning("Liste unterstützter Seiten geladen, aber 0 Einträge geparst - Format evtl. geändert.")
    return names


def is_cache_stale() -> bool:
    cache = _load_cache()
    if not cache:
        return True
    return (time.time() - cache.get("fetched_at", 0)) > CACHE_TTL_SECONDS


def get_cached_site_names() -> list:
    """Liest den In-Memory-Cache (oder bei Bedarf einmalig den Disk-Cache) ohne Netzwerk-Zugriff - 
    für den API-Endpunkt, damit eine URL-Prüfung nie durch Festplatten-I/O oder GitHub-Requests verzögert wird."""
    global _MEMORY_CACHE
    if _MEMORY_CACHE is not None:
        return _MEMORY_CACHE

    cache = _load_cache()
    if cache and "sites" in cache:
        _MEMORY_CACHE = cache["sites"]
        return _MEMORY_CACHE

    return []


async def ensure_supported_sites_cache_fresh():
    """Nicht-blockierender Hintergrund-Refresh beim Server-Start, analog zum Download der
    ffmpeg-WASM-Assets in main.py. Läuft nur, wenn der Cache fehlt oder älter als eine
    Woche ist. Ein Fehlschlag (z.B. kein Internetzugang) wird nur geloggt, der Server
    funktioniert unverändert weiter - die Prüfung liefert dann einfach "unbekannt".
    """
    # Befülle den In-Memory-Cache direkt beim Serverstart aus der Datei auf dem Datenträger
    get_cached_site_names()

    if not is_cache_stale():
        return
    try:
        await asyncio.wait_for(asyncio.to_thread(_fetch_and_cache_sync), timeout=FETCH_TIMEOUT_SECONDS + 2)
    except Exception as e:
        logger.warning(f"Hintergrund-Aktualisierung der unterstützten-Seiten-Liste fehlgeschlagen: {e}")


def _domain_from_url(url: str) -> Optional[str]:
    try:
        netloc = urlparse(url).netloc.lower()
    except Exception:
        return None
    if not netloc:
        return None
    if "@" in netloc:  # user:pass@host Form
        netloc = netloc.rsplit("@", 1)[-1]
    netloc = netloc.split(":")[0]  # Port entfernen
    return netloc[4:] if netloc.startswith("www.") else netloc


def check_url_support(url: str) -> dict:
    """
    valid_url: True/False - rein syntaktisch (Schema + Host vorhanden)
    supported: True/False/None - None heißt "keine Aussage möglich" (Cache leer/noch nicht
               geladen), soll NIE als Warnung angezeigt werden
    domain:    erkannte Domain, falls valid_url True
    """
    domain = _domain_from_url(url)
    if not domain:
        return {"valid_url": False, "supported": None, "domain": None}

    sites = get_cached_site_names()
    if not sites:
        return {"valid_url": True, "supported": None, "domain": domain}

    domain_core = domain.split(".")[0] if "." in domain else domain
    domain_norm = re.sub(r"[^a-z0-9]", "", domain)
    domain_core_norm = re.sub(r"[^a-z0-9]", "", domain_core)

    for name in sites:
        # Falls Sub-Extraktoren wie "10play:season" enthalten sind, trennen wir am Doppelpunkt
        base_name = name.split(":")[0] if ":" in name else name
        name_norm = re.sub(r"[^a-z0-9]", "", base_name.lower())

        # Vermeide Zuordnungen durch sehr kurze Strings (z.B. < 3 Zeichen), um False Positives zu verhindern
        if not name_norm or len(name_norm) < 3:
            continue

        # Prüfe Exakt-Treffer auf Core-Domain ODER ob der Extraktorname in der Domain vorkommt
        if name_norm == domain_core_norm or name_norm in domain_norm:
            return {"valid_url": True, "supported": True, "domain": domain, "matched": name}

    return {"valid_url": True, "supported": False, "domain": domain}
