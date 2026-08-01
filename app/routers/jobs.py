"""Job-CRUD-Routen: Erstellen, Auflisten, Abbrechen, Wiederholen und Umsortieren der Warteschlange."""
import os
from fastapi import APIRouter, HTTPException, Body, Query

from app.job_manager import job_manager, DangerousArgError
from app.models import Job, JobCreateRequest
from app.core import OUTPUT_DIR, get_free_disk_gb

router = APIRouter()


@router.post("/api/jobs", response_model=Job)
async def create_job(request: JobCreateRequest, force: bool = Query(False)):
    min_free_gb = getattr(job_manager, "min_free_disk_gb", 2.0)
    if min_free_gb > 0:
        free_gb = get_free_disk_gb(OUTPUT_DIR)
        if free_gb < min_free_gb:
            raise HTTPException(
                status_code=507,
                detail=f"Zu wenig freier Speicherplatz auf /media/outputs ({free_gb:.2f} GB frei, "
                       f"Minimum {min_free_gb:.1f} GB). Job wurde nicht gestartet. "
                       f"Lösche Dateien in der Library oder passe das Limit in den Einstellungen an."
            )

    if not force:
        dup_id = job_manager.find_duplicate_pending_or_running(request.input_file, request.job_type, request.output_file)
        if dup_id:
            raise HTTPException(
                status_code=409,
                detail=f"Ein identischer Job (gleiche Quelle) läuft bereits oder wartet (Job {dup_id}). "
                       f"Erneut senden, um trotzdem zu starten."
            )

    if getattr(job_manager, "prevent_output_overwrite", True) and request.output_file:
        if os.path.exists(request.output_file):
            raise HTTPException(
                status_code=409,
                detail=f"Zieldatei existiert bereits: {os.path.basename(request.output_file)}. "
                       f"Benenne die Ausgabe um oder deaktiviere den Überschreibschutz in den Einstellungen."
            )

    try:
        return await job_manager.add_job(request)
    except DangerousArgError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/jobs", response_model=list[Job])
def get_jobs():
    return job_manager.get_all_jobs_ordered()


@router.delete("/api/jobs/completed")
def clear_completed_jobs():
    job_manager.clear_completed_jobs()
    return {"status": "cleared"}


@router.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    success = await job_manager.cancel_job(job_id)
    if not success:
        raise HTTPException(status_code=400, detail="Job konnte nicht abgebrochen werden")
    return {"status": "cancelled", "job_id": job_id}


@router.post("/api/jobs/{job_id}/stop-live")
async def stop_live_job(job_id: str):
    """Beendet eine als Livestream markierte, laufende Aufnahme geordnet (statt hartem Abbruch)
    und behält die bisher aufgezeichnete Datei als abgeschlossenen Job."""
    success = await job_manager.stop_live_recording(job_id)
    if not success:
        raise HTTPException(
            status_code=400,
            detail="Aufnahme konnte nicht beendet werden (Job nicht gefunden, nicht aktiv oder keine Livestream-Aufnahme)."
        )
    return {"status": "stopping", "job_id": job_id}


@router.post("/api/jobs/cancel-all")
async def cancel_all_jobs():
    count = await job_manager.cancel_all_jobs()
    return {"status": "cancelled_all", "count": count}


@router.post("/api/jobs/{job_id}/retry", response_model=Job)
async def retry_job(job_id: str):
    min_free_gb = getattr(job_manager, "min_free_disk_gb", 2.0)
    if min_free_gb > 0:
        free_gb = get_free_disk_gb(OUTPUT_DIR)
        if free_gb < min_free_gb:
            raise HTTPException(
                status_code=507,
                detail=f"Zu wenig freier Speicherplatz ({free_gb:.2f} GB frei, Minimum {min_free_gb:.1f} GB)."
            )
    new_job = await job_manager.retry_job(job_id)
    if not new_job:
        raise HTTPException(status_code=400, detail="Job kann nicht wiederholt werden (nicht gefunden oder nicht fehlgeschlagen)")
    return new_job


@router.post("/api/jobs/queue/reorder")
async def reorder_queue(order: list[str] = Body(..., embed=True)):
    await job_manager.reorder_queue(order)
    return {"status": "reordered"}
