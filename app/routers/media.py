"""Medien-Inspektor (ffprobe), Metadaten-Tag-Editor, yt-dlp Metadaten-Abfragen und Duplikat-Fingerprinting."""
import os
import re
import json
import time
import asyncio
import logging
from fastapi import APIRouter, HTTPException, Query

from app.database import find_similar_completed_jobs
from app.models import MediaTagsUpdateRequest
from app.core import MEDIA_TAG_EXTENSIONS, _resolve_media_path_safely

logger = logging.getLogger("Main")
router = APIRouter()


@router.get("/api/media-info")
async def get_media_info(file_path: str):
    resolved = _resolve_media_path_safely(file_path)
    if not resolved or not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")

    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", resolved]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, _ = await proc.communicate()

    try:
        return json.loads(stdout.decode('utf-8'))
    except Exception:
        return {"raw": stdout.decode('utf-8', errors='ignore')}


@router.get("/api/jobs/check-similar")
async def check_similar_job(file_path: str):
    """Schneller Fingerprint-Vergleich (Dateigröße + Dauer, kein vollständiges Hashing) gegen bereits
    abgeschlossene Jobs. Hilft, versehentliche Doppel-Konvertierungen zu erkennen, bevor ein neuer
    Job gestartet wird. Gibt eine leere Liste zurück, wenn keine Kandidaten gefunden wurden oder die
    Datei nicht analysiert werden konnte (fail-open: blockiert niemals das eigentliche Job-Erstellen)."""
    resolved = _resolve_media_path_safely(file_path)
    if not resolved or not os.path.exists(resolved):
        return {"matches": []}

    try:
        size_mb = round(os.path.getsize(resolved) / (1024 * 1024), 2)
    except Exception:
        return {"matches": []}

    duration_sec = 0.0
    try:
        cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=noprint_wrappers=1:nokey=1", resolved]
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15.0)
        val = stdout.decode().strip()
        if val and val != "N/A":
            duration_sec = float(val)
    except Exception:
        pass  # keine Dauer ermittelbar (z.B. reines Bild) - Vergleich läuft dann nur über Größe

    matches = find_similar_completed_jobs(size_mb, duration_sec)
    return {"matches": matches, "checked_size_mb": size_mb, "checked_duration_sec": duration_sec}


@router.get("/api/media-tags")
async def get_media_tags(file_path: str):
    """Liest vorhandene Metadaten-Tags (Titel, Künstler, Album, ...) einer Mediendatei per ffprobe aus."""
    resolved = _resolve_media_path_safely(file_path)
    if not resolved or not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")

    ext = os.path.splitext(resolved)[1].lower()
    if ext not in MEDIA_TAG_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Metadaten-Bearbeitung wird für '{ext}' nicht unterstützt.")

    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", resolved]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, _ = await proc.communicate()

    try:
        data = json.loads(stdout.decode('utf-8'))
        tags = data.get("format", {}).get("tags", {}) or {}
        # ffprobe liefert Tag-Namen teils klein/teils groß (container-abhängig), daher case-insensitiv normalisieren
        lower_tags = {k.lower(): v for k, v in tags.items()}
        return {
            "title": lower_tags.get("title", ""),
            "artist": lower_tags.get("artist", ""),
            "album": lower_tags.get("album", ""),
            "date": lower_tags.get("date", "") or lower_tags.get("year", ""),
            "genre": lower_tags.get("genre", ""),
            "comment": lower_tags.get("comment", ""),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Tags konnten nicht gelesen werden: {e}")


@router.post("/api/media-tags")
async def set_media_tags(request: MediaTagsUpdateRequest):
    """Schreibt Metadaten-Tags via ffmpeg -metadata (Stream-Copy/Remux, kein Reencode) in eine neue
    Datei und ersetzt danach atomar das Original. Funktioniert für ID3 (MP3) genauso wie für
    MP4/MKV-Container-Tags."""
    resolved = _resolve_media_path_safely(request.file_path)
    if not resolved or not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")

    ext = os.path.splitext(resolved)[1].lower()
    if ext not in MEDIA_TAG_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Metadaten-Bearbeitung wird für '{ext}' nicht unterstützt.")

    tag_map = {
        "title": request.title,
        "artist": request.artist,
        "album": request.album,
        "date": request.date,
        "genre": request.genre,
        "comment": request.comment,
    }

    tmp_path = resolved + ".tagtmp" + ext
    cmd = ["ffmpeg", "-hide_banner", "-y", "-i", resolved, "-map", "0", "-codec", "copy"]
    for key, value in tag_map.items():
        if value is not None:
            cmd.extend(["-metadata", f"{key}={value}"])
    cmd.append(tmp_path)

    try:
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60.0)

        if proc.returncode != 0 or not os.path.exists(tmp_path):
            err_msg = stderr.decode('utf-8', errors='replace').strip()[-400:]
            raise HTTPException(status_code=500, detail=f"Metadaten konnten nicht geschrieben werden: {err_msg}")

        os.replace(tmp_path, resolved)
        return {"status": "updated", "file": os.path.basename(resolved)}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Zeitüberschreitung beim Schreiben der Metadaten.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Metadaten-Update fehlgeschlagen: {e}")
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


