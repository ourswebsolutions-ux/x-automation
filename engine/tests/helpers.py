import json
import os
import subprocess
import sys
import uuid

ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE_DIR)


class EngineProcess:
    """Runs the real engine (python -I run.py) and talks to it over stdio, like the app does."""

    def __init__(self, env: dict | None = None) -> None:
        self.progress: list[dict] = []
        self.proc = subprocess.Popen(
            [sys.executable, "-I", "-X", "utf8", "-u", "run.py"],
            cwd=ENGINE_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, **(env or {})},
        )
        ready = self._read()
        assert ready.get("event") == "ready", ready

    def _read(self) -> dict:
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("engine closed stdout: " + self.proc.stderr.read().decode(errors="replace")[-2000:])
            message = json.loads(line)
            if message.get("event") == "log":
                continue
            if message.get("event") == "progress":
                self.progress.append(message)
                continue
            return message

    def raw(self, line: bytes) -> dict:
        self.proc.stdin.write(line + b"\n")
        self.proc.stdin.flush()
        return self._read()

    def call(self, cmd: str, params: dict | None = None) -> dict:
        request_id = str(uuid.uuid4())
        reply = self.raw(json.dumps({"id": request_id, "cmd": cmd, "params": params or {}}).encode())
        assert reply.get("id") == request_id, reply
        return reply

    def close(self) -> int:
        try:
            self.call("engine.shutdown")
        except Exception:  # noqa: BLE001
            pass
        try:
            return self.proc.wait(timeout=10)
        finally:
            if self.proc.poll() is None:
                self.proc.kill()
