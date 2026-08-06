"""Hintergrund-Scheduler für Kanal-Abonnements: prüft periodisch auf neue Videos und
stellt automatisch Download-Jobs in die Warteschlange. Nutzt yt-dlp's eingebautes
--download-archive (eine Textdatei pro Subscription mit bereits gesehenen Video-IDs),
damit kein eigenes Duplikat-Tracking nötig ist - yt-dlp überspringt Einträge in der
Archiv-Datei zuverlässig von selbst.

Bewusst als eigenes Modul statt Teil von job_manager.py, da es eine klar abgegrenzte
Zuständigkeit hat (Scheduling/Polling) und nicht die Job-Ausführung selbst betrifft.
"""
import os
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Optional

from app.models import Subscription, SubscriptionCreateRequest, JobCreateRequest, JobType
from app.database import load_subscriptions, save_subscriptions
from app.core import SUBSCRIPTION_ARCHIVE_DIR, OUTPUT_DIR, OUTPUT_SUBDIR_SCHEDULED, sanitize_folder_name, DOWNLOAD_TEMP_DIR

logger = logging.getLogger("SubscriptionManager")

# Wie oft der Scheduler-Loop aufwacht, um zu prüfen ob irgendeine Subscription fällig ist.
# Muss nicht mit den einzelnen check_interval_minutes übereinstimmen - dient nur als
# Granularität, in der Fälligkeiten erkannt werden (1 Minute ist fein genug, ohne unnötig
# oft im Leerlauf zu prüfen).
SCHEDULER_TICK_SECONDS = 60

# Backoff für fehlschlagende Abo-Checks: ohne dies würde ein transienter Fehler (z.B.
# YouTube-Rate-Limiting, kurzer Netzwerk-Aussetzer) dazu führen, dass die Subscription erst
# beim NÄCHSTEN reguladdren Intervall erneut geprüft wird - bei einem 6h-Intervall im
# schlimmsten Fall fast 6 Stunden Wartezeit für einen einzigen Ausrutscher. Stattdessen wird
# nach einem Fehler exponentiell schneller erneut versucht (2, 4, 8, 16, ... Minuten),
# gedeckelt durch das reguläre Intervall selbst (nie öfter als normal) und einen harten
# Maximalwert (nie länger als das normale Intervall warten müssen, selbst bei sehr langen
# Intervallen).
BACKOFF_BASE_MINUTES = 2
BACKOFF_MAX_MINUTES = 240


def _next_check_delay_minutes(sub: Subscription) -> int:
    """Wie viele Minuten seit dem letzten Check müssen vergangen sein, bevor ein erneuter
    Check fällig ist? Normalerweise das konfigurierte Intervall - nach einem Fehlschlag
    stattdessen ein kürzeres, exponentiell wachsendes Backoff-Intervall."""
    if sub.last_check_status == "error" and sub.consecutive_failures > 0:
        backoff = BACKOFF_BASE_MINUTES * (2 ** (sub.consecutive_failures - 1))
        return max(1, min(backoff, sub.check_interval_minutes, BACKOFF_MAX_MINUTES))
    return sub.check_interval_minutes


