"""Line-delimited JSON protocol between the desktop app and the engine.

Every request is validated here before any command runs: shape, id, command
name (allowlist) and parameter types. Responses always carry the request id.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

MAX_LINE_BYTES = 1024 * 1024
ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{8,64}$")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class EngineError(Exception):
    """An error with a stable code that is safe to show to the user."""

    def __init__(self, code: str, message: str, retryable: bool = False, submitted: bool | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        # For commands with side effects: True = the action may already have taken effect.
        self.submitted = submitted

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"code": self.code, "message": self.message[:500], "retryable": self.retryable}
        if self.submitted is not None:
            data["submitted"] = self.submitted
        return data


@dataclass(frozen=True)
class Request:
    id: str
    cmd: str
    params: dict[str, Any]


def parse_request(line: bytes, allowed: set[str]) -> Request:
    if len(line) > MAX_LINE_BYTES:
        raise EngineError("INVALID_REQUEST", "Message too large.")
    try:
        data = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise EngineError("INVALID_REQUEST", "Message is not valid JSON.") from None
    if not isinstance(data, dict):
        raise EngineError("INVALID_REQUEST", "Message must be a JSON object.")
    request_id = data.get("id")
    if not isinstance(request_id, str) or not ID_PATTERN.match(request_id):
        raise EngineError("INVALID_REQUEST", "Missing or invalid request id.")
    cmd = data.get("cmd")
    if not isinstance(cmd, str) or cmd not in allowed:
        raise EngineError("UNKNOWN_COMMAND", "That command is not supported.", False)
    params = data.get("params", {})
    if not isinstance(params, dict):
        raise EngineError("INVALID_PARAMS", "params must be an object.")
    extra = set(data) - {"id", "cmd", "params"}
    if extra:
        raise EngineError("INVALID_REQUEST", "Unexpected fields in the message.")
    return Request(request_id, cmd, params)


def request_id_of(line: bytes) -> str | None:
    """Best-effort id extraction so even rejected requests get a matching reply."""
    try:
        value = json.loads(line.decode("utf-8")).get("id")
        return value if isinstance(value, str) and ID_PATTERN.match(value) else None
    except Exception:  # noqa: BLE001 — any malformed input simply has no id
        return None


def require_int(params: dict[str, Any], key: str, low: int, high: int, default: int) -> int:
    value = params.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise EngineError("INVALID_PARAMS", f"{key} must be an integer between {low} and {high}.")
    return value


def require_str(params: dict[str, Any], key: str, max_len: int) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value or len(value) > max_len:
        raise EngineError("INVALID_PARAMS", f"{key} must be a non-empty string.")
    return value


def validate_endpoint(value: str) -> str:
    """Only local DevTools endpoints: http(s)://127.0.0.1:<port> or ws(s)://…/devtools/…"""
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https", "ws", "wss"}:
        raise EngineError("ENDPOINT_NOT_ALLOWED", "The debugging endpoint must be an http or ws URL.")
    host = (parts.hostname or "").lower()
    if host not in LOOPBACK_HOSTS:
        raise EngineError("ENDPOINT_NOT_ALLOWED", "Only debugging endpoints on this computer (127.0.0.1) are allowed.")
    try:
        port = parts.port
    except ValueError:
        port = None
    if not port:
        raise EngineError("ENDPOINT_NOT_ALLOWED", "The debugging endpoint must include a port.")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise EngineError("ENDPOINT_NOT_ALLOWED", "The debugging endpoint must be a plain URL.")
    if parts.scheme in {"http", "https"} and parts.path not in {"", "/"}:
        raise EngineError("ENDPOINT_NOT_ALLOWED", "Use the base debugging address (http://127.0.0.1:<port>).")
    if parts.scheme in {"ws", "wss"} and not parts.path.startswith("/devtools/"):
        raise EngineError("ENDPOINT_NOT_ALLOWED", "WebSocket endpoints must be DevTools URLs.")
    return value


def encode(message: dict[str, Any]) -> bytes:
    return (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
