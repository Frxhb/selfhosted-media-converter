"""
Watch-Ordner: erkennt neue Mediendateien, die manuell oder von einem anderen Tool (rsync,
Syncthing, ein Cloud-Sync-Client, ...) in INPUT_DIR abgelegt werden, und schickt sie
automatisch durch eine konfigurierte Pipeline - ohne dass jemand die GUI öffnen muss.

Bewusst als einfaches Polling statt inotify/watchdog umgesetzt: keine zusätzliche
Abhängigkeit nötig (die im Sandbox/Prod-Image ohnehin nicht ohne Netzwerk nachinstallierbar
wäre), funktioniert zuverlässig auch über Netzwerk-Mounts/Bind-Mounts hinweg (inotify-Events
werden auf manchen Docker-Volume-Typen unzuverlässig geliefert), und die Kosten eines
os.listdir() alle paar Sekunden auf einem Ordner mit üblicherweise wenigen bis wenigen
hundert Dateien sind vernachlässigbar.
"""
import os
import time
import shutil
import asyncio
import logging

from app.core import INPUT_DIR
from app.database import load_app_config, load_pipelines
from app.models import AppConfig, Pipeline

logger = logging.getLogger("Main")

# Unterordner, in den erfolgreich zur Verarbeitung eingereihte Dateien verschoben werden -
# VOR dem Anlegen des Jobs (nicht danach), damit der eigentliche Konvertierungs-Prozess die
# Datei zuverlässig an ihrem finalen Pfad vorfindet und kein Wettlauf zwischen "Datei
# verschieben" und "Job liest die Datei" entstehen kann. Verschieben statt Löschen/Liegen-
# lassen verhindert außerdem, dass dieselbe Datei bei jedem Scan erneut aufgegriffen wird.
IMPORTED_SUBDIR_NAME = "_watch_imported"

# Bewusst eine großzügige, aber nicht unbegrenzte Liste gängiger Video-/Audio-Endungen -
# verhindert, dass z.B. eine versehentlich abgelegte .txt-Notiz oder eine .DS_Store/
# Thumbs.db-Datei als "neue Mediendatei" missverstanden und an eine Pipeline verfüttert wird.
WATCH_FOLDER_EXTENSIONS = {
    ".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".wmv", ".m4v", ".ts",
    ".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac", ".wma",
}

# Wie viele aufeinanderfolgende Scans eine Datei UNVERÄNDERTE Größe haben muss, bevor sie
# als "fertig geschrieben" gilt und verarbeitet wird - verhindert, dass eine noch aktiv
# kopierte/heruntergeladene Datei mittendrin aufgegriffen wird. Bei einem Scan-Intervall von
# z.B. 30s sind das mindestens 30s Stillstand, bevor etwas passiert.
STABILITY_CHECKS_REQUIRED = 2

WATCH_TICK_SECONDS = 10  # wie oft überhaupt geprüft wird, ob ein Scan fällig ist (unabhängig
                          # vom konfigurierbaren watch_folder_interval_seconds zwischen Scans)


