"""Bounded FFmpeg capability checks and container-aware CPU budgets.

An encoder listed by FFmpeg is not necessarily usable: drivers and devices may be
missing. Hardware candidates must also encode a synthetic frame successfully.
"""
import math
import os
import platform
import re
import subprocess
import threading
from functools import lru_cache
from pathlib import Path


def effective_cpu_count():
    count = os.cpu_count() or 1
    try:
        count = min(count, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        pass
    # Container namespaces usually expose limits at these roots. Include parent
    # quotas when cgroups are visible from the host rather than namespace-rooted.
    roots = [Path('/sys/fs/cgroup')]
    try:
        for line in Path('/proc/self/cgroup').read_text().splitlines():
            _, controllers, rel = line.split(':', 2)
            if not controllers or 'cpu' in controllers.split(','):
                root = Path('/sys/fs/cgroup') / ('cpu' if controllers else '')
                leaf = root / rel.lstrip('/')
                if leaf.is_relative_to(root):
                    roots.extend([leaf, *[p for p in leaf.parents if p.is_relative_to(root)]])
    except (OSError, ValueError):
        pass
    for root in set(roots):
        try:
            quota, period = (root / 'cpu.max').read_text().split()
            if quota != 'max' and int(period) > 0:
                count = min(count, max(1, math.ceil(int(quota) / int(period))))
        except (OSError, ValueError):
            pass
        for v1 in (root, root / 'cpu', root / 'cpu,cpuacct'):
            try:
                quota = int((v1 / 'cpu.cfs_quota_us').read_text())
                period = int((v1 / 'cpu.cfs_period_us').read_text())
                if quota > 0 and period > 0:
                    count = min(count, max(1, math.ceil(quota / period)))
            except (OSError, ValueError):
                pass
    return max(1, count)


def apply_thread_budget(args, configured_threads, concurrency):
    """Budget the standard single-output jobs; preserve explicit advanced options."""
    args = list(args)
    threads = configured_threads or max(1, effective_cpu_count() // max(1, concurrency))
    if not args:
        return args
    if not any(re.match(r'^-threads(?::.*)?$', a) for a in args):
        # Before the first input limits decoding; before the final output limits
        # encoding. FFmpeg's -threads is a per-file option, not a global option.
        args = ['-threads', str(threads)] + args[:-1] + ['-threads', str(threads), args[-1]]
    globals_ = []
    for flag in ('-filter_threads', '-filter_complex_threads'):
        if flag not in args:
            globals_ += [flag, str(threads)]
    # libx265 and SVT create their own pools in addition to codec threads.
    if 'libx265' in args and '-x265-params' not in args:
        args[-1:-1] = ['-x265-params', f'pools={threads}:frame-threads={min(threads, 4)}']
    if 'libsvtav1' in args and '-svtav1-params' not in args:
        args[-1:-1] = ['-svtav1-params', f'lp={threads}']
    return globals_ + args


SOFTWARE = {
    'libx264': 'H.264 · CPU', 'libx265': 'H.265 · CPU',
    'libsvtav1': 'AV1 · CPU', 'libvpx-vp9': 'VP9 · CPU', 'gif': 'GIF',
}
HARDWARE = {
    'h264_nvenc': ('H.264 · NVIDIA', 'cq'),
    'hevc_nvenc': ('H.265 · NVIDIA', 'cq'),
    'av1_nvenc': ('AV1 · NVIDIA', 'cq'),
    'h264_qsv': ('H.264 · Intel QSV', 'global_quality'),
    'hevc_qsv': ('H.265 · Intel QSV', 'global_quality'),
    'av1_qsv': ('AV1 · Intel QSV', 'global_quality'),
    'h264_vaapi': ('H.264 · VAAPI (Intel/AMD)', 'qp'),
    'hevc_vaapi': ('H.265 · VAAPI (Intel/AMD)', 'qp'),
    'av1_vaapi': ('AV1 · VAAPI (Intel/AMD)', 'qp'),
    'h264_videotoolbox': ('H.264 · Apple', 'q:v'),
    'hevc_videotoolbox': ('H.265 · Apple', 'q:v'),
}


def _run(args):
    return subprocess.run(['ffmpeg', '-hide_banner', '-nostdin', *args],
                          capture_output=True, text=True, timeout=8)


_probe_lock = threading.Lock()


def ffmpeg_capabilities():
    # Concurrent first-page loads must share one expensive GPU probe sequence.
    with _probe_lock:
        return _cached_ffmpeg_capabilities()


@lru_cache(maxsize=1)
def _cached_ffmpeg_capabilities():
    result = {'available': False, 'version': None, 'encoders': [], 'unavailable': []}
    try:
        listing = _run(['-encoders'])
        if listing.returncode:
            return result
        compiled = set(re.findall(r'^\s*V\S{5}\s+(\S+)', listing.stdout, re.M))
        result['available'] = True
        version = _run(['-version'])
        result['version'] = version.stdout.splitlines()[0] if version.stdout else None
        for codec, label in SOFTWARE.items():
            if codec in compiled:
                result['encoders'].append({'id': codec, 'label': label, 'hardware': False,
                                            'quality': 'crf', 'input_args': [], 'filter_args': []})
        for codec, (label, quality) in HARDWARE.items():
            if codec not in compiled:
                continue
            input_args, filter_args = [], []
            if codec.endswith('_vaapi'):
                devices = sorted(Path('/dev/dri').glob('renderD*'))
                if not devices:
                    result['unavailable'].append({'id': codec, 'reason': 'No /dev/dri/renderD* device'})
                    continue
                input_args = ['-vaapi_device', str(devices[0])]
                filter_args = ['-vf', 'format=nv12,hwupload']
            try:
                probe = _run(['-v', 'error', *input_args, '-f', 'lavfi', '-i',
                              'color=size=128x128:rate=1', *filter_args, '-frames:v', '1',
                              '-c:v', codec, '-f', 'null', '-'])
                if probe.returncode:
                    result['unavailable'].append({'id': codec, 'reason': probe.stderr.strip()[-300:]})
                    continue
            except (OSError, subprocess.TimeoutExpired) as exc:
                result['unavailable'].append({'id': codec, 'reason': str(exc)[:300]})
                continue
            result['encoders'].append({'id': codec, 'label': label, 'hardware': True,
                                        'quality': quality, 'input_args': input_args,
                                        'filter_args': filter_args})
    except (OSError, subprocess.TimeoutExpired):
        pass
    return result


def hardware_info(concurrency=2):
    from app.core import get_container_memory
    _, total = get_container_memory()
    cpus = effective_cpu_count()
    return {**ffmpeg_capabilities(), 'platform': platform.system(),
            'architecture': platform.machine(), 'cpu_budget': cpus,
            'memory_gb': round(total / 1024**3, 2),
            'auto_threads_per_job': max(1, cpus // max(1, concurrency))}
