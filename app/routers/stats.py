"""System- und Job-Statistik-Routen (CPU/RAM/Disk-Auslastung, Nerd-Stats, Reset)."""
import os
import shutil
import psutil
from fastapi import APIRouter

from app.job_manager import job_manager
from app.database import get_nerd_stats, clear_db
from app.models import JobStatus
from app.core import INPUT_DIR, OUTPUT_DIR, get_container_memory

router = APIRouter()


@router.get("/api/stats")
def get_system_stats():
    cpu_pct = psutil.cpu_percent(interval=None)
    mem_used_bytes, mem_total_bytes = get_container_memory()

    try:
        load1, load5, load15 = os.getloadavg()
    except (OSError, AttributeError):
        load1, load5, load15 = 0.0, 0.0, 0.0

    mem_used_gb = round(mem_used_bytes / (1024**3), 2)
    mem_total_gb = round(mem_total_bytes / (1024**3), 2)
    mem_pct = round((mem_used_bytes / mem_total_bytes) * 100, 1) if mem_total_bytes > 0 else 0.0

    try:
        disk_in = shutil.disk_usage(INPUT_DIR)
        in_used = round(disk_in.used / (1024**3), 2)
        in_free = round(disk_in.free / (1024**3), 2)
        in_total = round(disk_in.total / (1024**3), 2)
        in_pct = round((disk_in.used / disk_in.total) * 100, 1)
    except Exception:
        in_used, in_free, in_total, in_pct = 0, 0, 0, 0

    try:
        disk_out = shutil.disk_usage(OUTPUT_DIR)
        out_used = round(disk_out.used / (1024**3), 2)
        out_free = round(disk_out.free / (1024**3), 2)
        out_total = round(disk_out.total / (1024**3), 2)
        out_pct = round((disk_out.used / disk_out.total) * 100, 1)
    except Exception:
        out_used, out_free, out_total, out_pct = 0, 0, 0, 0

    all_jobs = job_manager.get_all_jobs()
    nerd_stats = get_nerd_stats()

    return {
        "cpu_percent": cpu_pct,
        "load_avg": {"load1": round(load1, 2), "load5": round(load5, 2), "load15": round(load15, 2)},
        "ram_percent": mem_pct,
        "ram_used_gb": mem_used_gb,
        "ram_total_gb": mem_total_gb,
        "disk_inputs": {"used_gb": in_used, "free_gb": in_free, "total_gb": in_total, "percent": in_pct},
        "disk_outputs": {"used_gb": out_used, "free_gb": out_free, "total_gb": out_total, "percent": out_pct},
        "job_stats": nerd_stats,
        "active_jobs": len([j for j in all_jobs if j.status == JobStatus.RUNNING]),
        "pending_jobs": len([j for j in all_jobs if j.status == JobStatus.PENDING])
    }


@router.post("/api/stats/reset")
def reset_all_stats():
    clear_db()
    return {"status": "reset"}