class WatchFolderService:
    def __init__(self, job_manager):
        self.job_manager = job_manager
        self._task: asyncio.Task | None = None
        self._candidates: dict[str, tuple[float, int]] = {}  # path -> (mtime, size), für die Stabilitätsprüfung
        self._stable_hits: dict[str, int] = {}  # path -> Anzahl aufeinanderfolgender unveränderter Scans
        self._last_scan_at = 0.0

    def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._loop())
            logger.info("Watch-Ordner Hintergrund-Task gestartet.")

    async def _loop(self):
        while True:
            await asyncio.sleep(WATCH_TICK_SECONDS)
            try:
                await self._maybe_scan()
            except Exception as e:
                logger.warning(f"Watch-Ordner Scan fehlgeschlagen: {e}")

    async def _maybe_scan(self):
        cfg = self._load_config()
        if not cfg or not cfg.watch_folder_enabled:
            return
        if not cfg.watch_folder_pipeline_id:
            return  # aktiviert, aber keine Pipeline hinterlegt - nichts sinnvoll zu tun

        interval = max(10, cfg.watch_folder_interval_seconds)
        now = time.time()
        if now - self._last_scan_at < interval:
            return
        self._last_scan_at = now

        await self._scan_once(cfg)

    def _load_config(self) -> AppConfig | None:
        try:
            saved = load_app_config()
            if not saved:
                return None
            return AppConfig(**saved)
        except Exception as e:
            logger.warning(f"Watch-Ordner: Konfiguration konnte nicht gelesen werden: {e}")
            return None

    async def _scan_once(self, cfg: AppConfig):
        if not os.path.isdir(INPUT_DIR):
            return

        try:
            entries = os.listdir(INPUT_DIR)
        except Exception as e:
            logger.warning(f"Watch-Ordner: INPUT_DIR konnte nicht gelistet werden: {e}")
            return

        seen_this_scan = set()

        for name in entries:
            if name == IMPORTED_SUBDIR_NAME or name.startswith("."):
                continue
            full_path = os.path.join(INPUT_DIR, name)
            if not os.path.isfile(full_path):
                continue  # Unterordner werden bewusst nicht rekursiv durchsucht
            ext = os.path.splitext(name)[1].lower()
            if ext not in WATCH_FOLDER_EXTENSIONS:
                continue

            try:
                stat = os.stat(full_path)
            except FileNotFoundError:
                continue  # zwischen listdir() und stat() verschwunden - ignorieren

            fingerprint = (stat.st_mtime, stat.st_size)
            seen_this_scan.add(full_path)

            previous = self._candidates.get(full_path)
            if previous == fingerprint:
                self._stable_hits[full_path] = self._stable_hits.get(full_path, 0) + 1
            else:
                self._stable_hits[full_path] = 0
            self._candidates[full_path] = fingerprint

            if self._stable_hits[full_path] >= STABILITY_CHECKS_REQUIRED:
                await self._import_file(full_path, cfg)
                self._candidates.pop(full_path, None)
                self._stable_hits.pop(full_path, None)

        # Buchhaltung für Dateien aufräumen, die zwischenzeitlich verschwunden sind (manuell
        # gelöscht, o.ä.), damit die beiden Dicts nicht unbegrenzt wachsen.
        for stale_path in list(self._candidates.keys()):
            if stale_path not in seen_this_scan:
                self._candidates.pop(stale_path, None)
                self._stable_hits.pop(stale_path, None)

    async def _import_file(self, full_path: str, cfg: AppConfig):
        pipeline_dict = next(
            (p for p in load_pipelines() if p.get("id") == cfg.watch_folder_pipeline_id), None
        )
        if not pipeline_dict:
            logger.warning(
                f"Watch-Ordner: konfigurierte Pipeline '{cfg.watch_folder_pipeline_id}' nicht "
                f"gefunden (evtl. gelöscht) - '{os.path.basename(full_path)}' wird übersprungen."
            )
            return

        imported_dir = os.path.join(INPUT_DIR, IMPORTED_SUBDIR_NAME)
        try:
            os.makedirs(imported_dir, exist_ok=True)
        except Exception as e:
            logger.warning(f"Watch-Ordner: Zielordner konnte nicht angelegt werden: {e}")
            return

        base_name = os.path.basename(full_path)
        dest_path = os.path.join(imported_dir, base_name)
        if os.path.exists(dest_path):
            # Namenskollision (z.B. gleicher Dateiname erneut abgelegt) - Zeitstempel anhängen
            # statt die vorhandene Datei zu überschreiben.
            stem, ext = os.path.splitext(base_name)
            dest_path = os.path.join(imported_dir, f"{stem}_{int(time.time())}{ext}")

        try:
            # Verschieben passiert VOR dem Job-Start (nicht danach) - siehe Modul-Docstring
            # zum Wettlauf-Risiko, das das vermeidet.
            shutil.move(full_path, dest_path)
        except Exception as e:
            logger.warning(f"Watch-Ordner: '{base_name}' konnte nicht verschoben werden: {e}")
            return

        try:
            pipeline_obj = Pipeline(**pipeline_dict)
            title = os.path.splitext(base_name)[0]
            await self.job_manager.start_pipeline_run(pipeline_obj, dest_path, title=title)
            logger.info(
                f"Watch-Ordner: '{base_name}' erkannt und automatisch in Pipeline "
                f"'{pipeline_obj.name}' eingereiht."
            )
        except Exception as e:
            logger.warning(f"Watch-Ordner: Pipeline-Start für '{base_name}' fehlgeschlagen: {e}")


watch_folder_service: WatchFolderService | None = None


def init_watch_folder_service(job_manager) -> WatchFolderService:
    global watch_folder_service
    watch_folder_service = WatchFolderService(job_manager)
    return watch_folder_service
