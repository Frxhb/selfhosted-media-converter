import asyncio
import io
import unittest
from contextlib import closing
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.routers import config, system
from app.job_manager import job_manager


class APITests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(config.router)
        app.include_router(system.router)
        self.client = TestClient(app)

    def test_health_and_hardware(self):
        self.assertEqual(self.client.get('/api/health').json(), {'status': 'ok'})
        response = self.client.get('/api/system/hardware')
        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(response.json()['auto_threads_per_job'], 1)

    def test_invalid_settings_do_not_persist(self):
        with patch.object(config, 'save_app_config') as save:
            self.assertEqual(self.client.post('/api/config', json={'max_concurrent_jobs': 0}).status_code, 422)
            save.assert_not_called()

    def test_failed_save_does_not_change_runtime(self):
        old = job_manager.max_concurrent_jobs
        with patch.object(config, 'save_app_config', side_effect=OSError('disk full')):
            response = self.client.post('/api/config', json={'max_concurrent_jobs': 3})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(job_manager.max_concurrent_jobs, old)

    def test_cookie_size_limit(self):
        response = self.client.post('/api/config/cookies', files={
            'file': ('cookies.txt', io.BytesIO(b'x' * (config.MAX_COOKIES_FILE_SIZE + 1)))})
        self.assertEqual(response.status_code, 400)

    def test_backup_includes_committed_wal_data(self):
        import sqlite3
        import tempfile
        import zipfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            db = str(Path(tmp) / 'history.db')
            with closing(sqlite3.connect(db)) as writer:
                writer.execute('PRAGMA journal_mode=WAL')
                writer.execute('CREATE TABLE history (title TEXT)')
                writer.execute("INSERT INTO history VALUES ('recent job')")
                writer.commit()
                with patch.object(system, 'DB_PATH', db), \
                     patch.object(system, 'CONFIG_JSON_PATH', str(Path(tmp) / 'missing.json')):
                    response = self.client.get('/api/config/backup')
                self.assertEqual(response.status_code, 200)
                with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                    archive.extract('mcp_stats.db', tmp)
                with closing(sqlite3.connect(str(Path(tmp) / 'mcp_stats.db'))) as restored:
                    self.assertEqual(restored.execute('SELECT title FROM history').fetchone()[0], 'recent job')


class UploadTests(unittest.TestCase):
    def test_duplicate_uploads_keep_original_and_are_listed(self):
        import tempfile
        from pathlib import Path
        from app.routers import files
        app = FastAPI()
        app.include_router(files.router)
        with tempfile.TemporaryDirectory() as tmp, patch.object(files, 'INPUT_DIR', tmp), patch.object(files, 'get_free_disk_gb', return_value=100):
            with TestClient(app) as client:
                first = client.post('/api/files/upload', files={'file': ('clip.mp4', b'first')})
                second = client.post('/api/files/upload', files={'file': ('clip.mp4', b'second')})
                self.assertEqual(first.status_code, 200)
                self.assertEqual(second.status_code, 200)
                self.assertNotEqual(first.json()['filename'], second.json()['filename'])
                self.assertEqual((Path(tmp) / 'clip.mp4').read_bytes(), b'first')
                self.assertEqual(Path(second.json()['path']).read_bytes(), b'second')
                listing = client.get('/api/files/inputs').json()
                self.assertEqual(len(listing), 2)
                self.assertTrue(all(item['mtime'] for item in listing))
