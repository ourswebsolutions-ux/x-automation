"""Per-request context: lets a command report progress for the request it serves."""
from __future__ import annotations

from contextvars import ContextVar
from typing import Any, Callable

_current: ContextVar[tuple[str, Callable[[dict[str, Any]], None]] | None] = ContextVar("axora_request", default=None)


def bind(request_id: str, send: Callable[[dict[str, Any]], None]) -> None:
    """Called by the main loop inside the task that runs the request."""
    _current.set((request_id, send))


def progress(stage: str) -> None:
    """Reports a stage to the app. Written (and flushed) before the next step runs."""
    current = _current.get()
    if current is not None:
        request_id, send = current
        send({"event": "progress", "id": request_id, "stage": stage[:40]})
