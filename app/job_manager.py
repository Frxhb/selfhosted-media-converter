import os
import re
import asyncio
import logging
import urllib.request
import urllib.parse
from typing import Dict, List, Optional, Set
from fastapi import WebSocket
import uuid
from app.models import Job, JobCreateRequest, JobStatus, JobType, Pipeline, PipelineStage
from app.database import record_job
from app.core import COOKIES_FILE_PATH, OUTPUT_DIR

logger = logging.getLogger("JobManager")

class JobManager:
    def __init__(self):
        self.jobs: Dict[str, Job] = {}
        self.pending_queue: List[str] = []  # ordered list of pending job IDs; supports manual reordering
        self.queue_lock = asyncio.Lock()
        self.queue_event = asyncio.Event()  # signaled whenever a new job is queued
        self.max_concurrent_jobs = int(os.getenv("MAX_CONCURRENT_JOBS", 2))
        self.max_concurrent_per_domain = int(os.getenv("MAX_CONCURRENT_PER_DOMAIN", 2))
        self.max_concurrent_whisper_jobs = int(os.getenv("MAX_CONCURRENT_WHISPER_JOBS", 1))
        self.min_free_disk_gb = float(os.getenv("MIN_FREE_DISK_GB", 2.0))
        self.prevent_output_overwrite = os.getenv("PREVENT_OUTPUT_OVERWRITE", "true").lower() == "true"
        self.running_processes: Dict[str, asyncio.subprocess.Process] = {}
        self.active_websockets: Set[WebSocket] = set()
        self.workers: List[asyncio.Task] = []
        self.max_auto_retries = 2  # total attempts = 1 + this

        # Aktive Pipeline-Läufe: run_id -> {"pipeline": Pipeline, "stage_index": int,
        # "current_job_id": str, "title": str}. Wird nur im RAM gehalten (kein Neustart-Überleben),
        # analog zur bestehenden self.jobs Queue.
        self.pipeline_runs: Dict[str, dict] = {}

        # FFMPEG_THREADS: "Auto" (or unset/invalid) lets ffmpeg pick automatically (-threads 0).
        # A positive integer pins ffmpeg to that many threads.
        raw_threads = os.getenv("FFMPEG_THREADS", "Auto").strip()
        self.ffmpeg_threads = int(raw_threads) if raw_threads.isdigit() and int(raw_threads) > 0 else 0

        # DEFAULT_PRIORITY: OS process niceness for spawned ffmpeg/yt-dlp/whisper processes.
        # Lower priority keeps the UI/API responsive during heavy transcodes.
        self.process_niceness = self.priority_label_to_niceness(os.getenv("DEFAULT_PRIORITY", "below_normal"))

        self.auto_delete_originals = os.getenv("AUTO_DELETE_ORIGINALS", "false").lower() == "true"

        self.regex = {
            "ffmpeg_time": re.compile(r"time=\s*(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?"),
            "ffmpeg_duration": re.compile(r"Duration:\s*(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?"),
            "ffmpeg_speed": re.compile(r"speed=\s*([\d\.]+)x"),
            "ytdlp_prog": re.compile(r"\[download\]\s+(\d+\.?\d*)%"),
            "ytdlp_eta": re.compile(r"ETA\s+([\d:]+)"),
            "ytdlp_speed": re.compile(r"at\s+([\d\.]+\s*[kMG]?i?B/s)"),
	    "ytdlp_dest": re.compile(r"\[(?:download|ExtractAudio|Merger)\] Destination:\s*" + re.escape(OUTPUT_DIR) + r"/(.+)"),
            "ytdlp_already": re.compile(r"\[download\]\s+" + re.escape(OUTPUT_DIR) + r"/(.+?)\s+has already been downloaded"),
            "ytdlp_item": re.compile(r"\[download\] Downloading (?:item|video)\s+(\d+)\s+of\s+(\d+)"),
            "whisper_prog": re.compile(r"(\d+)%"),
            "whisper_ts": re.compile(r"\[(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2})\.(\d{3})\]")
        }

    PRIORITY_MAP = {"low": 15, "below_normal": 10, "normal": 0, "above_normal": -5, "high": -10}

    @classmethod
    def priority_label_to_niceness(cls, label: str) -> int:
        return cls.PRIORITY_MAP.get((label or "below_normal").strip().lower(), 10)

    @staticmethod
    def parse_ffmpeg_threads(raw: str) -> int:
        raw = (raw or "Auto").strip()
        return int(raw) if raw.isdigit() and int(raw) > 0 else 0

    async def register_websocket(self, websocket: WebSocket):
        await websocket.accept()
        self.active_websockets.add(websocket)

    def unregister_websocket(self, websocket: WebSocket):
        self.active_websockets.discard(websocket)

    async def broadcast(self, message: dict):
        disconnected = set()
        for ws in self.active_websockets:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.add(ws)
        for ws in disconnected:
            self.active_websockets.discard(ws)

    async def start(self):
        for i in range(self.max_concurrent_jobs):
            task = asyncio.create_task(self._worker(i))
            self.workers.append(task)
        logger.info(f"JobManager gestartet ({self.max_concurrent_jobs} Workers).")

    @staticmethod
    def _sanitize_args(args: List[str]) -> List[str]:
        cleaned = []
        for a in args:
            if isinstance(a, str):
                a = a.strip()
                if a.lower().startswith(("http://", "https://")) or "://" in a:
                    a = re.sub(r"\s+", "", a)
            cleaned.append(a)
        return cleaned

    @staticmethod
    def _inject_cookies_if_needed(tool: str, args: List[str]) -> List[str]:
        """Hängt --cookies <pfad> an yt-dlp Kommandos an, falls eine Cookies-Datei hinterlegt
        wurde (per Upload über /api/config/cookies) UND der Aufruf noch keine eigenen
        --cookies/--cookies-from-browser Flags mitbringt (z.B. aus einem älteren Pipeline-Preset).
        Wird serverseitig injiziert statt im Frontend, damit es nicht vom UI-Code abhängt und
        nicht versehentlich vergessen werden kann - eine einzige Quelle der Wahrheit."""
        if tool != "yt-dlp":
            return args
        if not os.path.exists(COOKIES_FILE_PATH):
            return args
        if any(a in ("--cookies", "--cookies-from-browser") for a in args if isinstance(a, str)):
            return args  # Aufruf hat bereits eigene Cookie-Angabe - nicht überschreiben
        return [*args, "--cookies", COOKIES_FILE_PATH]

    @staticmethod
    def _extract_domain(url: Optional[str]) -> Optional[str]:
        if not url or "://" not in url:
            return None
        try:
            netloc = urllib.parse.urlparse(url).netloc.lower()
            return netloc[4:] if netloc.startswith("www.") else netloc
        except Exception:
            return None

    def _count_running_for_domain(self, domain: str) -> int:
        count = 0
        for j in self.jobs.values():
            if j.status == JobStatus.RUNNING and j.job_type == JobType.DOWNLOAD:
                if self._extract_domain(j.input_file) == domain:
                    count += 1
        return count

    def find_duplicate_pending_or_running(self, input_file: Optional[str], job_type,
                                           output_file: Optional[str] = None) -> Optional[str]:
        """Prüft, ob bereits ein Job mit derselben Quelle+Ziel (URL/Datei) und Typ läuft oder wartet.
        Gibt die Job-ID des Duplikats zurück, oder None."""
        if not input_file:
            return None
        for jid, j in self.jobs.items():
            if (j.status in (JobStatus.PENDING, JobStatus.RUNNING)
                    and j.job_type == job_type
                    and j.input_file == input_file
                    and (output_file is None or j.output_file == output_file)):
                return jid
        return None

    async def add_job(self, request: JobCreateRequest) -> Job:
        display_title = request.title
        clean_input_file = request.input_file.strip() if request.input_file else request.input_file
        
        if clean_input_file and clean_input_file.lower().startswith(("http://", "https://")):
            clean_input_file = re.sub(r"\s+", "", clean_input_file)
            if not display_title or "watch?v=" in display_title or display_title.startswith("http"):
                display_title = "Web Download"
        elif not display_title and clean_input_file:
            display_title = os.path.basename(clean_input_file)

        job = Job(
            job_type=request.job_type,
            tool=request.tool,
            title=display_title or request.job_type.value.upper(),
            command_args=self._inject_cookies_if_needed(request.tool, self._sanitize_args(request.command_args)),
            second_pass_args=self._sanitize_args(request.second_pass_args) if request.second_pass_args else None,
            input_file=clean_input_file,
            output_file=request.output_file,
            is_playlist=request.is_playlist,
            subscription_id=request.subscription_id
        )
        self.jobs[job.id] = job
        async with self.queue_lock:
            self.pending_queue.append(job.id)
        self.queue_event.set()
        await self.broadcast({"type": "job_created", "job": job.model_dump()})
        await self.broadcast_queue_order()
        return job

    async def retry_job(self, job_id: str) -> Optional[Job]:
        """Erstellt eine neue Job-Instanz mit identischen Parametern und stellt sie erneut in die Warteschlange."""
        old_job = self.jobs.get(job_id)
        if not old_job or old_job.status != JobStatus.FAILED:
            return None

        new_job = Job(
            job_type=old_job.job_type,
            tool=old_job.tool,
            title=old_job.title,
            command_args=self._inject_cookies_if_needed(old_job.tool, list(old_job.command_args)),
            second_pass_args=list(old_job.second_pass_args) if old_job.second_pass_args else None,
            input_file=old_job.input_file,
            output_file=old_job.output_file,
            is_playlist=old_job.is_playlist,
            subscription_id=old_job.subscription_id
        )
        self.jobs[new_job.id] = new_job
        async with self.queue_lock:
            self.pending_queue.append(new_job.id)
        self.queue_event.set()
        await self.broadcast({"type": "job_created", "job": new_job.model_dump()})
        await self.broadcast_queue_order()
        return new_job

    @staticmethod
    def _resolve_stage_args(args: List[str], input_path: str, output_path: str, tool: str = "") -> List[str]:
        output_noext = os.path.splitext(output_path)[0]
        resolved = []
        for a in args:
            if isinstance(a, str):
                # Falls yt-dlp genutzt wird und versehentlich {output} übergeben wurde,
                # erzwingen wir {output_noext}.%(ext)s, damit Stream-Merging nicht abstürzt
                if tool == "yt-dlp" and a == "{output}":
                    a = f"{output_noext}.%(ext)s"
                else:
                    a = a.replace("{input}", input_path).replace("{output_noext}", output_noext).replace("{output}", output_path)
            resolved.append(a)
        return resolved

    @staticmethod
    def _extract_clean_base_name(input_file: str) -> str:
        """Extrahiert einen sauberen Dateinamen/ID aus URLs oder lokalen Pfaden."""
        if not input_file:
            return "download"
        if input_file.lower().startswith(("http://", "https://")):
            # Versuch 1: YouTube Video-ID ermitteln (z.B. 1s6PPR_oCXU)
            yt_match = re.search(r"(?:v=|\/)([a-zA-Z0-9_-]{11})", input_file)
            if yt_match:
                return yt_match.group(1)
            # Fallback für andere URLs: Pfad-Name bereinigen
            parsed_path = urllib.parse.urlparse(input_file).path
            raw_base = os.path.basename(parsed_path) or "download"
            clean = re.sub(r'[^\w\-_]', '_', raw_base)
            return clean if clean and clean != "_" else "download"
        else:
            base = os.path.splitext(os.path.basename(input_file))[0]
            return re.sub(r'[^\w\-_]', '_', base) or "file"

    @staticmethod
    def _build_stage_output_path(base_name: str, stage: "PipelineStage", stage_index: int, run_id: str) -> str:
        """Erzeugt einen eindeutigen Output-Pfad ohne Dateinamen-Verkettung (_stage1_..._stage2_...)."""
        output_dir = os.getenv("OUTPUT_DIR", "/media/outputs")
        ext = stage.output_ext if stage.output_ext.startswith(".") else f".{stage.output_ext}" if stage.output_ext else ".out"
        filename = f"{base_name}_stage{stage_index + 1}_{run_id}{ext}"
        return os.path.join(output_dir, filename)

    async def start_pipeline_run(self, pipeline: "Pipeline", input_file: str, title: Optional[str] = None, keep_only_final_output: bool = False) -> List[Job]:
        """Startet eine Pipeline: legt nur den Job für Stufe 1 an."""
        run_id = uuid.uuid4().hex[:8]
        
        # Falls ein echter Titel übergeben wurde, nutzen wir diesen als Dateinamen-Basis
        if title and title != "-" and not title.lower().startswith(("http://", "https://")):
            clean_base = re.sub(r'[^\w\-_]', '_', title)
        else:
            clean_base = self._extract_clean_base_name(input_file)

        display_title = title if (title and title != "-") else clean_base

        self.pipeline_runs[run_id] = {
            "pipeline": pipeline,
            "stage_index": 0,
            "title": display_title,
            "base_name": clean_base,
            "original_input": input_file,
            "keep_only_final_output": keep_only_final_output,
            "produced_files": [],
        }

        first_job = await self._enqueue_pipeline_stage(run_id, input_file)
        return [first_job] if first_job else []

    async def _enqueue_pipeline_stage(self, run_id: str, stage_input_file: str) -> Optional[Job]:
        """Legt den Job für die aktuelle Stufe des gegebenen Pipeline-Runs an und queued ihn."""
        run = self.pipeline_runs.get(run_id)
        if not run:
            return None
        pipeline: Pipeline = run["pipeline"]
        stage_index: int = run["stage_index"]
        if stage_index >= len(pipeline.stages):
            self.pipeline_runs.pop(run_id, None)
            return None

        stage: PipelineStage = pipeline.stages[stage_index]
        base_name = run.get("base_name") or self._extract_clean_base_name(stage_input_file)

        if stage.tool == "whisper":
            output_dir = os.getenv("OUTPUT_DIR", "/media/outputs")
            input_base = os.path.splitext(os.path.basename(stage_input_file))[0]
            ext = stage.output_ext if stage.output_ext.startswith(".") else f".{stage.output_ext}" if stage.output_ext else ".srt"
            output_path = os.path.join(output_dir, f"{input_base}{ext}")
        else:
            output_path = self._build_stage_output_path(base_name, stage, stage_index, run_id)

        resolved_args = self._resolve_stage_args(stage.command_args, stage_input_file, output_path, tool=stage.tool)

        # 1. FIX: YT-DLP in Pipelines zwingen, immer nur das einzelne Video (keine Playlists) zu laden
        if stage.tool == "yt-dlp" and "--no-playlist" not in resolved_args:
            resolved_args.append("--no-playlist")

        # 2. FIX: Fallback für Geschwindigkeits-Filter, wenn die Datei nur Audio ist
        ext = os.path.splitext(stage_input_file)[1].lower()
        if ext in ['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac'] and "-filter_complex" in resolved_args:
            try:
                fc_idx = resolved_args.index("-filter_complex")
                filter_str = resolved_args[fc_idx + 1]
                
                # Prüfen, ob der kombinierte Filter (wie im Screenshot) genutzt wird
                if "[0:v]" in filter_str and "[0:a]" in filter_str and "atempo" in filter_str:
                    a_match = re.search(r'\[0:a\](.*?)\[a\]', filter_str)
                    if a_match:
                        # Überschreibe den Befehl zu einem reinen Audio-Filter
                        resolved_args[fc_idx] = "-filter:a"
                        resolved_args[fc_idx + 1] = a_match.group(1)
                        
                        # Entferne "-map [v]" und "-map [a]" aus den Argumenten
                        clean_args = []
                        i = 0
                        while i < len(resolved_args):
                            if resolved_args[i] == "-map" and i + 1 < len(resolved_args) and resolved_args[i+1] in ["[v]", "[a]"]:
                                i += 2
                            else:
                                clean_args.append(resolved_args[i])
                                i += 1
                        resolved_args = clean_args
            except Exception:
                pass

        resolved_second_pass = (
            self._resolve_stage_args(stage.second_pass_args, stage_input_file, output_path, tool=stage.tool)
            if stage.second_pass_args else None
        )

        stage_label = stage.label or f"{pipeline.name} – Stufe {stage_index + 1}/{len(pipeline.stages)}"

        job = Job(
            job_type=stage.job_type,
            tool=stage.tool,
            title=f"{run['title']} [{stage_label}]",
            command_args=self._inject_cookies_if_needed(stage.tool, self._sanitize_args(resolved_args)),
            second_pass_args=self._sanitize_args(resolved_second_pass) if resolved_second_pass else None,
            input_file=stage_input_file,
            output_file=output_path,
            pipeline_run_id=run_id,
            pipeline_stage_index=stage_index,
            pipeline_stage_count=len(pipeline.stages),
        )
        self.jobs[job.id] = job
        run["current_job_id"] = job.id
        async with self.queue_lock:
            self.pending_queue.append(job.id)
        self.queue_event.set()
        await self.broadcast({"type": "job_created", "job": job.model_dump()})
        await self.broadcast_queue_order()
        return job

    async def _advance_pipeline_after_job(self, job: Job):
        """Wird nach Abschluss (Erfolg oder endgültiger Misserfolg) eines Pipeline-Jobs aufgerufen.
        Bei Erfolg: nächste Stufe mit der Ausgabedatei dieser Stufe als Eingabe starten.
        Bei Misserfolg: restliche Pipeline abbrechen (sicherer Default, keine Teil-Pipelines mit Lücken)."""
        run_id = job.pipeline_run_id
        if not run_id:
            return
        run = self.pipeline_runs.get(run_id)
        if not run:
            return

        if job.status == JobStatus.COMPLETED:
            next_input = job.output_file
            if job.output_file and job.output_file not in run.get("produced_files", []):
                run.setdefault("produced_files", []).append(job.output_file)

            run["stage_index"] += 1
            is_last_stage = run["stage_index"] >= len(run["pipeline"].stages)

            if is_last_stage:
                done_msg = f"[SYSTEM] Pipeline '{run['pipeline'].name}' vollständig abgeschlossen."
                if not next_input or not os.path.exists(next_input):
                    done_msg += " (Hinweis: Ausgabedatei der letzten Stufe konnte nicht verifiziert werden.)"
                
                # Falls Option 'Nur Endergebnis behalten' aktiviert ist, Zwischenschritte löschen:
                if run.get("keep_only_final_output"):
                    final_file = os.path.abspath(job.output_file) if job.output_file else None
                    deleted_count = 0
                    for temp_file in run.get("produced_files", []):
                        if temp_file and os.path.exists(temp_file):
                            if final_file and os.path.abspath(temp_file) == final_file:
                                continue  # Finale Datei niemals löschen!
                            try:
                                os.remove(temp_file)
                                deleted_count += 1
                            except Exception as e:
                                logger.warning(f"Konnte Zwischendatei {temp_file} nicht löschen: {e}")
                    if deleted_count > 0:
                        cleanup_msg = f"[SYSTEM] Option 'Nur Endergebnis behalten' aktiv: {deleted_count} Zwischenschritt-Datei(en) aufgeräumt."
                        job.logs.append(cleanup_msg)
                        await self.broadcast({"type": "log", "job_id": job.id, "line": cleanup_msg})

                job.logs.append(done_msg)
                await self.broadcast({"type": "log", "job_id": job.id, "line": done_msg})
                self.pipeline_runs.pop(run_id, None)
                return

            if not next_input or not os.path.exists(next_input):
                fail_msg = f"[SYSTEM] Pipeline abgebrochen: Ausgabedatei der Stufe {job.pipeline_stage_index + 1} wurde nicht gefunden."
                job.logs.append(fail_msg)
                await self.broadcast({"type": "log", "job_id": job.id, "line": fail_msg})
                self.pipeline_runs.pop(run_id, None)
                return

            await self._enqueue_pipeline_stage(run_id, next_input)
        else:
            # FAILED oder CANCELLED: restliche Stufen nicht mehr starten (sicherer Default).
            abort_msg = (f"[SYSTEM] Pipeline '{run['pipeline'].name}' abgebrochen: "
                         f"Stufe {job.pipeline_stage_index + 1}/{job.pipeline_stage_count} ist fehlgeschlagen.")
            job.logs.append(abort_msg)
            await self.broadcast({"type": "log", "job_id": job.id, "line": abort_msg})
            self.pipeline_runs.pop(run_id, None)

    async def reorder_queue(self, ordered_job_ids: List[str]) -> bool:
        """Setzt die Reihenfolge der wartenden Jobs neu, basierend auf einer vom Client übergebenen Liste."""
        async with self.queue_lock:
            current_set = set(self.pending_queue)
            requested = [jid for jid in ordered_job_ids if jid in current_set]
            # append any pending ids the client didn't include, to avoid silently dropping jobs
            missing = [jid for jid in self.pending_queue if jid not in requested]
            self.pending_queue = requested + missing
        await self.broadcast_queue_order()
        return True

    async def broadcast_queue_order(self):
        async with self.queue_lock:
            order = list(self.pending_queue)
        await self.broadcast({"type": "queue_reordered", "order": order})

    def get_job(self, job_id: str) -> Optional[Job]:
        return self.jobs.get(job_id)

    def get_all_jobs(self) -> List[Job]:
        return list(self.jobs.values())

    def get_all_jobs_ordered(self) -> List[Job]:
        """
        Wie get_all_jobs, aber pending Jobs werden in der tatsächlichen (ggf. manuell
        umsortierten) Warteschlangen-Reihenfolge zurückgegeben, damit die UI die
        Drag-and-Drop-Reihenfolge korrekt widerspiegelt.
        """
        pending_ids = list(self.pending_queue)
        pending_set = set(pending_ids)
        ordered_pending = [self.jobs[jid] for jid in pending_ids if jid in self.jobs]
        others = [j for jid, j in self.jobs.items() if jid not in pending_set]
        return ordered_pending + others

    def clear_completed_jobs(self):
        to_delete = [jid for jid, j in self.jobs.items() if j.status in [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED]]
        for jid in to_delete:
            del self.jobs[jid]

    async def cancel_job(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False

        if job.status == JobStatus.RUNNING and job_id in self.running_processes:
            proc = self.running_processes[job_id]
            try:
                proc.kill()
            except Exception:
                pass
            job.status = JobStatus.CANCELLED
            job.logs.append("[SYSTEM] Job abgebrochen.")
            await self.broadcast({"type": "job_updated", "job": job.model_dump()})
            if job.pipeline_run_id:
                self.pipeline_runs.pop(job.pipeline_run_id, None)
            return True
        elif job.status == JobStatus.PENDING:
            job.status = JobStatus.CANCELLED
            async with self.queue_lock:
                if job_id in self.pending_queue:
                    self.pending_queue.remove(job_id)
            await self.broadcast({"type": "job_updated", "job": job.model_dump()})
            await self.broadcast_queue_order()
            if job.pipeline_run_id:
                self.pipeline_runs.pop(job.pipeline_run_id, None)
            return True
        return False

    async def cancel_all_jobs(self) -> int:
        cancelled_count = 0
        job_ids = list(self.jobs.keys())
        for jid in job_ids:
            job = self.jobs.get(jid)
            if job and job.status in [JobStatus.RUNNING, JobStatus.PENDING]:
                if await self.cancel_job(jid):
                    cancelled_count += 1
        return cancelled_count

    def _send_pushover(self, title: str, message: str):
        enabled = os.getenv("PUSHOVER_ENABLED", "false").lower() == "true"
        user_key = os.getenv("PUSHOVER_USER_KEY", "").strip()
        token = os.getenv("PUSHOVER_TOKEN", "").strip()

        if not enabled or not user_key or not token:
            return

        try:
            data = urllib.parse.urlencode({
                "token": token,
                "user": user_key,
                "title": title,
                "message": message
            }).encode("utf-8")
            req = urllib.request.Request("https://api.pushover.net/1/messages.json", data=data)
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            logger.warning(f"Pushover Benachrichtigung fehlgeschlagen: {e}")

    async def _pop_next_job_id(self) -> Optional[str]:
        """
        Nimmt den nächsten startbereiten Job vom Kopf der Warteschlange. Download-Jobs,
        deren Quell-Domain das Concurrent-Limit (max_concurrent_per_domain) bereits erreicht
        hat, werden übersprungen (nicht entfernt!) und bleiben in der Reihenfolge stehen –
        so blockiert z.B. eine überlastete YouTube-Domain nicht die gesamte Warteschlange,
        andere Downloads/Konvertierungen können vorgezogen werden.
        """
        async with self.queue_lock:
            if not self.pending_queue:
                return None
            for idx, jid in enumerate(self.pending_queue):
                job = self.jobs.get(jid)
                if not job:
                    return self.pending_queue.pop(idx)  # orphaned id, drop it

                if job.job_type == JobType.DOWNLOAD and self.max_concurrent_per_domain > 0:
                    domain = self._extract_domain(job.input_file)
                    if domain and self._count_running_for_domain(domain) >= self.max_concurrent_per_domain:
                        continue  # skip, try next queued job instead

                if job.job_type == JobType.WHISPER and self.max_concurrent_whisper_jobs > 0:
                    running_whisper = sum(1 for j in self.jobs.values()
                                           if j.status == JobStatus.RUNNING and j.job_type == JobType.WHISPER)
                    if running_whisper >= self.max_concurrent_whisper_jobs:
                        continue  # skip, avoid RAM/CPU overload from parallel Whisper models

                return self.pending_queue.pop(idx)
        return None

    async def _worker(self, worker_id: int):
        while True:
            job_id = await self._pop_next_job_id()
            if job_id is None:
                # Wait until at least one job is queued. Re-check the queue after waking,
                # since multiple workers share this event and another worker may have
                # already taken the job that caused the wakeup. Also covers the case where
                # every pending job is currently domain-rate-limited: a short poll interval
                # avoids workers sleeping forever while a domain slot is about to free up.
                try:
                    await asyncio.wait_for(self.queue_event.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    pass
                async with self.queue_lock:
                    if not self.pending_queue:
                        self.queue_event.clear()
                continue

            job = self.jobs.get(job_id)
            if not job or job.status == JobStatus.CANCELLED:
                continue

            job.status = JobStatus.RUNNING
            await self.broadcast({"type": "job_updated", "job": job.model_dump()})
            await self.broadcast_queue_order()
            await self._execute_job_pipeline(job)

    async def _execute_job_pipeline(self, job: Job):
        input_size_mb = 0.0
        if job.input_file and job.job_type != JobType.DOWNLOAD and os.path.exists(job.input_file):
            try:
                input_size_mb = round(os.path.getsize(job.input_file) / (1024 * 1024), 2)
            except Exception:
                pass

        if job.input_file and job.job_type != JobType.DOWNLOAD:
            target_probe = job.input_file
            if not os.path.exists(target_probe):
                candidate_in = os.path.join(os.getenv("INPUT_DIR", "/media/inputs"), os.path.basename(job.input_file))
                candidate_out = os.path.join(os.getenv("OUTPUT_DIR", "/media/outputs"), os.path.basename(job.input_file))
                if os.path.exists(candidate_in):
                    target_probe = candidate_in
                elif os.path.exists(candidate_out):
                    target_probe = candidate_out

            if os.path.exists(target_probe):
                try:
                    cmd_dur = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", target_probe]
                    p_dur = await asyncio.create_subprocess_exec(*cmd_dur, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                    out_dur, _ = await p_dur.communicate()
                    if out_dur:
                        val = out_dur.decode().strip()
                        if val and val != "N/A":
                            job.total_duration_sec = float(val)
                except Exception as e:
                    logger.debug(f"Pre-probe duration failed: {e}")

        success = await self._run_subprocess(job, job.tool, job.command_args, "Pass 1")

        if success and job.second_pass_args and job.status != JobStatus.CANCELLED:
            job.logs.append("[SYSTEM] Starte Pass 2...")
            await self.broadcast({"type": "job_progress", "job_id": job.id, "progress": 50.0, "eta": "Pass 2", "log_line": "[SYSTEM] Pass 1 fertig. Starte Pass 2..."})
            success = await self._run_subprocess(job, job.tool, job.second_pass_args, "Pass 2")

        size_mb = 0.0
        duration_sec = job.total_duration_sec
        ext = ""

        resolved_output = job.output_file
        if not resolved_output and job.tool == "yt-dlp" and job.title:
            output_dir = os.getenv("OUTPUT_DIR", "/media/outputs")
            if os.path.isdir(output_dir):
                for root, _, filenames in os.walk(output_dir):
                    match = next((fn for fn in filenames if os.path.splitext(fn)[0] == job.title), None)
                    if match:
                        resolved_output = os.path.join(root, match)
                        break

        if success and resolved_output and os.path.exists(resolved_output):
            size_mb = round(os.path.getsize(resolved_output) / (1024 * 1024), 2)
            ext = os.path.splitext(resolved_output)[1]

        if success and job.status != JobStatus.CANCELLED:
            job.status = JobStatus.COMPLETED
            job.progress = 100.0
            job.eta = "Fertig"

            record_job(job.id, job.title, job.job_type.value, "completed",
                       size_mb=size_mb, duration_sec=duration_sec, ext=ext,
                       tool=job.tool, input_size_mb=input_size_mb,
                       is_playlist=job.is_playlist)

            banner = f"\n============================================================\n[SUCCESS] Job {job.id} ({job.title}) ERFOLGREICH!\n============================================================\n"
            job.logs.append(banner)
            await self.broadcast({"type": "log", "job_id": job.id, "line": banner})

            if (self.auto_delete_originals
                    and job.job_type != JobType.DOWNLOAD
                    and job.input_file
                    and not job.input_file.lower().startswith(("http://", "https://"))
                    and resolved_output
                    and os.path.abspath(job.input_file) != os.path.abspath(resolved_output)
                    and os.path.exists(job.input_file)):
                try:
                    os.remove(job.input_file)
                    del_msg = f"[SYSTEM] AUTO_DELETE_ORIGINALS aktiv: Quelldatei '{job.input_file}' wurde gelöscht."
                    self._append_log(job, del_msg)
                    await self.broadcast({"type": "log", "job_id": job.id, "line": del_msg})
                except Exception as e:
                    logger.warning(f"AUTO_DELETE_ORIGINALS: Löschen von {job.input_file} fehlgeschlagen: {e}")

            await asyncio.to_thread(self._send_pushover, "Media Converter Pro", f"✅ Job '{job.title}' erfolgreich abgeschlossen!")

        elif job.status != JobStatus.CANCELLED:
            hint = self._diagnose_failure(job)
            is_transient = self._is_transient_failure(job)

            if is_transient and job.retry_count < self.max_auto_retries:
                job.retry_count += 1
                backoff_sec = min(30, 2 ** job.retry_count)  # 2s, 4s, 8s... capped at 30s
                retry_msg = (f"\n[SYSTEM] Job {job.id} fehlgeschlagen (vermutlich vorübergehend). "
                             f"Automatischer Neuversuch {job.retry_count}/{self.max_auto_retries} in {backoff_sec}s...\n")
                job.logs.append(retry_msg)
                await self.broadcast({"type": "log", "job_id": job.id, "line": retry_msg})

                await asyncio.sleep(backoff_sec)

                job.status = JobStatus.PENDING
                job.progress = 0.0
                job.eta = f"Wartet (Neuversuch {job.retry_count}/{self.max_auto_retries})..."
                job.is_auto_retry = True
                async with self.queue_lock:
                    self.pending_queue.append(job.id)
                self.queue_event.set()
                await self.broadcast({"type": "job_updated", "job": job.model_dump()})
                await self.broadcast_queue_order()
                return

            job.status = JobStatus.FAILED
            record_job(job.id, job.title, job.job_type.value, "failed", tool=job.tool, is_playlist=job.is_playlist)

            job.error_message = job.error_message or hint

            banner = f"\n============================================================\n[FAILED] Job {job.id} ({job.title}) FEHLGESCHLAGEN!\n"
            if job.retry_count > 0:
                banner += f"[INFO] {job.retry_count} automatische(r) Neuversuch(e) ohne Erfolg.\n"
            if hint:
                banner += f"[HINWEIS] {hint}\n"
            banner += "============================================================\n"
            job.logs.append(banner)
            await self.broadcast({"type": "log", "job_id": job.id, "line": banner})

        await self.broadcast({"type": "job_updated", "job": job.model_dump()})

        if job.status in (JobStatus.COMPLETED, JobStatus.FAILED) and job.pipeline_run_id:
            await self._advance_pipeline_after_job(job)

    @staticmethod
    def _is_transient_failure(job: Job) -> bool:
        """
        Entscheidet, ob ein Fehler wahrscheinlich vorübergehend ist (Netzwerk-Hänger, Rate-Limit,
        Server-Timeout) und daher automatisch wiederholt werden sollte. Bewusst konservativ:
        Speicherplatz, Rechte, oder nicht unterstützte Codecs werden NIE automatisch wiederholt,
        da ein Neuversuch dort garantiert wieder fehlschlägt.
        """
        if job.status == JobStatus.CANCELLED:
            return False
        recent = "\n".join(job.logs[-30:]).lower()
        transient_markers = [
            "timed out", "timeout", "connection reset", "temporary failure",
            "http error 429", "http error 500", "http error 502", "http error 503",
            "network is unreachable", "could not connect", "read timed out",
            "unable to download webpage",
        ]
        permanent_markers = [
            "no space left", "permission denied", "no such file or directory",
            "unsupported", "invalid data found", "http error 403", "http error 404",
        ]
        if any(m in recent for m in permanent_markers):
            return False
        return any(m in recent for m in transient_markers)

    @staticmethod
    def _diagnose_failure(job: Job) -> str:
        """Durchsucht die letzten Log-Zeilen nach bekannten Fehlermustern für eine klare Nutzer-Meldung."""
        recent = "\n".join(job.logs[-30:]).lower()
        if "ist auf dem server nicht installiert" in recent:
            return f"Das Werkzeug '{job.tool}' ist auf dem Server nicht installiert."
        if "no space left" in recent:
            return "Kein Speicherplatz mehr frei auf der Festplatte. Lösche Dateien in der Library."
        if "permission denied" in recent:
            return "Zugriff verweigert. Prüfe Datei-/Ordnerrechte im Container."
        if "no such file or directory" in recent:
            return "Eingabedatei wurde nicht gefunden. Wurde sie zwischenzeitlich verschoben oder gelöscht?"
        if "unable to download" in recent or "http error 403" in recent:
            return "Download fehlgeschlagen (Server/Netzwerk-Fehler oder Zugriff verweigert). Prüfe die URL."
        if "unsupported" in recent and "codec" in recent:
            return "Nicht unterstützter Codec für diese Operation."
        return ""

    MAX_LOG_LINES = 2000  # caps per-job RAM usage; oldest lines drop first, ffmpeg/yt-dlp output can be very verbose

    @classmethod
    def _append_log(cls, job: Job, line: str):
        job.logs.append(line)
        if len(job.logs) > cls.MAX_LOG_LINES:
            overflow = len(job.logs) - cls.MAX_LOG_LINES
            del job.logs[:overflow]
            if not job.logs or not job.logs[0].startswith("[SYSTEM] ... ältere Log-Zeilen"):
                job.logs.insert(0, "[SYSTEM] ... ältere Log-Zeilen wurden entfernt (Limit erreicht) ...")

    async def _run_subprocess(self, job: Job, tool: str, args: List[str], label: str) -> bool:
        # Säubere Argumente: Entferne ALLE versehentlich führenden Tool-Namen aus den Argumenten
        clean_args = list(args)
        while clean_args and clean_args[0] == tool:
            clean_args.pop(0)

        # Autokorrektur für FFmpeg: Wenn ein filter_complex mit [0:v] auf eine reine Audiodatei angewendet wird
        if tool == "ffmpeg" and job.input_file:
            ext = os.path.splitext(job.input_file)[1].lower()
            if ext in ['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.opus', '.wma'] and "-filter_complex" in clean_args:
                try:
                    fc_idx = clean_args.index("-filter_complex")
                    filter_str = clean_args[fc_idx + 1]
                    if "[0:v]" in filter_str and "atempo" in filter_str:
                        a_match = re.search(r'\[0:a\](.*?)\[a\]', filter_str)
                        filter_expr = a_match.group(1) if a_match else "atempo=1.0"
                        clean_args[fc_idx] = "-filter:a"
                        clean_args[fc_idx + 1] = filter_expr
                        
                        # Entferne -map [v] und -map [a]
                        new_clean = []
                        i = 0
                        while i < len(clean_args):
                            if clean_args[i] == "-map" and i + 1 < len(clean_args) and clean_args[i+1] in ["[v]", "[a]"]:
                                i += 2
                            else:
                                new_clean.append(clean_args[i])
                                i += 1
                        clean_args = new_clean
                except Exception:
                    pass

        cmd = [tool] + clean_args
        if tool == "ffmpeg" and self.ffmpeg_threads > 0 and "-threads" not in clean_args:
            # insert right after the binary name so it applies as a global ffmpeg option
            cmd = [tool, "-threads", str(self.ffmpeg_threads)] + clean_args

        start_msg = f"[{label}] Ausführen: {' '.join(cmd)}"
        self._append_log(job, start_msg)
        await self.broadcast({"type": "log", "job_id": job.id, "line": start_msg})

        def _apply_niceness():
            # Runs in the forked child before exec; lowers CPU scheduling priority so
            # heavy transcodes don't starve the web server / other containers on the host.
            try:
                os.nice(self.process_niceness)
            except Exception:
                pass

        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                preexec_fn=_apply_niceness if os.name == "posix" else None
            )
            self.running_processes[job.id] = process

            buffer = b""
            while True:
                chunk = await process.stdout.read(256)
                if not chunk:
                    break
                buffer += chunk

                while b"\r" in buffer or b"\n" in buffer:
                    pos_r = buffer.find(b"\r")
                    pos_n = buffer.find(b"\n")
                    pos = pos_r if pos_r != -1 and (pos_n == -1 or pos_r < pos_n) else pos_n

                    line_bytes = buffer[:pos]
                    buffer = buffer[pos + 1:]

                    line = line_bytes.decode('utf-8', errors='replace').strip()
                    if line:
                        self._append_log(job, line)
                        try:
                            await self._parse_progress(job, line)
                        except Exception as pe:
                            logger.debug(f"Progress parse error: {pe}")
                        await self.broadcast({
                            "type": "job_progress",
                            "job_id": job.id,
                            "progress": job.progress,
                            "eta": job.eta,
                            "log_line": line
                        })

            if buffer:
                line = buffer.decode('utf-8', errors='replace').strip()
                if line:
                    self._append_log(job, line)

            await process.wait()
            return process.returncode == 0
        except FileNotFoundError:
            err_msg = f"[ERROR] Das Werkzeug '{tool}' ist auf dem Server nicht installiert oder wurde nicht im PATH gefunden."
            job.error_message = err_msg
            self._append_log(job, err_msg)
            return False
        except Exception as e:
            job.error_message = str(e)
            self._append_log(job, f"[ERROR] {str(e)}")
            return False
        finally:
            self.running_processes.pop(job.id, None)

    async def _parse_progress(self, job: Job, line: str):
        if job.tool == "ffmpeg":
            if job.total_duration_sec == 0.0:
                dur_match = self.regex["ffmpeg_duration"].search(line)
                if dur_match:
                    h, m, s = int(dur_match.group(1)), int(dur_match.group(2)), int(dur_match.group(3))
                    job.total_duration_sec = float(h * 3600 + m * 60 + s)

            time_match = self.regex["ffmpeg_time"].search(line)
            if time_match:
                h, m, s, _ = time_match.groups()
                current_sec = int(h) * 3600 + int(m) * 60 + int(s)

                speed_match = self.regex["ffmpeg_speed"].search(line)
                speed_str = f" ({speed_match.group(1)}x)" if speed_match else ""

                if job.total_duration_sec > 0:
                    job.progress = min(99.9, round((current_sec / job.total_duration_sec) * 100, 1))
                    total_h = int(job.total_duration_sec // 3600)
                    total_m = int((job.total_duration_sec % 3600) // 60)
                    total_s = int(job.total_duration_sec % 60)
                    job.eta = f"{job.progress:.1f}% ({h}:{m}:{s} / {total_h:02d}:{total_m:02d}:{total_s:02d}){speed_str}"
                else:
                    job.eta = f"Verarbeite ({h}:{m}:{s}){speed_str}"

        elif job.tool == "yt-dlp":
            item_match = self.regex["ytdlp_item"].search(line)
            if item_match:
                job.playlist_index = int(item_match.group(1))
                job.playlist_count = int(item_match.group(2))
                job.is_playlist = True
                await self.broadcast({"type": "job_updated", "job": job.model_dump()})

            dest_match = self.regex["ytdlp_dest"].search(line) or self.regex["ytdlp_already"].search(line)
            if dest_match:
                raw_filename = os.path.basename(dest_match.group(1).split('.f')[0])
                clean_name = os.path.splitext(raw_filename)[0]
                if clean_name:
                    job.current_item_title = clean_name
                    if not job.is_playlist and (job.title in ["DOWNLOAD", "Web Download"] or "watch?v=" in job.title or "http" in job.title):
                        job.title = clean_name
                    await self.broadcast({"type": "job_updated", "job": job.model_dump()})

            prog_match = self.regex["ytdlp_prog"].search(line)
            if prog_match:
                job.progress = float(prog_match.group(1))

            eta_match = self.regex["ytdlp_eta"].search(line)
            speed_match = self.regex["ytdlp_speed"].search(line)

            eta_str = f"ETA {eta_match.group(1)}" if eta_match else ""
            speed_str = speed_match.group(1) if speed_match else ""

            parts = []
            if job.is_playlist and job.playlist_index and job.playlist_count:
                parts.append(f"Titel {job.playlist_index}/{job.playlist_count}")
                if job.current_item_title:
                    parts.append(f"({job.current_item_title})")
            elif job.current_item_title:
                parts.append(job.current_item_title)

            if speed_str:
                parts.append(f"[{speed_str}]")
            if eta_str:
                parts.append(eta_str)

            if parts:
                job.eta = " ".join(parts)

        elif job.tool == "whisper":
            prog_match = self.regex["whisper_prog"].search(line)
            ts_match = self.regex["whisper_ts"].search(line)

            if prog_match:
                val = float(prog_match.group(1))
                job.progress = val
                if val >= 100:
                    job.eta = "Erstelle Untertitel-Dateien..."
                else:
                    job.eta = f"Transkribiere... ({int(val)}%)"
            elif ts_match and job.progress >= 99.0:
                start_m, start_s = ts_match.group(1), ts_match.group(2)
                end_m, end_s = ts_match.group(4), ts_match.group(5)
                job.eta = f"Schreibe Segment: {start_m}:{start_s} ➔ {end_m}:{end_s}"

job_manager = JobManager()
