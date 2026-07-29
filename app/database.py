import os
import json
import sqlite3
import logging
from contextlib import contextmanager

logger = logging.getLogger("Database")

DB_PATH = os.getenv("DB_PATH", "/app/config/mcp_stats.db")
CONFIG_JSON_PATH = os.getenv("CONFIG_JSON_PATH", "/app/config/app_config.json")
PIPELINES_JSON_PATH = os.getenv("PIPELINES_JSON_PATH", "/app/config/pipelines.json")
SUBSCRIPTIONS_JSON_PATH = os.getenv("SUBSCRIPTIONS_JSON_PATH", "/app/config/subscriptions.json")


@contextmanager
def get_connection():
    """Context Manager für garantiert geschlossene SQLite-Verbindungen (inkl. WAL-Mode gegen Lock-Konflikte)."""
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    """Legt DB-Tabelle an und migriert automatisch alle fehlenden Spalten nach."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS job_history (
                id TEXT PRIMARY KEY,
                title TEXT,
                job_type TEXT,
                status TEXT,
                tool TEXT DEFAULT '',
                size_mb REAL DEFAULT 0,
                input_size_mb REAL DEFAULT 0,
                duration_sec REAL DEFAULT 0,
                ext TEXT DEFAULT '',
                is_playlist INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # Automatische Schema-Migration für ältere mcp_stats.db Dateien
        existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_history)")}
        migrations = {
            "tool": "TEXT DEFAULT ''",
            "size_mb": "REAL DEFAULT 0",
            "input_size_mb": "REAL DEFAULT 0",
            "duration_sec": "REAL DEFAULT 0",
            "ext": "TEXT DEFAULT ''",
            "is_playlist": "INTEGER DEFAULT 0",
        }
        for col, coltype in migrations.items():
            if col not in existing_cols:
                try:
                    conn.execute(f"ALTER TABLE job_history ADD COLUMN {col} {coltype}")
                    logger.info(f"DB Migration: Spalte '{col}' erfolgreich hinzugefügt.")
                except Exception as e:
                    logger.warning(f"Spalte '{col}' konnte nicht hinzugefügt werden: {e}")


def record_job(job_id: str, title: str, job_type: str, status: str,
               size_mb: float = 0.0, duration_sec: float = 0.0, ext: str = "",
               tool: str = "", input_size_mb: float = 0.0, is_playlist: bool = False):
    """Schreibt einen Job in die Historie."""
    if not ext and title:
        ext = os.path.splitext(title)[1]
    try:
        with get_connection() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO job_history
                   (id, title, job_type, status, tool, size_mb, input_size_mb,
                    duration_sec, ext, is_playlist)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (job_id, title, job_type, status, tool, size_mb, input_size_mb,
                 duration_sec, ext, 1 if is_playlist else 0)
            )
    except Exception as e:
        logger.warning(f"record_job fehlgeschlagen: {e}")


def clear_db():
    """Leert die Historie komplett."""
    try:
        with get_connection() as conn:
            conn.execute("DELETE FROM job_history")
    except Exception as e:
        logger.warning(f"clear_db fehlgeschlagen: {e}")


def load_app_config() -> dict:
    """Lädt persistierte App-Konfiguration von der Festplatte. Gibt {} zurück falls nicht vorhanden."""
    try:
        if os.path.exists(CONFIG_JSON_PATH):
            with open(CONFIG_JSON_PATH, "r") as f:
                return json.load(f)
    except Exception as e:
        logger.warning(f"load_app_config fehlgeschlagen, nutze Defaults: {e}")
    return {}


def save_app_config(config: dict):
    """Persistiert App-Konfiguration atomar auf die Festplatte (überlebt Container-Neustarts)."""
    try:
        os.makedirs(os.path.dirname(CONFIG_JSON_PATH), exist_ok=True)
        tmp_path = CONFIG_JSON_PATH + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(config, f, indent=2)
        os.replace(tmp_path, CONFIG_JSON_PATH)
    except Exception as e:
        logger.error(f"save_app_config fehlgeschlagen: {e}")
        raise


def load_pipelines() -> list:
    """Lädt alle gespeicherten Pipeline-Definitionen. Gibt [] zurück falls keine Datei existiert."""
    try:
        if os.path.exists(PIPELINES_JSON_PATH):
            with open(PIPELINES_JSON_PATH, "r") as f:
                return json.load(f)
    except Exception as e:
        logger.warning(f"load_pipelines fehlgeschlagen, nutze leere Liste: {e}")
    return []


def save_pipelines(pipelines: list):
    """Persistiert die komplette Pipeline-Liste atomar auf die Festplatte."""
    try:
        os.makedirs(os.path.dirname(PIPELINES_JSON_PATH), exist_ok=True)
        tmp_path = PIPELINES_JSON_PATH + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(pipelines, f, indent=2)
        os.replace(tmp_path, PIPELINES_JSON_PATH)
    except Exception as e:
        logger.error(f"save_pipelines fehlgeschlagen: {e}")
        raise


def load_subscriptions() -> list:
    """Lädt alle gespeicherten Kanal-Abonnements. Gibt [] zurück falls keine Datei existiert."""
    try:
        if os.path.exists(SUBSCRIPTIONS_JSON_PATH):
            with open(SUBSCRIPTIONS_JSON_PATH, "r") as f:
                return json.load(f)
    except Exception as e:
        logger.warning(f"load_subscriptions fehlgeschlagen, nutze leere Liste: {e}")
    return []


def save_subscriptions(subscriptions: list):
    """Persistiert die komplette Abonnement-Liste atomar auf die Festplatte."""
    try:
        os.makedirs(os.path.dirname(SUBSCRIPTIONS_JSON_PATH), exist_ok=True)
        tmp_path = SUBSCRIPTIONS_JSON_PATH + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(subscriptions, f, indent=2)
        os.replace(tmp_path, SUBSCRIPTIONS_JSON_PATH)
    except Exception as e:
        logger.error(f"save_subscriptions fehlgeschlagen: {e}")
        raise


def _row_or_default(cursor, default=("-", 0)):
    try:
        row = cursor.fetchone()
        return row if row and row[0] is not None else default
    except Exception:
        return default


def find_similar_completed_jobs(size_mb: float, duration_sec: float,
                                 size_tolerance_pct: float = 2.0, duration_tolerance_sec: float = 1.5) -> list:
    """Sucht abgeschlossene Jobs mit sehr ähnlicher Dateigröße UND Dauer (schneller Fingerprint-Vergleich,
    kein vollständiges Datei-Hashing). Gibt eine Liste möglicher Duplikate zurück (Titel, Größe, Dauer, Datum)."""
    if size_mb <= 0 and duration_sec <= 0:
        return []
    try:
        with get_connection() as conn:
            cursor = conn.cursor()
            size_low = size_mb * (1 - size_tolerance_pct / 100) if size_mb > 0 else 0
            size_high = size_mb * (1 + size_tolerance_pct / 100) if size_mb > 0 else float("inf")
            dur_low = duration_sec - duration_tolerance_sec if duration_sec > 0 else 0
            dur_high = duration_sec + duration_tolerance_sec if duration_sec > 0 else float("inf")

            cursor.execute(
                """SELECT title, size_mb, duration_sec, created_at FROM job_history
                   WHERE status = 'completed'
                   AND (size_mb BETWEEN ? AND ?)
                   AND (duration_sec BETWEEN ? AND ?)
                   ORDER BY created_at DESC LIMIT 5""",
                (size_low, size_high, dur_low, dur_high)
            )
            rows = cursor.fetchall()
            return [{"title": r[0], "size_mb": r[1], "duration_sec": r[2], "created_at": r[3]} for r in rows]
    except Exception as e:
        logger.warning(f"find_similar_completed_jobs fehlgeschlagen: {e}")
        return []


def get_nerd_stats():
    """Berechnet Nerd-Stats aus der SQLite-Datenbank fehlertolerant."""
    try:
        with get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute(
                "SELECT COUNT(*), SUM(size_mb), SUM(duration_sec) "
                "FROM job_history WHERE status = 'completed'"
            )
            res = cursor.fetchone()
            total_jobs, total_size, total_dur = (res[0] or 0) if res else 0, (res[1] or 0.0) if res else 0.0, (res[2] or 0.0) if res else 0.0

            cursor.execute(
                "SELECT COUNT(*), SUM(size_mb), SUM(duration_sec) "
                "FROM job_history WHERE job_type = 'download' AND status = 'completed'"
            )
            res = cursor.fetchone()
            dl_count, dl_size_mb, dl_duration_sec = (res[0] or 0) if res else 0, (res[1] or 0.0) if res else 0.0, (res[2] or 0.0) if res else 0.0

            cursor.execute(
                "SELECT COUNT(*) FROM job_history "
                "WHERE job_type = 'download' AND status = 'completed' AND is_playlist = 1"
            )
            playlist_res = cursor.fetchone()
            playlist_count = playlist_res[0] if playlist_res else 0

            cursor.execute(
                "SELECT COUNT(*) FROM job_history "
                "WHERE job_type != 'download' AND status = 'completed'"
            )
            conv_res = cursor.fetchone()
            convs = conv_res[0] if conv_res else 0

            cursor.execute(
                "SELECT title, size_mb FROM job_history "
                "WHERE status = 'completed' AND size_mb > 0 ORDER BY size_mb DESC LIMIT 1"
            )
            biggest = _row_or_default(cursor)

            cursor.execute(
                "SELECT title, size_mb FROM job_history "
                "WHERE status = 'completed' AND size_mb > 0 ORDER BY size_mb ASC LIMIT 1"
            )
            smallest = _row_or_default(cursor)

            cursor.execute(
                "SELECT title, duration_sec FROM job_history "
                "WHERE status = 'completed' AND duration_sec > 0 ORDER BY duration_sec DESC LIMIT 1"
            )
            longest = _row_or_default(cursor)

            cursor.execute(
                "SELECT title, duration_sec FROM job_history "
                "WHERE status = 'completed' AND duration_sec > 0 ORDER BY duration_sec ASC LIMIT 1"
            )
            shortest = _row_or_default(cursor)

            cursor.execute(
                "SELECT ext, COUNT(*) FROM job_history "
                "WHERE status = 'completed' AND ext != '' GROUP BY ext ORDER BY COUNT(*) DESC LIMIT 1"
            )
            common_ext = _row_or_default(cursor, default=("-", 0))

            cursor.execute(
                "SELECT tool, COUNT(*) FROM job_history "
                "WHERE status = 'completed' AND tool != '' GROUP BY tool ORDER BY COUNT(*) DESC LIMIT 1"
            )
            common_tool = _row_or_default(cursor, default=("-", 0))

            cursor.execute("SELECT COUNT(*) FROM job_history WHERE status = 'failed'")
            fail_res = cursor.fetchone()
            fails = fail_res[0] if fail_res else 0

        return {
            "total_jobs": total_jobs,
            "total_gb": round(total_size / 1024, 2),
            "total_hours": round(total_dur / 3600, 2),

            "downloads": dl_count,
            "download_gb": round(dl_size_mb / 1024, 2),
            "download_hours": round(dl_duration_sec / 3600, 2),
            "playlists_downloaded": playlist_count,

            "conversions": convs,
            "fails": fails,
            "success_rate": round((total_jobs / (total_jobs + fails) * 100), 1) if (total_jobs + fails) > 0 else 100.0,

            "biggest": {"name": biggest[0], "val": biggest[1]},
            "smallest": {"name": smallest[0], "val": smallest[1]},
            "longest": {"name": longest[0], "val": round(longest[1] / 60, 1)},
            "shortest": {"name": shortest[0], "val": round(shortest[1] / 60, 1)},
            "common_ext": common_ext[0],
            "common_tool": common_tool[0],
        }
    except Exception as e:
        logger.error(f"get_nerd_stats Error: {e}")
        return {
            "total_jobs": 0, "total_gb": 0, "total_hours": 0,
            "downloads": 0, "download_gb": 0, "download_hours": 0, "playlists_downloaded": 0,
            "conversions": 0, "fails": 0, "success_rate": 100.0,
            "biggest": {"name": "-", "val": 0}, "smallest": {"name": "-", "val": 0},
            "longest": {"name": "-", "val": 0}, "shortest": {"name": "-", "val": 0},
            "common_ext": "-", "common_tool": "-"
        }
