"""A local stand-in for the X web app's composer, for tests only.

It reproduces the elements the publisher relies on (see SELECTORS in
axora_engine/x_publish.py) and records every post it receives, so tests can
prove that exactly one post was submitted. It is NOT X: passing against it
shows the publisher's logic works, not that x.com still matches.

Control (JSON over HTTP, loopback only):
  POST /__control {"mode": ..., "handle": ...}   modes: ok, reject, silent, silent-missing, signed-out,
                                                  no-composer, mangle, button-disabled, slow-upload,
                                                  typeahead (suggestions cover Post while the text ends with #tag),
                                                  ignored (Post does nothing), covered (something always covers Post)
  GET  /intent/post?in_reply_to=<id>              the reply composer (posts are recorded with inReplyTo)
  GET  /<handle>/with_replies                     that account's replies
  GET  /__posts                                   posts received so far
  POST /__reset
  Cookie xh=<handle>                              that browser is signed in as <handle> instead

Run standalone (used by the app's end-to-end tests):
  python x_fixture.py            → prints {"port": N} and serves until stdin closes
"""
from __future__ import annotations

import html
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Compose / X (test fixture)</title>
<style>body{font-family:sans-serif;margin:0;display:flex}nav{width:220px;padding:12px;border-right:1px solid #ccc}
main{flex:1;padding:16px}[contenteditable]{border:1px solid #888;min-height:80px;padding:8px;white-space:pre-wrap}
#attachments img{width:80px;height:80px;object-fit:cover;margin:4px}[data-testid=toast]{position:fixed;bottom:16px;left:40%;background:#1d9bf0;color:#fff;padding:12px}</style></head>
<body><nav><div data-testid="SideNav_AccountSwitcher_Button"><span>Test Person</span> <span>@__HANDLE__</span></div></nav>
<main>__COMPOSER__</main>
<script>
const mode = "__MODE__";
const box = document.querySelector('[data-testid="tweetTextarea_0"]');
const button = document.querySelector('[data-testid="tweetButton"]');
const input = document.querySelector('[data-testid="fileInput"]');
const shelf = document.getElementById('attachments');
let files = 0;
function refresh(){ if (!button) return; button.disabled = mode === 'button-disabled' || !(box.innerText.trim() || files); suggest(); }
// Like X: while the last word is "#tag" or "@name", a suggestion list opens over the Post button.
function cover(on, testid){
  let el = document.getElementById('cover');
  if (on && !el && button) {
    const r = button.getBoundingClientRect();
    el = document.createElement('div'); el.id = 'cover'; el.setAttribute('role', 'listbox');
    if (testid) el.setAttribute('data-testid', testid);
    el.style.cssText = `position:fixed;left:${r.left - 20}px;top:${r.top - 20}px;width:${r.width + 40}px;height:${r.height + 40}px;background:#fff;border:1px solid #888;z-index:10`;
    el.textContent = '#suggestion';
    document.body.appendChild(el);
  } else if (!on && el) el.remove();
}
function suggest(){
  if (mode === 'covered') return cover(true, null);
  if (mode === 'typeahead') cover(/[#@][^\\s#@]+$/.test(box.innerText.replace(/\\n+$/, '')), 'typeaheadDropdown-1');
}
if (box) box.addEventListener('input', () => { if (mode === 'mangle' && box.innerText.length > 5) box.innerText = box.innerText.slice(0, 5); refresh(); });
if (input) input.addEventListener('change', () => {
  const list = [...input.files];
  setTimeout(() => {
    shelf.setAttribute('data-testid', 'attachments');
    for (const f of list) { const img = document.createElement('img'); img.src = URL.createObjectURL(f); shelf.appendChild(img); }
    files += list.length; refresh();
  }, mode === 'slow-upload' ? 2500 : 300);
});
if (button) button.addEventListener('click', async () => {
  if (mode === 'ignored') return;
  button.disabled = true;
  const res = await fetch('/__post', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text: box.innerText, files, inReplyTo: "__REPLY_TO__" || null})});
  const post = await res.json();
  // Like X, an accepted post closes the composer.
  if (mode !== 'reject') document.querySelector('main').innerHTML = '<p>Home</p>';
  if (mode === 'silent' || mode === 'silent-missing') return;
  setTimeout(() => {
    const toast = document.createElement('div');
    toast.setAttribute('data-testid', 'toast');
    toast.innerHTML = mode === 'reject' ? 'Whoops! You already said that.' : 'Your post was sent. <a href="/__HANDLE__/status/' + post.id + '">View</a>';
    document.body.appendChild(toast);
  }, 400);
});
refresh();
</script></body></html>"""

COMPOSER = """<div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text"></div>
<input type="file" data-testid="fileInput" multiple accept="image/*" style="display:none">
<div id="attachments"></div><button data-testid="tweetButton" disabled>Post</button>"""

LOGIN = """<!doctype html><html><head><meta charset="utf-8"><title>Log in to X (test fixture)</title></head>
<body><button data-testid="loginButton">Log in</button></body></html>"""


class Fixture:
    def __init__(self) -> None:
        self.mode = "ok"
        self.handle = "relay_test"
        self.posts: list[dict[str, Any]] = []
        self.opened: list[str] = []
        self._next_id = 1900000000000000001
        self.lock = threading.Lock()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:  # keep test output clean
                pass

            def _send(self, status: int, body: str | bytes, ctype: str = "text/html; charset=utf-8", headers: dict[str, str] | None = None) -> None:
                data = body.encode("utf-8") if isinstance(body, str) else body
                self.send_response(status)
                self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(data)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            def _handle(self) -> str:
                # A browser can be "signed in" as its own account with an `xh` cookie (multi-profile tests).
                for part in (self.headers.get("cookie") or "").split(";"):
                    name, _, value = part.strip().partition("=")
                    if name == "xh" and value:
                        return value
                return fixture.handle

            def _json(self) -> dict[str, Any]:
                length = int(self.headers.get("content-length") or 0)
                return json.loads(self.rfile.read(length) or b"{}")

            def do_GET(self) -> None:  # noqa: N802
                path = self.path.split("?")[0]
                if path in ("/compose/post", "/intent/post"):
                    if fixture.mode == "signed-out":
                        return self._send(302, "", headers={"location": "/i/flow/login"})
                    reply_to = parse_qs(urlsplit(self.path).query).get("in_reply_to", [""])[0] if path == "/intent/post" else ""
                    if path == "/intent/post" and not reply_to.isdigit():
                        return self._send(400, "in_reply_to is required", "text/plain")
                    composer = "" if fixture.mode == "no-composer" else COMPOSER
                    page = PAGE.replace("__COMPOSER__", composer).replace("__MODE__", fixture.mode).replace("__HANDLE__", self._handle()).replace("__REPLY_TO__", reply_to)
                    return self._send(200, page)
                if path == "/i/flow/login":
                    return self._send(200, LOGIN)
                profile = path.strip("/")
                replies = profile.endswith("/with_replies")
                if replies:
                    profile = profile[: -len("/with_replies")]
                if profile and "/" not in profile and not profile.startswith("__") and profile not in ("compose", "i", "intent"):
                    # A profile page listing the posts (or, on with_replies, the replies) this stand-in received, newest first.
                    if fixture.mode == "signed-out":
                        return self._send(302, "", headers={"location": "/i/flow/login"})
                    with fixture.lock:
                        listed = [p for p in reversed(fixture.posts) if p["mode"] not in ("reject", "silent-missing") and p["handle"] == profile and bool(p.get("inReplyTo")) == replies]
                    articles = "".join(
                        f'<article data-testid="tweet"><div data-testid="tweetText">{html.escape(p["text"])}</div>'
                        f'<a href="/{p["handle"]}/status/{p["id"]}"><time>now</time></a></article>'
                        for p in listed
                    )
                    return self._send(200, f"<!doctype html><html><head><meta charset='utf-8'><title>Profile</title></head><body>{articles or '<p>No posts</p>'}</body></html>")
                if "/status/" in path:
                    if fixture.mode == "signed-out":
                        return self._send(302, "", headers={"location": "/i/flow/login"})
                    with fixture.lock:
                        fixture.opened.append(path)
                    return self._send(200, f"<!doctype html><html><head><meta charset='utf-8'><title>Post (test fixture)</title></head><body><article>{path}</article></body></html>")
                if path == "/__posts":
                    with fixture.lock:
                        return self._send(200, json.dumps(fixture.posts), "application/json")
                if path == "/__opened":
                    with fixture.lock:
                        return self._send(200, json.dumps(fixture.opened), "application/json")
                return self._send(404, "not found", "text/plain")

            def do_POST(self) -> None:  # noqa: N802
                path = self.path.split("?")[0]
                if path == "/__post":
                    body = self._json()
                    with fixture.lock:
                        post = {"id": str(fixture._next_id), "text": body.get("text", ""), "files": body.get("files", 0), "mode": fixture.mode, "handle": self._handle(), "inReplyTo": body.get("inReplyTo") or None}
                        fixture._next_id += 1
                        fixture.posts.append(post)
                    return self._send(200, json.dumps(post), "application/json")
                if path == "/__control":
                    body = self._json()
                    fixture.mode = body.get("mode", fixture.mode)
                    fixture.handle = body.get("handle", fixture.handle)
                    return self._send(200, "{}", "application/json")
                if path == "/__reset":
                    with fixture.lock:
                        fixture.posts.clear()
                        fixture.opened.clear()
                    fixture.mode = "ok"
                    return self._send(200, "{}", "application/json")
                return self._send(404, "not found", "text/plain")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> "Fixture":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def set(self, mode: str = "ok", handle: str | None = None) -> None:
        self.mode = mode
        if handle:
            self.handle = handle

    def reset(self) -> None:
        with self.lock:
            self.posts.clear()
            self.opened.clear()
        self.mode = "ok"


if __name__ == "__main__":
    fx = Fixture().start()
    print(json.dumps({"port": fx.port}), flush=True)
    sys.stdin.read()  # serve until the parent closes our stdin
    fx.stop()
