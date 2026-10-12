"""Publishing a post through the X web app in an IX Browser profile.

The engine attaches to the browser IX Browser launched (CDP), opens one tab in
the profile's existing context — so the profile's own signed-in session is
used and no cookies are read or copied — fills the composer, submits once, and
confirms the result from the post link X shows afterwards.

X has no documented automation interface for its web app. The selectors below
are the data-testid attributes the web app uses today; they live in one place
because they are the part most likely to change. Every failure says whether
the post button had already been clicked (`submitted`), and nothing here ever
clicks it twice.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
import unicodedata
from typing import Any
from urllib.parse import urlsplit

from .context import progress
from .protocol import EngineError, require_int, require_str, validate_endpoint

X_BASE_URL = "https://x.com"

SELECTORS = {
    "composer": '[data-testid="tweetTextarea_0"]',
    "post_button": '[data-testid="tweetButton"]',
    "file_input": 'input[data-testid="fileInput"]',
    "attachments": '[data-testid="attachments"]',
    "account_switcher": '[data-testid="SideNav_AccountSwitcher_Button"]',
    "toast": '[data-testid="toast"]',
    "login": '[data-testid="loginButton"], [data-testid="login"], input[autocomplete="username"]',
    "post": 'article[data-testid="tweet"]',
    "post_text": '[data-testid="tweetText"]',
}

MAX_TEXT_CHARS = 30_000
MAX_MEDIA = 4
MAX_MEDIA_BYTES = 15 * 1024 * 1024
MEDIA_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
POST_ID = re.compile(r"^\d{1,25}$")
STATUS_PATH = re.compile(r"^/([A-Za-z0-9_]{1,15})/status/(\d{1,25})")
LOGIN_PATHS = ("/login", "/i/flow/login", "/i/flow/signup", "/account/access")


def _base_url(params: dict[str, Any]) -> str:
    """x.com, or — only when the app enables test targets — a loopback test page."""
    base = params.get("baseUrl")
    if base is None:
        return X_BASE_URL
    if os.environ.get("AXORA_ENGINE_TEST_TARGETS") != "1" or not isinstance(base, str):
        raise EngineError("INVALID_PARAMS", "baseUrl is not accepted.")
    parts = urlsplit(base)
    if parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "localhost"} or parts.path not in {"", "/"} or parts.query:
        raise EngineError("INVALID_PARAMS", "baseUrl must be a loopback test address.")
    return base.rstrip("/")


def _media(params: dict[str, Any]) -> list[str]:
    media = params.get("media", [])
    if not isinstance(media, list) or len(media) > MAX_MEDIA:
        raise EngineError("INVALID_PARAMS", f"media must be a list of at most {MAX_MEDIA} files.")
    paths: list[str] = []
    for item in media:
        if not isinstance(item, str) or not os.path.isabs(item) or os.path.splitext(item)[1].lower() not in MEDIA_EXTENSIONS:
            raise EngineError("INVALID_PARAMS", "Each media item must be an absolute path to an image file.")
        if not os.path.isfile(item):
            raise EngineError("MEDIA_MISSING", "An attached image is missing from the image folder.")
        if os.path.getsize(item) > MAX_MEDIA_BYTES:
            raise EngineError("INVALID_PARAMS", "An attached image is too large.")
        paths.append(item)
    return paths


def _normalise(text: str) -> str:
    """For comparing what was typed with what the composer holds."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFC", text))


async def _first_visible(page: Any, selector: str, timeout_ms: int) -> bool:
    try:
        await page.locator(selector).first.wait_for(state="visible", timeout=timeout_ms)
        return True
    except Exception:  # noqa: BLE001 — a missing element is an answer, not an error
        return False


def _on_login_page(url: str) -> bool:
    return urlsplit(url).path.startswith(LOGIN_PATHS)


async def _signed_in_handle(page: Any) -> str | None:
    """The @handle shown in the side navigation's account button, if visible."""
    if not await _first_visible(page, SELECTORS["account_switcher"], 5_000):
        return None
    text = await page.locator(SELECTORS["account_switcher"]).first.inner_text()
    match = re.search(r"@([A-Za-z0-9_]{1,15})", text)
    return match.group(1) if match else None


