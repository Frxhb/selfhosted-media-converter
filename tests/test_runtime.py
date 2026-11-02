import asyncio
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError
from app.hardware import apply_thread_budget, effective_cpu_count, ffmpeg_capabilities
from app.job_manager import JobManager
from app.models import AppConfig, Job, JobType, JobStatus, JobCreateRequest
from app.process_utils import communicate_bounded


class ConfigurationTests(unittest.TestCase):
    def test_invalid_limits_and_tools_rejected(self):
        for config in ({'max_concurrent_jobs': 0}, {'max_concurrent_jobs': 9},
                       {'min_free_disk_gb': float('nan')}, {'auto_cleanup_days': -1},
                       {'ffmpeg_threads': '-1'}, {'watch_folder_interval_seconds': 0}):
            with self.subTest(config=config), self.assertRaises(ValidationError):
                AppConfig(**config)
        with self.assertRaises(ValidationError):
            JobCreateRequest(job_type='video', tool='/bin/sh', command_args=['-c', 'id'])

    def test_thread_options_apply_to_both_input_and_output(self):
        with patch('app.hardware.effective_cpu_count', return_value=4):
            args = apply_thread_budget(['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4'], 0, 2)
        self.assertEqual(args[:4], ['-filter_threads', '2', '-filter_complex_threads', '2'])
        self.assertEqual(args[4:6], ['-threads', '2'])
        self.assertEqual(args[-3:], ['-threads', '2', 'out.mp4'])
        explicit = apply_thread_budget(['-i', 'in', '-threads:v', '3', 'out'], 2, 2)
        self.assertNotIn('-threads', explicit)

    def test_cpu_quota_and_affinity(self):
        def read(path):
            if str(path) == '/sys/fs/cgroup/cpu.max':
                return '150000 100000'
            raise OSError()
        with patch('app.hardware.os.cpu_count', return_value=16), \
             patch('app.hardware.os.sched_getaffinity', create=True, return_value={0, 1, 2, 3}), \
             patch.object(Path, 'read_text', read):
            self.assertEqual(effective_cpu_count(), 2)


class QueueTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.manager = JobManager()

    async def test_claim_is_atomic_and_limit_changes_apply(self):
        m = self.manager
        m.max_concurrent_jobs = 1
        a = await m.add_job(JobCreateRequest(job_type='video', command_args=[]))
        b = await m.add_job(JobCreateRequest(job_type='video', command_args=[]))
        claims = await asyncio.gather(m._pop_next_job_id(), m._pop_next_job_id())
        self.assertEqual(claims.count(None), 1)
        self.assertEqual(a.status, JobStatus.RUNNING)
        m.max_concurrent_jobs = 2
        self.assertEqual(await m._pop_next_job_id(), b.id)

    async def test_blocked_domain_sleeps_and_other_domain_runs(self):
        m = self.manager
        m.max_concurrent_per_domain = 1
        a = await m.add_job(JobCreateRequest(job_type='download', input_file='https://example.com/a', command_args=[]))
        b = await m.add_job(JobCreateRequest(job_type='download', input_file='https://example.com/b', command_args=[]))
        self.assertEqual(await m._pop_next_job_id(), a.id)
        self.assertIsNone(await m._pop_next_job_id())
        self.assertFalse(m.queue_event.is_set())
        c = await m.add_job(JobCreateRequest(job_type='download', input_file='https://other.test/a', command_args=[]))
        self.assertEqual(await m._pop_next_job_id(), c.id)
        self.assertIn(b.id, m.pending_queue)

    async def test_live_workers_honor_changed_limit(self):
        m = self.manager
        m.max_concurrent_jobs = 1
        started = asyncio.Queue()
        release = asyncio.Event()
        async def execute(job):
            await started.put(job.id)
            await release.wait()
            job.status = JobStatus.COMPLETED
        m._execute_job_pipeline = execute
        await m.start()
        try:
            for _ in range(3):
                await m.add_job(JobCreateRequest(job_type='video', command_args=[]))
            await asyncio.wait_for(started.get(), 1)
            await asyncio.sleep(0.02)
            self.assertTrue(started.empty())
            m.max_concurrent_jobs = 2
            m.queue_event.set()
            await asyncio.wait_for(started.get(), 1)
            self.assertTrue(started.empty())
            release.set()
            await asyncio.wait_for(started.get(), 1)
        finally:
            release.set()
            await m.stop()

    async def test_websocket_disconnect_during_broadcast(self):
        m = self.manager
        class Socket:
            async def send_json(self, message):
                m.unregister_websocket(self)
        m.active_websockets.update([Socket(), Socket()])
        await m.broadcast({'type': 'test'})
        self.assertFalse(m.active_websockets)

    async def test_timeout_reaps_child(self):
        proc = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time; time.sleep(60)')
        with self.assertRaises(asyncio.TimeoutError):
            await communicate_bounded(proc, 0.03)
        self.assertIsNotNone(proc.returncode)


@unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg not installed')
class FFmpegTests(unittest.TestCase):
    def test_real_h264_and_vp9_outputs(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            for codec, ext in [('libx264', 'mp4'), ('libvpx-vp9', 'webm')]:
                output = str(Path(tmp) / ('sample.' + ext))
                args = apply_thread_budget(['-v', 'error', '-f', 'lavfi', '-i',
                    'color=size=128x128:rate=5:duration=0.4', '-c:v', codec, '-an', output], 1, 2)
                proc = subprocess.run(['ffmpeg', *args], capture_output=True, timeout=20)
                self.assertEqual(proc.returncode, 0, proc.stderr.decode())
                self.assertGreater(Path(output).stat().st_size, 0)

    def test_capabilities_include_software_and_no_duplicate_encoders(self):
        capabilities = ffmpeg_capabilities()
        self.assertTrue(capabilities['available'])
        ids = [c['id'] for c in capabilities['encoders']]
        self.assertIn('libx264', ids)
        self.assertEqual(len(ids), len(set(ids)))


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancellation_between_claim_and_process_start(self):
        m = JobManager()
        job = await m.add_job(JobCreateRequest(job_type='video', command_args=[]))
        await m._pop_next_job_id()
        self.assertTrue(await m.cancel_job(job.id))
        with patch('app.job_manager.asyncio.create_subprocess_exec') as spawn:
            self.assertFalse(await m._run_subprocess(job, 'ffmpeg', [], 'test'))
            spawn.assert_not_called()
