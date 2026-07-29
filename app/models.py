import uuid
from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field
from datetime import datetime

class JobType(str, Enum):
    DOWNLOAD = "download"
    VIDEO = "video"
    AUDIO = "audio"
    IMAGE = "image"
    MUX = "mux"
    WHISPER = "whisper"
    SPEED = "speed"
    VOLUME = "volume"
    THUMBNAIL = "thumbnail"

class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class Job(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    job_type: JobType
    tool: str
    title: str
    command_args: List[str]
    second_pass_args: Optional[List[str]] = None
    input_file: Optional[str] = None
    output_file: Optional[str] = None
    status: JobStatus = JobStatus.PENDING
    progress: float = 0.0
    eta: str = "Wartet..."
    logs: List[str] = Field(default_factory=list)
    error_message: Optional[str] = None
    is_playlist: bool = False
    playlist_index: Optional[int] = None
    playlist_count: Optional[int] = None
    current_item_title: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    total_duration_sec: float = 0.0
    retry_count: int = 0
    is_auto_retry: bool = False
    pipeline_run_id: Optional[str] = None
    pipeline_stage_index: Optional[int] = None
    pipeline_stage_count: Optional[int] = None
    subscription_id: Optional[str] = None  # gesetzt, wenn dieser Job von einem Kanal-Abonnement automatisch angelegt wurde

class JobCreateRequest(BaseModel):
    job_type: JobType
    tool: str = "ffmpeg"
    title: Optional[str] = None
    command_args: List[str]
    second_pass_args: Optional[List[str]] = None
    input_file: Optional[str] = None
    output_file: Optional[str] = None
    is_playlist: bool = False
    subscription_id: Optional[str] = None

class PipelineStage(BaseModel):
    """Eine einzelne Stufe innerhalb einer Pipeline. Referenziert denselben Job-Typ/Tool
    wie ein normaler Job; command_args nutzen Platzhalter, die zur Laufzeit aufgelöst werden:
    {input} = Ausgabedatei der vorherigen Stufe (bzw. URL/Ausgangsdatei bei Stufe 1),
    {output} = generierter Ausgabepfad dieser Stufe."""
    job_type: JobType
    tool: str = "ffmpeg"
    label: str = ""
    command_args: List[str] = Field(default_factory=list)
    second_pass_args: Optional[List[str]] = None
    output_ext: str = ""  # z.B. ".mp4", ".srt" - bestimmt den Dateinamen der Stufe
    ui_settings: Optional[dict] = None  # Friendly-Editor-Zustand (Format, Bitrate, Modell, ...).
                                         # Wird von der Job-Ausführung ignoriert, dient nur dazu,
                                         # den Editor beim erneuten Bearbeiten korrekt zu befüllen.

class Pipeline(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    name: str
    description: str = ""
    stages: List[PipelineStage] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())

class PipelineRunRequest(BaseModel):
    pipeline_id: str
    input_file: str
    title: Optional[str] = None
    keep_only_final_output: bool = False

class Subscription(BaseModel):
    """Ein abonnierter Kanal/Playlist, der periodisch auf neue Videos geprüft wird.
    Nutzt yt-dlp's eingebautes --download-archive gegen eine pro-Subscription eigene
    Archiv-Datei, um bereits heruntergeladene Videos nicht erneut zu laden - kein eigenes
    Diffing nötig, das übernimmt yt-dlp bereits zuverlässig."""
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    name: str  # Anzeigename, z.B. Kanalname - wird auch als Unterordner-Name verwendet (sanitisiert)
    url: str  # Kanal- oder Playlist-URL
    enabled: bool = True
    check_interval_minutes: int = 360  # Standard: alle 6 Stunden prüfen
    download_type: str = "video"  # "video" oder "audio" - wie bei normalen Downloads
    quality: str = "best"  # Auflösung (video) bzw. Audioqualität, wie im Download-Tab
    container: str = "mp4"  # Ziel-Container (mp4/mkv für Video, mp3/m4a/flac für Audio)
    max_items_per_check: int = 25  # Sicherheitslimit: max. neue Videos pro Check-Lauf
    backfill_count: int = 0  # Beim Anlegen: zusätzlich die letzten N bestehenden Videos herunterladen (0 = nur ab jetzt neue)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    last_checked_at: Optional[str] = None
    last_check_status: Optional[str] = None  # "ok" | "error" | None (noch nie geprüft)
    last_check_error: Optional[str] = None
    last_check_new_count: int = 0
    total_downloaded: int = 0

class SubscriptionCreateRequest(BaseModel):
    name: str
    url: str
    check_interval_minutes: int = 360
    download_type: str = "video"
    quality: str = "best"
    container: str = "mp4"
    max_items_per_check: int = 25
    backfill_count: int = 0
    enabled: bool = True

class MediaTagsUpdateRequest(BaseModel):
    file_path: str
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    date: Optional[str] = None
    genre: Optional[str] = None
    comment: Optional[str] = None

class AppConfig(BaseModel):
    max_concurrent_jobs: int = 2
    pushover_enabled: bool = False
    pushover_user_key: str = ""
    pushover_token: str = ""
    auto_cleanup_days: int = 0
    default_vcodec: str = "libx264"
    default_crf: int = 23
    default_aformat: str = "mp3"
    default_whisper_model: str = "base"
    # Safety / reliability settings
    min_free_disk_gb: float = 2.0
    prevent_output_overwrite: bool = True
    confirm_full_playlist_downloads: bool = True
    max_concurrent_per_domain: int = 2
    max_concurrent_whisper_jobs: int = 1
    auto_delete_originals: bool = False
    ffmpeg_threads: str = "Auto"  # "Auto" or a positive integer as string
    process_priority: str = "below_normal"  # low | below_normal | normal | above_normal | high