async def find_post(connect: Any, params: dict[str, Any]) -> dict[str, Any]:
    """Look for a just-submitted post on the account's own profile page.

    Used when X did not confirm a submission: a post with exactly this text
    among the newest posts means it went out. Not finding it proves nothing
    (timelines can lag), so the caller keeps treating that as unknown.
    With `replies`, the profile's Replies tab is searched (for a comment).
    """
    endpoint = validate_endpoint(require_str(params, "endpoint", 300))
    handle = params.get("handle")
    if not isinstance(handle, str) or not HANDLE.match(handle):
        raise EngineError("INVALID_PARAMS", "handle must be an X username.")
    text = params.get("text", "")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
        raise EngineError("INVALID_PARAMS", "text must be the post text.")
    replies = params.get("replies", False)
    if not isinstance(replies, bool):
        raise EngineError("INVALID_PARAMS", "replies must be true or false.")
    timeout_ms = require_int(params, "timeoutMs", 5_000, 60_000, 20_000)
    base = _base_url(params)
    wanted = _normalise(text)
    browser = await connect(endpoint, timeout_ms)
    try:
        contexts = browser.contexts
        if not contexts:
            raise EngineError("NO_CONTEXT", "The browser exposed no existing session.")
        page = await contexts[0].new_page()
        try:
            page.set_default_timeout(timeout_ms)
            await page.goto(f"{base}/{handle}/with_replies" if replies else f"{base}/{handle}", wait_until="domcontentloaded")
            if _on_login_page(page.url):
                raise EngineError("SESSION_EXPIRED", "This profile is signed out of X.")
            if not await _first_visible(page, SELECTORS["post"], timeout_ms):
                return {"found": False, "checked": 0}
            articles = page.locator(SELECTORS["post"])
            count = min(await articles.count(), 10)
            for index in range(count):
                article = articles.nth(index)
                body = article.locator(SELECTORS["post_text"]).first
                if not await body.count():
                    continue
                shown = _normalise(await body.inner_text())
                # Long posts are cut off with "Show more": accept an exact match of what is shown.
                if not shown or not (shown == wanted or (len(shown) >= 80 and wanted.startswith(shown.rstrip("…")))):
                    continue
                link = article.locator('a[href*="/status/"]:has(time)').first
                href = await link.get_attribute("href") if await link.count() else None
                match = STATUS_PATH.match(urlsplit(href or "").path)
                if match and match.group(1).lower() == handle.lower():
                    return {"found": True, "checked": index + 1, "url": f"{X_BASE_URL}/{match.group(1)}/status/{match.group(2)}", "postId": match.group(2), "handle": match.group(1)}
            return {"found": False, "checked": count}
        finally:
            await page.close(run_before_unload=False)
    finally:
        await browser.close()


POST_URL = re.compile(r"^https://x\.com/(?:[A-Za-z0-9_]{1,15}|i)/status/\d{1,25}$")


async def open_post(connect: Any, params: dict[str, Any]) -> dict[str, Any]:
    """Open one post on X in a new tab of the profile's own session and leave it
    there for the person to act on. Nothing on the page is clicked or typed."""
    endpoint = validate_endpoint(require_str(params, "endpoint", 300))
    url = require_str(params, "url", 200)
    if not POST_URL.match(url):
        raise EngineError("INVALID_PARAMS", "Only links to posts on x.com can be opened.")
    timeout_ms = require_int(params, "timeoutMs", 5_000, 60_000, 20_000)
    target = _base_url(params) + urlsplit(url).path
    browser = await connect(endpoint, timeout_ms)
    try:
        contexts = browser.contexts
        if not contexts:
            raise EngineError("NO_CONTEXT", "The browser exposed no existing session.")
        page = await contexts[0].new_page()
        await page.goto(target, wait_until="domcontentloaded", timeout=timeout_ms)
        await page.bring_to_front()
        return {"opened": True, "signedOut": _on_login_page(page.url)}
    finally:
        await browser.close()  # disconnects only; the tab stays open for the user


