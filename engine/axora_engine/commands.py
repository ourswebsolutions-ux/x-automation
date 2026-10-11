"""Allowlisted engine commands. Browser work uses the official Playwright API."""
from __future__ import annotations

import asyncio
import base64
import os
import platform
import secrets
import sys
import time
from importlib import metadata
from typing import Any, Awaitable, Callable

from . import ENGINE_VERSION, PROTOCOL_VERSION
from . import x_publish
from .protocol import EngineError, require_int, require_str, validate_endpoint

Handler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

# A controlled page for the self-test: no network, no scripts from elsewhere.
TEST_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Axora Relay automation self-test</title></head>
<body><h1>Automation self-test</h1><label>Name <input id="name"></label>
<button id="go" onclick="document.getElementById('out').textContent='Hello, '+document.getElementById('name').value">Go</button>
<p id="out"></p></body></html>"""


def _versions() -> dict[str, Any]:
    try:
        playwright_version = metadata.version("playwright")
    except metadata.PackageNotFoundError:
        playwright_version = None
    return {
        "engine": ENGINE_VERSION,
        "protocol": PROTOCOL_VERSION,
        "python": platform.python_version(),
        "playwright": playwright_version,
        "platform": f"{sys.platform}-{platform.machine()}",
        "executable": sys.executable,
    }


class Engine:
    """Holds the Playwright driver (started once, lazily) and the command table."""

    def __init__(self) -> None:
        self._playwright: Any = None
        self._started = time.monotonic()
        self.stopping = False
        self.handlers: dict[str, Handler] = {
            "engine.hello": self.hello,
            "engine.health": self.health,
            "engine.shutdown": self.shutdown,
            "browser.check": self.browser_check,
            "browser.selfTest": self.browser_self_test,
            "x.publish": self.x_publish,
            "x.openPost": self.x_open_post,
            "x.findPost": self.x_find_post,
        }

    async def _driver(self) -> Any:
        if self._playwright is None:
            try:
                from playwright.async_api import async_playwright
            except ImportError as exc:  # pragma: no cover — packaging problem
                raise EngineError("DEPENDENCY_MISSING", f"Playwright is not installed in the engine runtime ({exc}).") from None
            self._playwright = await async_playwright().start()
        return self._playwright

    async def close(self) -> None:
        if self._playwright is not None:
            try:
                await self._playwright.stop()
            finally:
                self._playwright = None

    # ── engine ──────────────────────────────────────────────────────────

    async def hello(self, _params: dict[str, Any]) -> dict[str, Any]:
        return _versions()

    async def health(self, params: dict[str, Any]) -> dict[str, Any]:
        """Uptime, plus — when asked — a real start of the Playwright driver."""
        deep = params.get("deep", False) is True
        result: dict[str, Any] = {"uptimeSec": round(time.monotonic() - self._started), "pid": os.getpid(), **_versions()}
        if deep:
            started = time.monotonic()
            await self._driver()
            result["driverStartMs"] = round((time.monotonic() - started) * 1000)
            result["driverReady"] = True
        return result

    async def shutdown(self, _params: dict[str, Any]) -> dict[str, Any]:
        self.stopping = True
        return {"stopping": True}

    # ── browser ─────────────────────────────────────────────────────────

    async def _connect(self, endpoint: str, timeout_ms: int) -> Any:
        driver = await self._driver()
        try:
            return await driver.chromium.connect_over_cdp(endpoint, timeout=timeout_ms)
        except Exception as exc:  # noqa: BLE001 — Playwright raises several error types
            text = str(exc).splitlines()[0][:200] if str(exc) else exc.__class__.__name__
            if "Timeout" in text:
                raise EngineError("CONNECT_TIMEOUT", "The browser did not answer on its debugging address in time.", True) from None
            raise EngineError("CONNECT_FAILED", f"Could not connect to the browser's debugging address: {text}", True) from None

    async def browser_check(self, params: dict[str, Any]) -> dict[str, Any]:
        endpoint = validate_endpoint(require_str(params, "endpoint", 300))
        timeout_ms = require_int(params, "timeoutMs", 1000, 60000, 15000)
        browser = await self._connect(endpoint, timeout_ms)
        try:
            contexts = browser.contexts
            return {
                "connected": True,
                "browserVersion": browser.version,
                "contexts": len(contexts),
                "pages": sum(len(c.pages) for c in contexts),
            }
        finally:
            # For CDP connections this disconnects; it does not close the user's browser.
            await browser.close()

    async def browser_self_test(self, params: dict[str, Any]) -> dict[str, Any]:
        """Connect, open one tab in the profile's own context, navigate to a controlled
        page, type and click, verify the result, then close only that tab."""
        endpoint = validate_endpoint(require_str(params, "endpoint", 300))
        timeout_ms = require_int(params, "timeoutMs", 1000, 60000, 20000)
        screenshot_dir = params.get("screenshotDir")
        if screenshot_dir is not None and (not isinstance(screenshot_dir, str) or not os.path.isabs(screenshot_dir)):
            raise EngineError("INVALID_PARAMS", "screenshotDir must be an absolute path.")
        steps: list[dict[str, Any]] = []

        def step(name: str, started: float, **extra: Any) -> None:
            steps.append({"step": name, "ok": True, "ms": round((time.monotonic() - started) * 1000), **extra})

        t = time.monotonic()
        browser = await self._connect(endpoint, timeout_ms)
        step("connect", t, browserVersion=browser.version)
        try:
            contexts = browser.contexts
            if not contexts:
                raise EngineError("NO_CONTEXT", "The browser exposes no existing context, so the profile's session can't be used. A new, empty context was not created.")
            context = contexts[0]
            pages_before = len(context.pages)
            t = time.monotonic()
            page = await context.new_page()
            step("open-tab", t, pagesBefore=pages_before)
            try:
                page.set_default_timeout(timeout_ms)
                t = time.monotonic()
                data_url = "data:text/html;base64," + base64.b64encode(TEST_PAGE.encode("utf-8")).decode("ascii")
                await page.goto(data_url, wait_until="load")
                title = await page.title()
                if title != "Axora Relay automation self-test":
                    raise EngineError("TEST_FAILED", "The test page did not load as expected.")
                step("navigate", t, title=title)
                token = secrets.token_hex(4)
                t = time.monotonic()
                await page.fill("#name", token)
                await page.click("#go")
                await page.wait_for_function("t => document.getElementById('out').textContent === 'Hello, ' + t", arg=token)
                step("interact", t, verified=True)
                if screenshot_dir:
                    t = time.monotonic()
                    os.makedirs(screenshot_dir, exist_ok=True)
                    path = os.path.join(screenshot_dir, f"self-test-{int(time.time())}.png")
                    await page.screenshot(path=path)
                    step("screenshot", t, file=os.path.basename(path))
            finally:
                t = time.monotonic()
                await page.close()
                step("close-tab", t)
            pages_after = len(context.pages)
            return {
                "ok": True,
                "steps": steps,
                "browserVersion": browser.version,
                "usedExistingContext": True,
                "pagesBefore": pages_before,
                "pagesAfter": pages_after,
            }
        except EngineError:
            raise
        except asyncio.TimeoutError:
            raise EngineError("TIMEOUT", "The self-test timed out.", True) from None
        except Exception as exc:  # noqa: BLE001
            raise EngineError("TEST_FAILED", f"The self-test failed: {str(exc).splitlines()[0][:200]}", True) from None
        finally:
            await browser.close()

    # ── publishing ──────────────────────────────────────────────────────

    async def x_publish(self, params: dict[str, Any]) -> dict[str, Any]:
        """Publish one post in the profile's own session (see x_publish.py)."""
        return await x_publish.publish(self._connect, params)

    async def x_open_post(self, params: dict[str, Any]) -> dict[str, Any]:
        """Open a post in the profile's own session for the user (see x_publish.py)."""
        return await x_publish.open_post(self._connect, params)

    async def x_find_post(self, params: dict[str, Any]) -> dict[str, Any]:
        """Check the account's profile for a submitted post (see x_publish.py)."""
        return await x_publish.find_post(self._connect, params)
