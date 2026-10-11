"""Engine main loop: reads requests from stdin, writes responses to stdout.

stdin is read on a dedicated thread (portable across Windows and POSIX);
commands run on the asyncio loop with a per-command timeout. stdout carries
only protocol messages; diagnostics go out as "log" events.
"""
from __future__ import annotations

import asyncio
import os
import sys
import threading
from typing import Any

from . import context
from .commands import Engine
from .protocol import MAX_LINE_BYTES, EngineError, encode, parse_request, request_id_of

COMMAND_TIMEOUT_SEC = 90
# Publishing includes opening a page, uploading media and waiting for confirmation.
COMMAND_TIMEOUTS_SEC = {"x.publish": 300}


class Output:
    def __init__(self) -> None:
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        data = encode(message)
        with self._lock:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()

    def log(self, level: str, message: str) -> None:
        self.send({"event": "log", "level": level, "message": message[:500]})


def _reader(loop: asyncio.AbstractEventLoop, queue: "asyncio.Queue[bytes | None]") -> None:
    # Reads the raw descriptor rather than sys.stdin.buffer: a daemon thread
    # blocked inside BufferedReader holds its lock and aborts interpreter shutdown.
    fd = sys.stdin.fileno()
    pending = b""
    discarding = False  # inside an oversized line that was already rejected
    while True:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b""
        if not chunk:
            loop.call_soon_threadsafe(queue.put_nowait, None)  # parent closed the pipe
            return
        pending += chunk
        *lines, pending = pending.split(b"\n")
        for line in lines:
            if discarding:
                discarding = False
                continue
            loop.call_soon_threadsafe(queue.put_nowait, line.rstrip(b"\r"))
        if not discarding and len(pending) > MAX_LINE_BYTES:
            # Hand the head on so the request is rejected (with its id if readable), drop the rest.
            loop.call_soon_threadsafe(queue.put_nowait, pending)
            discarding = True
        if discarding:
            pending = b""


async def _handle(engine: Engine, out: Output, line: bytes) -> None:
    try:
        request = parse_request(line, set(engine.handlers))
    except EngineError as error:
        out.send({"id": request_id_of(line), "ok": False, "error": error.to_dict()})
        return
    context.bind(request.id, out.send)
    try:
        timeout = COMMAND_TIMEOUTS_SEC.get(request.cmd, COMMAND_TIMEOUT_SEC)
        result = await asyncio.wait_for(engine.handlers[request.cmd](request.params), timeout)
        out.send({"id": request.id, "ok": True, "result": result})
    except EngineError as error:
        out.log("warning", f"{request.cmd} failed: {error.code}")
        out.send({"id": request.id, "ok": False, "error": error.to_dict()})
    except asyncio.TimeoutError:
        out.send({"id": request.id, "ok": False, "error": EngineError("TIMEOUT", "The command took too long.", True).to_dict()})
    except Exception as exc:  # noqa: BLE001 — never crash the loop on a command error
        out.log("error", f"{request.cmd} raised {exc.__class__.__name__}")
        out.send({"id": request.id, "ok": False, "error": EngineError("INTERNAL", "The engine hit an unexpected error.").to_dict()})


async def _run() -> int:
    engine = Engine()
    out = Output()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    threading.Thread(target=_reader, args=(loop, queue), daemon=True, name="stdin-reader").start()
    out.send({"event": "ready", "pid": os.getpid()})
    tasks: set[asyncio.Task[None]] = set()
    try:
        while not engine.stopping:
            line = await queue.get()
            if line is None:
                break
            if not line.strip():
                continue
            task = asyncio.create_task(_handle(engine, out, line))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
            if b'"engine.shutdown"' in line:
                await task
        if tasks:
            await asyncio.wait(tasks, timeout=5)
    finally:
        await engine.close()
    return 0


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=False)  # type: ignore[union-attr]
    try:
        code = asyncio.run(_run())
    except KeyboardInterrupt:
        code = 0
    # Everything is closed and flushed; exit without waiting on the stdin thread,
    # which may still be blocked in read() if the parent keeps the pipe open.
    sys.stdout.flush()
    os._exit(code)
