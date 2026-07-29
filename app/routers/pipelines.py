"""Pipeline-CRUD-Routen sowie das Starten von Pipeline-Läufen."""
import os
from fastapi import APIRouter, HTTPException

from app.job_manager import job_manager
from app.database import load_pipelines, save_pipelines
from app.models import Job, Pipeline, PipelineRunRequest
from app.core import OUTPUT_DIR, get_free_disk_gb

router = APIRouter()


@router.get("/api/pipelines", response_model=list[Pipeline])
def get_pipelines():
    return [Pipeline(**p) for p in load_pipelines()]


@router.post("/api/pipelines", response_model=Pipeline)
def create_pipeline(pipeline: Pipeline):
    if not pipeline.stages:
        raise HTTPException(status_code=400, detail="Eine Pipeline benötigt mindestens eine Stufe.")
    pipelines = load_pipelines()
    pipelines.append(pipeline.model_dump())
    save_pipelines(pipelines)
    return pipeline


@router.put("/api/pipelines/{pipeline_id}", response_model=Pipeline)
def update_pipeline(pipeline_id: str, pipeline: Pipeline):
    if not pipeline.stages:
        raise HTTPException(status_code=400, detail="Eine Pipeline benötigt mindestens eine Stufe.")
    pipelines = load_pipelines()
    idx = next((i for i, p in enumerate(pipelines) if p.get("id") == pipeline_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Pipeline nicht gefunden.")
    pipeline.id = pipeline_id
    pipelines[idx] = pipeline.model_dump()
    save_pipelines(pipelines)
    return pipeline


@router.delete("/api/pipelines/{pipeline_id}")
def delete_pipeline(pipeline_id: str):
    pipelines = load_pipelines()
    filtered = [p for p in pipelines if p.get("id") != pipeline_id]
    if len(filtered) == len(pipelines):
        raise HTTPException(status_code=404, detail="Pipeline nicht gefunden.")
    save_pipelines(filtered)
    return {"status": "deleted"}


@router.post("/api/pipelines/run", response_model=list[Job])
async def run_pipeline(request: PipelineRunRequest):
    pipelines = load_pipelines()
    raw = next((p for p in pipelines if p.get("id") == request.pipeline_id), None)
    if not raw:
        raise HTTPException(status_code=404, detail="Pipeline nicht gefunden.")
    pipeline = Pipeline(**raw)
    if not os.path.exists(request.input_file) and not request.input_file.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=404, detail="Eingabedatei nicht gefunden.")

    min_free_gb = getattr(job_manager, "min_free_disk_gb", 2.0)
    if min_free_gb > 0:
        free_gb = get_free_disk_gb(OUTPUT_DIR)
        if free_gb < min_free_gb:
            raise HTTPException(
                status_code=507,
                detail=f"Zu wenig freier Speicherplatz ({free_gb:.2f} GB frei, Minimum {min_free_gb:.1f} GB). Pipeline nicht gestartet."
            )

    return await job_manager.start_pipeline_run(
        pipeline,
        request.input_file,
        request.title,
        keep_only_final_output=request.keep_only_final_output
    )
