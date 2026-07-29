"""Datei-Management-Routen: Auflisten, Hoch-/Herunterladen, Löschen und ZIP-Export von Input-/Output-Dateien."""
import os
import zipfile
from datetime import datetime
from fastapi import APIRouter, HTTPException, UploadFile, File, Body, Query
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.job_manager import job_manager
from app.core import INPUT_DIR, OUTPUT_DIR, CONFIG_DIR, safe_join_within, get_free_disk_gb

router = APIRouter()


@router.get("/api/files/inputs")
def list_input_files(source: str = Query("inputs")):
    files = []
    target_dir = OUTPUT_DIR if source == "outputs" else INPUT_DIR

    for root, _, filenames in os.walk(target_dir):
        for name in sorted(filenames):
            if name in ["download_archive.txt", ".part", ".ytdl", ".temp"]:
                continue
            full_path = os.path.join(root, name)
            rel_path = os.path.relpath(full_path, target_dir)
            try:
                size_mb = round(os.path.getsize(full_path) / (1024 * 1024), 2)
            except Exception:
                size_mb = 0.0
            files.append({"name": name, "path": full_path, "rel_path": rel_path, "size_mb": size_mb, "source": source})
    return files


@router.get("/api/files/inputs/download/{filename:path}")
def download_input_file(filename: str):
    try:
        file_path = safe_join_within(INPUT_DIR, filename)
        if not os.path.exists(file_path):
            file_path = safe_join_within(OUTPUT_DIR, filename)
    except HTTPException:
        raise
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")
    return FileResponse(file_path, filename=os.path.basename(file_path))


@router.get("/api/files/outputs")
def list_output_files():
    files = []
    ignored_exact = ("download_archive.txt",)
    ignored_suffixes = (".part", ".ytdl", ".temp", ".tmp", ".download", ".aria2")

    for root, _, filenames in os.walk(OUTPUT_DIR):
        for name in sorted(filenames):
            if name in ignored_exact or name.endswith(ignored_suffixes) or (".f" in name and (".webm" in name or ".m4a" in name or ".mp4" in name)):
                continue

            full_path = os.path.join(root, name)
            rel_path = os.path.relpath(full_path, OUTPUT_DIR)

            ext = os.path.splitext(name)[1].lower()
            category = "other"
            if ext in ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.gif']:
                category = "video"
            elif ext in ['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac']:
                category = "audio"
            elif ext in ['.jpg', '.jpeg', '.png', '.webp', '.ico', '.bmp']:
                category = "image"
            elif ext in ['.srt', '.vtt', '.txt', '.json']:
                category = "document"

            try:
                mtime_ts = os.path.getmtime(full_path)
                mtime_iso = datetime.fromtimestamp(mtime_ts).isoformat()
                size_mb = round(os.path.getsize(full_path) / (1024 * 1024), 2)
            except Exception:
                mtime_iso = datetime.now().isoformat()
                size_mb = 0.0

            files.append({
                "name": name,
                "path": full_path,
                "rel_path": rel_path,
                "size_mb": size_mb,
                "category": category,
                "mtime": mtime_iso
            })
    return files


@router.post("/api/files/outputs/zip")
def download_selected_zip(files: list[str] = Body(...)):
    if not files:
        raise HTTPException(status_code=400, detail="Keine Dateien ausgewählt")

    zip_name = f"mcp_export_{int(datetime.now().timestamp())}.zip"
    zip_path = os.path.join(CONFIG_DIR, zip_name)

    try:
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for rel_path in files:
                try:
                    full_path = safe_join_within(OUTPUT_DIR, rel_path)
                except HTTPException:
                    continue  # skip invalid/traversal paths instead of failing the whole export
                if os.path.exists(full_path):
                    zipf.write(full_path, arcname=rel_path)

        return FileResponse(zip_path, filename=zip_name, background=BackgroundTask(lambda: os.remove(zip_path) if os.path.exists(zip_path) else None))
    except Exception as e:
        if os.path.exists(zip_path):
            os.remove(zip_path)
        raise HTTPException(status_code=500, detail=f"ZIP Erstellung fehlgeschlagen: {str(e)}")


@router.delete("/api/files/outputs")
def delete_output_file(rel_path: str):
    file_path = safe_join_within(OUTPUT_DIR, rel_path)
    if os.path.exists(file_path):
        try:
            os.remove(file_path)
            return {"status": "success"}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    raise HTTPException(status_code=404, detail="Datei nicht gefunden")


@router.post("/api/files/upload")
async def upload_file(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Kein Dateiname übergeben.")

    min_free_gb = getattr(job_manager, "min_free_disk_gb", 2.0)
    if min_free_gb > 0:
        free_gb = get_free_disk_gb(INPUT_DIR)
        if free_gb < min_free_gb:
            raise HTTPException(
                status_code=507,
                detail=f"Zu wenig freier Speicherplatz auf {INPUT_DIR} ({free_gb:.2f} GB frei, Minimum {min_free_gb:.1f} GB). Upload abgebrochen."
            )

    safe_filename = os.path.basename(file.filename)
    target_path = os.path.join(INPUT_DIR, safe_filename)

    try:
        bytes_written = 0
        with open(target_path, "wb") as buffer:
            while chunk := await file.read(1024 * 1024):
                buffer.write(chunk)
                bytes_written += len(chunk)
                if min_free_gb > 0 and bytes_written % (10 * 1024 * 1024) == 0:
                    if get_free_disk_gb(INPUT_DIR) < min_free_gb:
                        raise HTTPException(
                            status_code=507,
                            detail="Upload abgebrochen: Mindestspeicherplatz während des Uploads unterschritten."
                        )

        size_mb = round(os.path.getsize(target_path) / (1024 * 1024), 2)
        return {"filename": safe_filename, "path": target_path, "size_mb": size_mb, "status": "success"}
    except HTTPException:
        if os.path.exists(target_path):
            try:
                os.remove(target_path)
            except Exception:
                pass
        raise
    except Exception as e:
        if os.path.exists(target_path):
            try:
                os.remove(target_path)
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Upload fehlgeschlagen: {str(e)}")


@router.get("/api/files/download/{filename:path}")
def download_output_file(filename: str):
    file_path = safe_join_within(OUTPUT_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")
    return FileResponse(file_path, filename=os.path.basename(file_path), content_disposition_type="attachment")
