"""x.publish against a real browser (CDP) and the local X stand-in (x_fixture.py).

These prove the publisher's logic — one submission, honest outcomes, the
`submitted` flag — not that x.com still matches the selectors. Skipped unless
AXORA_TEST_CDP_ENDPOINT points at a real Chrome/Chromium.
"""
import base64
import json
import os
import tempfile
import unittest
import urllib.request

from helpers import EngineProcess
from x_fixture import Fixture

ENDPOINT = os.environ.get("AXORA_TEST_CDP_ENDPOINT")
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==")
TEXT = "Shipping the scheduler today 🚀\nSecond line with a link https://example.com\n\n#buildinpublic"


def page_tabs() -> int:
    with urllib.request.urlopen(f"{ENDPOINT}/json/list", timeout=5) as res:
        return sum(1 for t in json.load(res) if t.get("type") == "page")


@unittest.skipUnless(ENDPOINT, "AXORA_TEST_CDP_ENDPOINT not set (no real browser to attach to)")
class PublishTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = Fixture().start()
        cls.media_dir = tempfile.mkdtemp(prefix="axora media ")
        cls.images = []
        for name in ("one.png", "two.png"):
            path = os.path.join(cls.media_dir, name)
            with open(path, "wb") as fh:
                fh.write(PNG)
            cls.images.append(path)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.stop()

    def setUp(self):
        self.fixture.reset()
        self.engine = EngineProcess(env={"AXORA_ENGINE_TEST_TARGETS": "1"})

    def tearDown(self):
        self.engine.close()

    def publish(self, **extra):
        params = {"endpoint": ENDPOINT, "text": TEXT, "baseUrl": self.fixture.base_url, "timeoutMs": 15000, "confirmTimeoutMs": 8000, **extra}
        return self.engine.call("x.publish", params)

    def posts(self):
        return list(self.fixture.posts)

    def test_publishes_once_and_returns_the_post_link(self):
        before = page_tabs()
        reply = self.publish(expectedHandle="relay_test")
        self.assertTrue(reply["ok"], reply)
        result = reply["result"]
        posts = self.posts()
        self.assertEqual(len(posts), 1)
        # contenteditable reports blank lines with an extra newline; compare line content.
        lines = lambda t: [line for line in t.replace("\r", "").split("\n") if line]  # noqa: E731
        self.assertEqual(lines(posts[0]["text"]), lines(TEXT))
        self.assertEqual(result["postId"], posts[0]["id"])
        self.assertEqual(result["url"], f"https://x.com/relay_test/status/{posts[0]['id']}")
        self.assertEqual(result["handle"], "relay_test")
        self.assertEqual(result["accountCheck"], "match")
        stages = [p["stage"] for p in self.engine.progress]
        self.assertEqual(stages, ["attach", "open-composer", "write", "submit", "confirm"])
        self.assertEqual(page_tabs(), before, "the publishing tab is closed again")

    def test_uploads_images(self):
        reply = self.publish(media=self.images)
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.posts()[0]["files"], 2)
        self.assertIn("upload-media", [p["stage"] for p in self.engine.progress])

    def test_signed_out_profile_posts_nothing(self):
        self.fixture.set("signed-out")
        error = self.publish()["error"]
        self.assertEqual(error["code"], "SESSION_EXPIRED")
        self.assertFalse(error["submitted"])
        self.assertEqual(self.posts(), [])

    def test_other_account_signed_in_posts_nothing(self):
        error = self.publish(expectedHandle="someone_else")["error"]
        self.assertEqual(error["code"], "ACCOUNT_MISMATCH")
        self.assertFalse(error["submitted"])
        self.assertEqual(self.posts(), [])

    def test_composer_that_drops_text_posts_nothing(self):
        self.fixture.set("mangle")
        error = self.publish()["error"]
        self.assertEqual(error["code"], "TEXT_MISMATCH")
        self.assertFalse(error["submitted"])
        self.assertEqual(self.posts(), [])

    def test_missing_composer_is_safe_to_retry(self):
        self.fixture.set("no-composer")
        error = self.publish(timeoutMs=5000)["error"]
        self.assertEqual(error["code"], "COMPOSER_NOT_FOUND")
        self.assertTrue(error["retryable"])
        self.assertFalse(error["submitted"])

    def test_disabled_post_button_posts_nothing(self):
        self.fixture.set("button-disabled")
        error = self.publish()["error"]
        self.assertEqual(error["code"], "POST_BUTTON_DISABLED")
        self.assertFalse(error["submitted"])
        self.assertEqual(self.posts(), [])

    def test_rejection_is_reported_as_submitted(self):
        self.fixture.set("reject")
        error = self.publish()["error"]
        self.assertEqual(error["code"], "REJECTED")
        self.assertTrue(error["submitted"])
        self.assertEqual(len(self.posts()), 1, "clicked exactly once")

    def test_no_confirmation_is_an_unknown_outcome_never_a_success(self):
        self.fixture.set("silent")
        error = self.publish(confirmTimeoutMs=5000)["error"]
        self.assertEqual(error["code"], "OUTCOME_UNKNOWN")
        self.assertTrue(error["submitted"])
        self.assertFalse(error["retryable"])
        self.assertEqual(len(self.posts()), 1, "clicked exactly once")

    def test_missing_media_file_is_refused_before_anything_happens(self):
        error = self.publish(media=[os.path.join(self.media_dir, "gone.png")])["error"]
        self.assertEqual(error["code"], "MEDIA_MISSING")
        self.assertEqual(self.posts(), [])

    def test_comment_replies_once_to_the_given_post(self):
        post = self.publish(expectedHandle="relay_test")["result"]
        self.engine.progress.clear()
        reply = self.publish(text="More details in the thread", inReplyTo=post["postId"], expectedHandle="relay_test")
        self.assertTrue(reply["ok"], reply)
        posts = self.posts()
        self.assertEqual(len(posts), 2)
        self.assertIsNone(posts[0]["inReplyTo"], "the post itself is not a reply")
        self.assertEqual(posts[1]["inReplyTo"], post["postId"], "the comment answers exactly that post")
        self.assertEqual(posts[1]["text"].strip(), "More details in the thread")
        self.assertEqual(reply["result"]["inReplyTo"], post["postId"])
        self.assertEqual(reply["result"]["postId"], posts[1]["id"])
        self.assertEqual([p["stage"] for p in self.engine.progress], ["attach", "open-composer", "write", "submit", "confirm"])

    def test_comment_keeps_every_safety_check(self):
        self.assertEqual(self.publish(text="A comment", inReplyTo="1900000000000000001", expectedHandle="someone_else")["error"]["code"], "ACCOUNT_MISMATCH")
        self.fixture.set("silent")
        error = self.publish(text="A comment", inReplyTo="1900000000000000001", confirmTimeoutMs=5000)["error"]
        self.assertEqual(error["code"], "OUTCOME_UNKNOWN")
        self.assertTrue(error["submitted"])
        self.assertEqual(len(self.posts()), 1, "clicked exactly once")