async def publish(connect: Any, params: dict[str, Any]) -> dict[str, Any]:
    endpoint = validate_endpoint(require_str(params, "endpoint", 300))
    text = params.get("text", "")
    if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
        raise EngineError("INVALID_PARAMS", "text must be a string of at most 30,000 characters.")
    media = _media(params)
    if not text.strip() and not media:
        raise EngineError("INVALID_PARAMS", "A post needs text or an image.")
    expected = params.get("expectedHandle")
    if expected is not None and (not isinstance(expected, str) or not HANDLE.match(expected)):
        raise EngineError("INVALID_PARAMS", "expectedHandle must be an X username.")
    # A comment: a reply to one post (the account's own, published just before), through X's documented
    # post web intent. The composer, checks and confirmation are the same as for a post.
    in_reply_to = params.get("inReplyTo")
    if in_reply_to is not None and (not isinstance(in_reply_to, str) or not POST_ID.match(in_reply_to)):
        raise EngineError("INVALID_PARAMS", "inReplyTo must be a post id.")
    if in_reply_to is not None and media:
        raise EngineError("INVALID_PARAMS", "A comment can't carry images.")
    if in_reply_to is not None and not text.strip():
        raise EngineError("INVALID_PARAMS", "A comment needs text.")
    timeout_ms = require_int(params, "timeoutMs", 5_000, 120_000, 30_000)
    confirm_ms = require_int(params, "confirmTimeoutMs", 5_000, 120_000, 45_000)
    base = _base_url(params)

    steps: list[dict[str, Any]] = []
    submitted = False

    def step(name: str, started: float, **extra: Any) -> None:
        steps.append({"step": name, "ms": round((time.monotonic() - started) * 1000), **extra})

    progress("attach")
    t = time.monotonic()
    browser = await connect(endpoint, timeout_ms)
    step("attach", t)
    try:
        contexts = browser.contexts
        if not contexts:
            raise EngineError("NO_CONTEXT", "The browser exposed no existing session, so nothing was posted.")
        page = await contexts[0].new_page()
        try:
            page.set_default_timeout(timeout_ms)
            progress("open-composer")
            t = time.monotonic()
            target = f"{base}/intent/post?in_reply_to={in_reply_to}" if in_reply_to else f"{base}/compose/post"
            await page.goto(target, wait_until="domcontentloaded")
            if _on_login_page(page.url):
                raise EngineError("SESSION_EXPIRED", "This profile is signed out of X. Sign in in IX Browser, then try again.")
            if not await _first_visible(page, SELECTORS["composer"], timeout_ms):
                if _on_login_page(page.url) or await page.locator(SELECTORS["login"]).count():
                    raise EngineError("SESSION_EXPIRED", "This profile is signed out of X. Sign in in IX Browser, then try again.")
                raise EngineError("COMPOSER_NOT_FOUND", "The X post composer did not appear.", True)
            step("open-composer", t)

            account_check = "skipped"
            if expected:
                seen = await _signed_in_handle(page)
                if seen is None:
                    account_check = "unknown"
                elif seen.lower() != expected.lower():
                    raise EngineError("ACCOUNT_MISMATCH", f"This profile is signed in to X as @{seen}, not @{expected}. Nothing was posted.")
                else:
                    account_check = "match"

            progress("write")
            t = time.monotonic()
            composer = page.locator(SELECTORS["composer"]).first
            await composer.click()
            if text:
                await page.keyboard.insert_text(text)
            if _normalise(await composer.inner_text()) != _normalise(text):
                raise EngineError("TEXT_MISMATCH", "The composer did not take the post text exactly. Nothing was posted.")
            step("write", t, chars=len(text))

            if media:
                progress("upload-media")
                t = time.monotonic()
                await page.locator(SELECTORS["file_input"]).first.set_input_files(media)
                deadline = time.monotonic() + 90
                while True:
                    shown = await page.locator(f'{SELECTORS["attachments"]} img, {SELECTORS["attachments"]} video').count()
                    if shown >= len(media):
                        break
                    if time.monotonic() > deadline:
                        raise EngineError("MEDIA_UPLOAD_FAILED", "X did not finish taking the images. Nothing was posted.", True)
                    await asyncio.sleep(0.25)
                step("upload-media", t, files=len(media))

            button = page.locator(SELECTORS["post_button"]).first
            deadline = time.monotonic() + (90 if media else 15)
            while not (await button.is_visible() and await button.is_enabled()):
                if time.monotonic() > deadline:
                    raise EngineError("POST_BUTTON_DISABLED", "X did not enable the Post button (the post may be too long or an upload failed). Nothing was posted.")
                await asyncio.sleep(0.25)

            # Point of no return: from here on the post may exist.
            progress("submit")
            submitted = True
            t = time.monotonic()
            await button.click()
            step("submit", t)

            progress("confirm")
            t = time.monotonic()
            deadline = time.monotonic() + confirm_ms / 1000
            toast_seen_at: float | None = None
            while time.monotonic() < deadline:
                link = page.locator(f'{SELECTORS["toast"]} a[href*="/status/"]').first
                if await link.count():
                    href = await link.get_attribute("href") or ""
                    match = STATUS_PATH.match(urlsplit(href).path)
                    if match:
                        step("confirm", t)
                        return {
                            "ok": True,
                            "url": f"{X_BASE_URL}/{match.group(1)}/status/{match.group(2)}",
                            "postId": match.group(2),
                            "handle": match.group(1),
                            "accountCheck": account_check,
                            "inReplyTo": in_reply_to,
                            "steps": steps,
                        }
                if await page.locator(SELECTORS["toast"]).count():
                    toast_seen_at = toast_seen_at or time.monotonic()
                    if time.monotonic() - toast_seen_at > 4:
                        # A notice without a post link: X declined the post.
                        raise EngineError("REJECTED", "X did not accept the post.", False, submitted=True)
                await asyncio.sleep(0.25)
            raise EngineError("OUTCOME_UNKNOWN", "The post was submitted, but X did not confirm it in time.", False, submitted=True)
        finally:
            # run_before_unload=False: never trigger X's "discard post?" prompt.
            await page.close(run_before_unload=False)
    except EngineError as error:
        if error.submitted is None:
            error.submitted = submitted
        raise
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — Playwright raises several error types
        detail = str(exc).splitlines()[0][:160] if str(exc) else exc.__class__.__name__
        if submitted:
            raise EngineError("OUTCOME_UNKNOWN", f"The post was submitted, but confirming it failed ({detail}).", False, submitted=True) from None
        raise EngineError("PUBLISH_FAILED", f"Publishing stopped before anything was submitted ({detail}).", True, submitted=False) from None
    finally:
        await browser.close()  # disconnects; the profile's browser keeps running