@router.get("/api/ytdlp-info")
async def get_ytdlp_info(url: str, cookies: str = "none", po_token: str = "", lang: str = "en"):
    cmd = ["yt-dlp", "--dump-json", "--no-playlist", "--no-warnings"]
    if cookies != "none":
        cmd.extend(["--cookies-from-browser", cookies])

    # Dynamische Sprache statt hart codiertem en-US
    cmd.extend(["--add-header", f"Accept-Language:{lang},{lang}-{lang.upper()};q=0.9,en;q=0.8"])

    # Fallback-Kette für 403 Forbidden Fehler hinzugefügt: player_client=default,android,ios,web
    ext_args = "youtube:player_client=default,android,ios,web"
    if po_token.strip():
        ext_args += f";po_token=web+{po_token.strip()}"
    
    # Sprach-Argument für den Extractor
    ext_args += f";lang={lang}"
    
    cmd.extend(["--extractor-args", ext_args, url])

    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(status_code=504, detail="yt-dlp hat zu lange für die Metadaten-Abfrage gebraucht (Timeout nach 30s).")

    if proc.returncode != 0:
        err_msg = stderr.decode('utf-8', errors='replace').strip() or stdout.decode('utf-8', errors='replace').strip()
        raise HTTPException(status_code=400, detail=f"yt-dlp Fehler: {err_msg[:250]}")

    try:
        data = json.loads(stdout.decode('utf-8', errors='replace'))
        if isinstance(data, list) and len(data) > 0:
            data = data[0]

        title = data.get("title", "Unbekannter Titel")
        list_match = re.search(r"[?&]list=([\w-]+)", url)
        if list_match:
            list_id = list_match.group(1)
            if list_id.startswith("RD"):
                title = f"{title} (Radio/Mix)"
            else:
                title = f"{title} (Playlist)"

        return {
            "title": title,
            "duration": data.get("duration_string") or str(data.get("duration", "Unbekannt")),
            "uploader": data.get("uploader") or data.get("channel", "Unbekannt"),
            "thumbnail": data.get("thumbnail")
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Parsing Fehler: {str(e)}")


@router.get("/api/ytdlp-playlist-items")
async def get_ytdlp_playlist_items(url: str, max_items: int = Query(500, ge=1, le=5000), lang: str = "en"):
    cmd = [
        "yt-dlp",
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
        "--ignore-errors",
        "--playlist-end", str(max_items),
        # Dynamische Sprache statt hart codiertem en-US
        "--add-header", f"Accept-Language:{lang},{lang}-{lang.upper()};q=0.9,en;q=0.8",
        # Fallback-Kette für 403 Forbidden Fehler + Sprache
        "--extractor-args", f"youtube:player_client=default,android,ios,web;lang={lang}",
        url
    ]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=45.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(status_code=504, detail="Playlist-Abfrage hat zu lange gedauert (Timeout nach 45s). Bei sehr großen Playlists ggf. direkt als Download-Job starten.")

    items = []
    raw_lines = stdout.decode('utf-8', errors='replace').splitlines()
    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            items.append({
                "index": data.get("playlist_index") or (len(items) + 1),
                "id": data.get("id"),
                "title": data.get("title", "Unbekannter Titel"),
                "duration": data.get("duration_string") or ""
            })
        except Exception:
            pass

    if not items and proc.returncode != 0:
        err_msg = stderr.decode('utf-8', errors='replace').strip() or stdout.decode('utf-8', errors='replace').strip()
        raise HTTPException(status_code=400, detail=f"Playlist konnte nicht geladen werden: {err_msg[:200]}")

    return items


# Einfacher In-Memory TTL-Cache für Titel-Suchen. Verhindert, dass identische Suchen
# (z.B. erneutes Absenden derselben Anfrage, oder mehrere Nutzer, die dasselbe suchen)
# jedes Mal einen neuen yt-dlp Prozess anstoßen. Bewusst simpel gehalten (kein LRU-Limit,
# kein Redis) - die Ergebnismenge pro Query ist winzig (<=10 Items) und der Cache lebt
# nur im Prozessspeicher, ist also nach einem Neustart ohnehin leer.
_SEARCH_CACHE: dict[str, tuple[float, list]] = {}
_SEARCH_CACHE_TTL_SECONDS = 300
_SEARCH_CACHE_MAX_ENTRIES = 200


def _search_cache_get(key: str):
    entry = _SEARCH_CACHE.get(key)
    if not entry:
        return None
    ts, items = entry
    if time.time() - ts > _SEARCH_CACHE_TTL_SECONDS:
        _SEARCH_CACHE.pop(key, None)
        return None
    return items


def _search_cache_set(key: str, items: list):
    if len(_SEARCH_CACHE) >= _SEARCH_CACHE_MAX_ENTRIES:
        # Ältesten Eintrag verwerfen statt einer komplexen LRU-Struktur - reicht für
        # diese Cache-Größe völlig aus.
        oldest_key = min(_SEARCH_CACHE, key=lambda k: _SEARCH_CACHE[k][0])
        _SEARCH_CACHE.pop(oldest_key, None)
    _SEARCH_CACHE[key] = (time.time(), items)


@router.get("/api/ytdlp-search")
async def search_ytdlp_by_title(q: str, max_results: int = Query(8, ge=1, le=20), lang: str = "en"):
    """
    Schnelle Titel-Suche über yt-dlp's ytsearch, getrennt vom generischen
    Playlist-Endpunkt. Der Playlist-Endpunkt ist für große, potenziell heikle
    Playlists ausgelegt (mehrstufige player_client-Fallback-Kette gegen 403-Fehler,
    45s Timeout, bis zu 500 Items) - für eine simple 8-Ergebnis-Titelsuche ist das
    unnötig langsam. Hier: ein einzelner Client, kurzer Timeout, kleines Ergebnislimit,
    plus ein TTL-Cache für wiederholte Suchen.
    """
    query = q.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Suchbegriff darf nicht leer sein.")

    cache_key = f"{lang}:{max_results}:{query.lower()}"
    cached = _search_cache_get(cache_key)
    if cached is not None:
        return cached

    cmd = [
        "yt-dlp",
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
        "--ignore-errors",
        "--socket-timeout", "8",
        # Für Suche reicht ein einzelner Client - die Multi-Client-Fallback-Kette
        # (default,android,ios,web) im Playlist-Endpunkt existiert, um 403-Fehler beim
        # tatsächlichen Download zu umgehen, kostet hier aber nur unnötig Zeit.
        "--extractor-args", f"youtube:player_client=web;lang={lang}",
        "--add-header", f"Accept-Language:{lang},{lang}-{lang.upper()};q=0.9,en;q=0.8",
        f"ytsearch{max_results}:{query}",
    ]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=18.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        logger.warning(f"yt-dlp Titel-Suche Timeout für Query '{query}'")
        raise HTTPException(status_code=504, detail="Suche hat zu lange gedauert (Timeout nach 18s).")

    items = []
    for line in stdout.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except Exception:
            continue
        if not data.get("id"):
            continue
        items.append({
            "id": data.get("id"),
            "title": data.get("title", "Unbekannter Titel"),
            "duration": data.get("duration_string") or "",
            "uploader": data.get("uploader") or data.get("channel") or "",
        })

    if not items and proc.returncode != 0:
        err_msg = stderr.decode("utf-8", errors="replace").strip()
        logger.warning(f"yt-dlp Titel-Suche fehlgeschlagen für Query '{query}': {err_msg[:300]}")
        raise HTTPException(status_code=400, detail=f"Suche fehlgeschlagen: {err_msg[:200]}")

    _search_cache_set(cache_key, items)
    return items