@unittest.skipUnless(ENDPOINT, "AXORA_TEST_CDP_ENDPOINT not set (no real browser to attach to)")
class FindPostTests(unittest.TestCase):
    """After an unconfirmed submit: is the post on the account's profile?"""

    @classmethod
    def setUpClass(cls):
        cls.fixture = Fixture().start()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.stop()

    def setUp(self):
        self.fixture.reset()
        self.engine = EngineProcess(env={"AXORA_ENGINE_TEST_TARGETS": "1"})

    def tearDown(self):
        self.engine.close()

    def submit_unconfirmed(self, mode):
        self.fixture.set(mode)
        reply = self.engine.call("x.publish", {"endpoint": ENDPOINT, "text": TEXT, "baseUrl": self.fixture.base_url, "confirmTimeoutMs": 5000})
        self.assertEqual(reply["error"]["code"], "OUTCOME_UNKNOWN")

    def find(self, text=TEXT, handle="relay_test", **extra):
        return self.engine.call("x.findPost", {"endpoint": ENDPOINT, "handle": handle, "text": text, "baseUrl": self.fixture.base_url, **extra})

    def test_finds_a_post_that_went_out(self):
        self.submit_unconfirmed("silent")
        result = self.find()["result"]
        self.assertTrue(result["found"])
        self.assertEqual(result["url"], f"https://x.com/relay_test/status/{self.fixture.posts[0]['id']}")

    def test_missing_post_is_not_found(self):
        self.submit_unconfirmed("silent-missing")
        self.assertFalse(self.find()["result"]["found"])

    def test_other_text_is_not_matched(self):
        self.submit_unconfirmed("silent")
        self.assertFalse(self.find(text="Something else entirely")["result"]["found"])

    def test_signed_out(self):
        self.fixture.set("signed-out")
        self.assertEqual(self.find()["error"]["code"], "SESSION_EXPIRED")

    def test_finds_an_unconfirmed_comment_among_replies_only(self):
        self.fixture.set("silent")
        reply = self.engine.call("x.publish", {"endpoint": ENDPOINT, "text": "An unconfirmed comment", "inReplyTo": "1900000000000000001", "baseUrl": self.fixture.base_url, "confirmTimeoutMs": 5000})
        self.assertEqual(reply["error"]["code"], "OUTCOME_UNKNOWN")
        self.assertFalse(self.find(text="An unconfirmed comment")["result"]["found"], "replies are not on the posts tab")
        found = self.find(text="An unconfirmed comment", replies=True)["result"]
        self.assertTrue(found["found"])
        self.assertEqual(found["postId"], self.fixture.posts[0]["id"])

    def test_validation(self):
        self.assertEqual(self.find(handle="not valid")["error"]["code"], "INVALID_PARAMS")
        self.assertEqual(self.find(text="")["error"]["code"], "INVALID_PARAMS")
        self.assertEqual(self.find(replies="yes")["error"]["code"], "INVALID_PARAMS")