class SubscriptionManager:
    def __init__(self, job_manager):
        self.job_manager = job_manager
        self.subscriptions: Dict[str, Subscription] = {}
        self._scheduler_task: Optional[asyncio.Task] = None
        self._check_locks: Dict[str, asyncio.Lock] = {}  # verhindert überlappende Checks derselben Subscription

    def load(self):
        raw = load_subscriptions()
        self.subscriptions = {s["id"]: Subscription(**s) for s in raw}

    def _persist(self):
        save_subscriptions([s.model_dump() for s in self.subscriptions.values()])

    def get_all(self) -> list:
        return list(self.subscriptions.values())

    def get(self, sub_id: str) -> Optional[Subscription]:
        return self.subscriptions.get(sub_id)

    def create(self, request: SubscriptionCreateRequest) -> Subscription:
        sub = Subscription(**request.model_dump())
        self.subscriptions[sub.id] = sub
        self._persist()
        return sub

    def update(self, sub_id: str, request: SubscriptionCreateRequest) -> Optional[Subscription]:
        existing = self.subscriptions.get(sub_id)
        if not existing:
            return None
        updated = existing.model_copy(update=request.model_dump())
        self.subscriptions[sub_id] = updated
        self._persist()
        return updated

    def delete(self, sub_id: str) -> bool:
        if sub_id not in self.subscriptions:
            return False
        del self.subscriptions[sub_id]
        self._check_locks.pop(sub_id, None)
        self._persist()
        archive_path = self._archive_path(sub_id)
        if os.path.exists(archive_path):
            try:
                os.remove(archive_path)
            except Exception as e:
                logger.warning(f"Archiv-Datei für gelöschte Subscription {sub_id} konnte nicht entfernt werden: {e}")
        return True

    @staticmethod
    def _archive_path(sub_id: str) -> str:
        os.makedirs(SUBSCRIPTION_ARCHIVE_DIR, exist_ok=True)
        return os.path.join(SUBSCRIPTION_ARCHIVE_DIR, f"{sub_id}.txt")

    def _output_dir_for(self, sub: Subscription) -> str:
        folder_name = sanitize_folder_name(sub.name, fallback=sub.id)
        path = os.path.join(OUTPUT_DIR, OUTPUT_SUBDIR_SCHEDULED, folder_name)
        os.makedirs(path, exist_ok=True)
        return path

    async def start(self):
        self.load()
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())
        logger.info(f"SubscriptionManager gestartet ({len(self.subscriptions)} Abonnements geladen).")

    async def _scheduler_loop(self):
        while True:
            try:
                await self._tick()
            except Exception as e:
                logger.error(f"Fehler im Subscription-Scheduler-Tick: {e}")
            await asyncio.sleep(SCHEDULER_TICK_SECONDS)

    async def _tick(self):
        self._reconcile_download_counts()
        now = datetime.now()
        for sub in list(self.subscriptions.values()):
            if not sub.enabled:
                continue
            due = True
            if sub.last_checked_at:
                try:
                    last = datetime.fromisoformat(sub.last_checked_at)
                    due = now >= last + timedelta(minutes=_next_check_delay_minutes(sub))
                except Exception:
                    due = True
            if due:
                asyncio.create_task(self.check_now(sub.id))

    async def check_now(self, sub_id: str) -> dict:
        """Prüft eine einzelne Subscription sofort auf neue Videos (manuell oder vom
        Scheduler ausgelöst) und queued Download-Jobs für alles Neue. Gibt ein Ergebnis-Dict
        zurück, das auch direkt als API-Antwort dienen kann."""
        sub = self.subscriptions.get(sub_id)
        if not sub:
            return {"status": "error", "detail": "Subscription nicht gefunden."}

        lock = self._check_locks.setdefault(sub_id, asyncio.Lock())
        if lock.locked():
            return {"status": "skipped", "detail": "Prüfung läuft bereits."}

        async with lock:
            archive_path = self._archive_path(sub_id)
            is_first_check = not os.path.exists(archive_path)
            new_video_ids = []
            error_msg = None

            try:
                new_video_ids = await self._fetch_new_video_ids(sub, archive_path)
            except Exception as e:
                error_msg = str(e)
                logger.error(f"Abo-Prüfung fehlgeschlagen für '{sub.name}' ({sub.url}): {error_msg}")

            sub.last_checked_at = datetime.now().isoformat()
            if error_msg:
                sub.last_check_status = "error"
                sub.last_check_error = error_msg[:500]
                sub.last_check_new_count = 0
                sub.consecutive_failures += 1
                self._persist()
                return {"status": "error", "detail": error_msg}

            sub.last_check_status = "ok"
            sub.last_check_error = None
            sub.consecutive_failures = 0

            # WICHTIG: Beim allerersten Check einer Subscription (Archiv-Datei existiert
            # noch nicht) gilt der GESAMTE bisherige Kanal-Katalog als "neu" - das würde bei
            # großen/aktiven Kanälen (z.B. Nachrichten-/TV-Sender) sofort dutzende Downloads
            # gleichzeitig auslösen und die UI durch die Flut an WebSocket-Updates einfrieren
            # lassen. Stattdessen wird beim ersten Check nur die Archiv-Datei mit allen
            # aktuell gefundenen Video-IDs "geseedet", OHNE etwas herunterzuladen - ab dem
            # NÄCHSTEN Check gelten dann nur noch wirklich neu hinzugekommene Videos als neu.
            # Ausnahme: wurde beim Anlegen ein backfill_count > 0 angegeben, werden die N
            # neuesten bestehenden Videos trotzdem heruntergeladen (der Rest wird weiterhin
            # nur geseedet, nicht geladen).
            if is_first_check:
                to_backfill = new_video_ids[: sub.backfill_count] if sub.backfill_count > 0 else []
                to_seed_only = new_video_ids[len(to_backfill):]

                self._seed_archive(archive_path, to_seed_only)

                queued = 0
                for video_id in to_backfill:
                    try:
                        await self._queue_download(sub, video_id)
                        queued += 1
                        if queued % 3 == 0:
                            await asyncio.sleep(0.3)
                    except Exception as e:
                        logger.warning(f"Backfill-Download für Video {video_id} (Subscription {sub.name}) fehlgeschlagen: {e}")

                sub.last_check_new_count = 0
                self._persist()
                detail = f"Erster Check: {len(to_seed_only)} bestehende Video(s) als bereits bekannt markiert, ohne sie herunterzuladen."
                if queued > 0:
                    detail = f"Erster Check: {queued} der letzten Videos werden nachgeladen, {len(to_seed_only)} weitere als bereits bekannt markiert (nicht geladen)."
                return {
                    "status": "ok",
                    "new_videos": 0,
                    "queued": queued,
                    "seeded": len(to_seed_only),
                    "detail": detail,
                }

            sub.last_check_new_count = len(new_video_ids)

            queued = 0
            for video_id in new_video_ids:
                try:
                    await self._queue_download(sub, video_id)
                    queued += 1
                    # Kurze Pause zwischen dem Anlegen einzelner Jobs: verhindert, dass bei
                    # vielen gleichzeitig neuen Videos (z.B. nach einer Downtime) die UI mit
                    # einer Flut an WebSocket-Nachrichten (job_created + queue_reordered pro
                    # Job) in kurzer Zeit überschwemmt wird und einfriert.
                    if queued % 3 == 0:
                        await asyncio.sleep(0.3)
                except Exception as e:
                    logger.warning(f"Konnte Download für Video {video_id} (Subscription {sub.name}) nicht starten: {e}")

            # total_downloaded wird NICHT hier hochgezählt: "queued" bedeutet nur, dass ein
            # Job angelegt wurde, nicht dass er auch erfolgreich fertig wurde. Bricht der Nutzer
            # den Job danach ab oder schlägt er fehl, würde er sonst trotzdem als "heruntergeladen"
            # gezählt. Stattdessen zählt _reconcile_download_counts() (vom Scheduler-Tick
            # aufgerufen) die tatsächlich abgeschlossenen Jobs pro Subscription nach.
            self._persist()
            return {"status": "ok", "new_videos": len(new_video_ids), "queued": queued}

    def _reconcile_download_counts(self):
        """Zählt für jede Subscription nach, wie viele ihrer Jobs tatsächlich erfolgreich
        abgeschlossen wurden (Status COMPLETED), und aktualisiert total_downloaded entsprechend.
        Wird vom Scheduler-Tick periodisch aufgerufen, damit abgebrochene oder fehlgeschlagene
        Downloads NICHT mitgezählt werden, auch wenn sie ursprünglich erfolgreich gequeued wurden."""
        try:
            all_jobs = self.job_manager.get_all_jobs()
        except Exception:
            return

        completed_counts: Dict[str, int] = {}
        for job in all_jobs:
            sub_id = getattr(job, "subscription_id", None)
            if not sub_id:
                continue
            if job.status.value == "completed":
                completed_counts[sub_id] = completed_counts.get(sub_id, 0) + 1

        changed = False
        for sub_id, count in completed_counts.items():
            sub = self.subscriptions.get(sub_id)
            if sub and sub.total_downloaded != count:
                sub.total_downloaded = count
                changed = True

        if changed:
            self._persist()

    @staticmethod
    def _seed_archive(archive_path: str, video_ids: list):
        """Schreibt eine Liste von Video-IDs direkt in die yt-dlp Archiv-Datei, ohne dass
        yt-dlp sie tatsächlich herunterlädt. Nutzt dasselbe Zeilenformat, das yt-dlp selbst
        für --download-archive verwendet ("youtube <video_id>"), damit spätere echte
        Downloads dieselbe Datei nahtlos weiterschreiben."""
        try:
            with open(archive_path, "a") as f:
                for vid in video_ids:
                    f.write(f"youtube {vid}\n")
        except Exception as e:
            logger.warning(f"Archiv-Datei konnte nicht geseedet werden ({archive_path}): {e}")

    async def _fetch_new_video_ids(self, sub: Subscription, archive_path: str) -> list:
        """Ruft die neuesten Video-IDs des Kanals/Playlist ab und filtert gegen die
        Archiv-Datei, um nur wirklich neue Videos zurückzugeben. Nutzt --flat-playlist
        (kein voller Metadaten-Download je Video) für einen schnellen, günstigen Check."""
        already_seen = set()
        if os.path.exists(archive_path):
            try:
                with open(archive_path, "r") as f:
                    for line in f:
                        parts = line.strip().split()
                        if len(parts) == 2:
                            already_seen.add(parts[1])  # Format: "youtube <video_id>"
            except Exception:
                pass

        cmd = [
            "yt-dlp",
            "--flat-playlist",
            "--dump-json",
            "--no-warnings",
            "--ignore-errors",
            "--playlist-end", str(sub.max_items_per_check),
            "--extractor-args", "youtube:player_client=default,android,ios,web",
            sub.url,
        ]
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60.0)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError("Zeitüberschreitung beim Abrufen der Kanal-Videos (60s).")

        import json
        new_ids = []
        skipped_upcoming = 0
        skipped_shorts = 0
        for line in stdout.decode("utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                vid = data.get("id")
                if not vid or vid in already_seen:
                    continue
                # Angekündigte/noch nicht laufende Livestreams ("Premiere in X Stunden") würden
                # sonst als Download-Job gequeued, sofort mit einem yt-dlp Fehler ("This live
                # event will begin in X hours") fehlschlagen, UND dabei bereits ins Archiv
                # eingetragen werden - das Video würde also nie automatisch nachgeladen, sobald
                # es tatsächlich läuft. Solche Einträge werden daher übersprungen (nicht
                # geseedet), damit ein späterer Check sie erneut als "neu" erkennt.
                live_status = data.get("live_status")
                if live_status in ("is_upcoming", "upcoming") or data.get("is_upcoming"):
                    skipped_upcoming += 1
                    continue
                # YouTube Shorts erkennt yt-dlp im flat-playlist Dump eines Kanals über die
                # URL des Eintrags ("/shorts/<id>" statt "/watch?v=<id>") - zuverlässiger als
                # z.B. über die Videolänge, da auch reguläre Videos kurz sein können.
                if sub.exclude_shorts:
                    entry_url = (data.get("url") or data.get("webpage_url") or "")
                    if "/shorts/" in entry_url:
                        skipped_shorts += 1
                        continue
                new_ids.append(vid)
            except Exception:
                pass

        if skipped_upcoming:
            logger.info(f"{skipped_upcoming} angekündigte(r)/noch nicht gestartete(r) Livestream(s) übersprungen (Subscription: {sub.name}).")
        if skipped_shorts:
            logger.info(f"{skipped_shorts} YouTube Short(s) übersprungen (Subscription: {sub.name}, exclude_shorts aktiv).")

        if not new_ids and proc.returncode != 0:
            err_msg = stderr.decode("utf-8", errors="replace").strip() or "Unbekannter yt-dlp Fehler"
            raise RuntimeError(err_msg[:300])

        return new_ids

    async def _queue_download(self, sub: Subscription, video_id: str):
        """Erstellt einen normalen Download-Job für ein einzelnes neu gefundenes Video.
        Nutzt --download-archive, damit yt-dlp die Video-ID selbst in die Archiv-Datei
        einträgt (gleiche Quelle der Wahrheit, die auch beim nächsten Check gelesen wird)."""
        video_url = f"https://www.youtube.com/watch?v={video_id}"
        output_dir = self._output_dir_for(sub)
        archive_path = self._archive_path(sub.id)

        if sub.download_type == "audio":
            args = [
                "--no-colors", "--no-playlist",
                "-x", "--audio-format", sub.container, "--audio-quality", sub.quality,
                "--download-archive", archive_path,
                "--paths", f"temp:{DOWNLOAD_TEMP_DIR}",
                "-o", os.path.join(output_dir, "%(title)s.%(ext)s"),
            ]
            job_type = JobType.DOWNLOAD
        else:
            args = ["--no-colors", "--no-playlist"]
            if sub.quality != "best":
                args.extend(["-f", f"bestvideo[height<={sub.quality}]+bestaudio/best"])
            args.extend([
                "--merge-output-format", sub.container,
                "--download-archive", archive_path,
                "--paths", f"temp:{DOWNLOAD_TEMP_DIR}",
                "-o", os.path.join(output_dir, "%(title)s.%(ext)s"),
            ])
            job_type = JobType.DOWNLOAD

        args.append(video_url)

        request = JobCreateRequest(
            job_type=job_type,
            tool="yt-dlp",
            title=f"[{sub.name}] Neues Video",
            command_args=args,
            input_file=video_url,
            subscription_id=sub.id,
        )
        await self.job_manager.add_job(request)


subscription_manager: Optional[SubscriptionManager] = None


def init_subscription_manager(job_manager) -> SubscriptionManager:
    global subscription_manager
    subscription_manager = SubscriptionManager(job_manager)
    return subscription_manager
