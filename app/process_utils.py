"""Ensure short-lived inspection processes cannot outlive requests/timeouts."""
import asyncio


async def communicate_bounded(process, timeout=30.0):
    try:
        return await asyncio.wait_for(process.communicate(), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.wait()
        raise