@unittest.skipUnless(ENDPOINT, "AXORA_TEST_CDP_ENDPOINT not set (no real browser to attach to)")
class OpenPostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = Fixture().start()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.stop()

    def setUp(self):
        self.fixture.reset()
        self.engine = EngineProcess(env={"AXORA_ENGINE_TEST_TARGETS": "1"})

    def tearDown(self):
        self.engine.close()

    def open(self, url):
        return self.engine.call("x.openPost", {"endpoint": ENDPOINT, "url": url, "baseUrl": self.fixture.base_url})

    def test_opens_the_post_and_leaves_the_tab_for_the_user(self):
        before = page_tabs()
        reply = self.open("https://x.com/relay_test/status/1234567890")
        self.assertTrue(reply["ok"], reply)
        self.assertFalse(reply["result"]["signedOut"])
        self.assertEqual(self.fixture.opened, ["/relay_test/status/1234567890"])
        with urllib.request.urlopen(f"{ENDPOINT}/json/list", timeout=5) as res:
            tabs = [t for t in json.load(res) if t.get("type") == "page"]
        self.assertEqual(len(tabs), before + 1, "the tab stays open after the engine disconnects")
        self.assertTrue(any(t["url"].endswith("/relay_test/status/1234567890") for t in tabs))
        self.assertEqual(self.fixture.posts, [], "nothing was posted")

    def test_reports_a_signed_out_profile(self):
        self.fixture.set("signed-out")
        self.assertTrue(self.open("https://x.com/i/status/42")["result"]["signedOut"])

    def test_only_x_post_links(self):
        for url in ["https://evil.example/a/status/1", "https://x.com/relay_test", "http://x.com/a/status/1", "https://x.com/a/status/1?x=1", "javascript:alert(1)"]:
            self.assertEqual(self.open(url)["error"]["code"], "INVALID_PARAMS", url)


class PublishParamTests(unittest.TestCase):
    def setUp(self):
        self.engine = EngineProcess()

    def tearDown(self):
        self.engine.close()

    def test_test_targets_refused_unless_enabled(self):
        reply = self.engine.call("x.publish", {"endpoint": "http://127.0.0.1:9", "text": "hi", "baseUrl": "http://127.0.0.1:1234"})
        self.assertEqual(reply["error"]["code"], "INVALID_PARAMS")

    def test_validation(self):
        call = lambda **p: self.engine.call("x.publish", {"endpoint": "http://127.0.0.1:9", **p})["error"]["code"]  # noqa: E731
        self.assertEqual(call(text=""), "INVALID_PARAMS")
        self.assertEqual(call(text="x" * 30001), "INVALID_PARAMS")
        self.assertEqual(call(text="hi", media=["relative.png"]), "INVALID_PARAMS")
        self.assertEqual(call(text="hi", media=["/tmp/a.exe"]), "INVALID_PARAMS")
        self.assertEqual(call(text="hi", expectedHandle="not a handle"), "INVALID_PARAMS")
        self.assertEqual(call(text="hi", inReplyTo="not-an-id"), "INVALID_PARAMS")
        self.assertEqual(call(text="hi", inReplyTo=123), "INVALID_PARAMS")
        self.assertEqual(call(text="   ", inReplyTo="123"), "INVALID_PARAMS")
        self.assertEqual(self.engine.call("x.publish", {"endpoint": "http://10.0.0.1:9222", "text": "hi"})["error"]["code"], "ENDPOINT_NOT_ALLOWED")


if __name__ == "__main__":
    unittest.main()
