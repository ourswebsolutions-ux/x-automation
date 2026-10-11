import unittest

from helpers import EngineProcess  # noqa: F401  (adds the engine to sys.path)
from axora_engine.protocol import EngineError, parse_request, validate_endpoint

ALLOWED = {"engine.hello", "browser.check"}


class ParseRequestTests(unittest.TestCase):
    def test_valid(self):
        r = parse_request(b'{"id":"12345678-aaaa","cmd":"engine.hello","params":{}}', ALLOWED)
        self.assertEqual((r.id, r.cmd, r.params), ("12345678-aaaa", "engine.hello", {}))

    def test_rejections(self):
        cases = {
            b"not json": "INVALID_REQUEST",
            b"[1,2]": "INVALID_REQUEST",
            b'{"cmd":"engine.hello"}': "INVALID_REQUEST",
            b'{"id":"short","cmd":"engine.hello"}': "INVALID_REQUEST",
            b'{"id":"12345678-aaaa","cmd":"os.system"}': "UNKNOWN_COMMAND",
            b'{"id":"12345678-aaaa","cmd":"engine.hello","params":[]}': "INVALID_PARAMS",
            b'{"id":"12345678-aaaa","cmd":"engine.hello","extra":1}': "INVALID_REQUEST",
            b"x" * (1024 * 1024 + 1): "INVALID_REQUEST",
        }
        for line, code in cases.items():
            with self.subTest(line=line[:40]):
                with self.assertRaises(EngineError) as ctx:
                    parse_request(line, ALLOWED)
                self.assertEqual(ctx.exception.code, code)


class EndpointTests(unittest.TestCase):
    def test_allowed(self):
        for url in ["http://127.0.0.1:9222", "http://localhost:9222/", "http://[::1]:9222", "ws://127.0.0.1:9222/devtools/browser/abc"]:
            with self.subTest(url=url):
                self.assertEqual(validate_endpoint(url), url)

    def test_refused(self):
        for url in [
            "http://10.0.0.5:9222",
            "http://example.com:9222",
            "http://127.0.0.1",
            "file:///etc/passwd",
            "http://user:pw@127.0.0.1:9222",
            "http://127.0.0.1:9222/json/version",
            "ws://127.0.0.1:9222/other",
            "http://127.0.0.1:9222/?x=1",
        ]:
            with self.subTest(url=url):
                with self.assertRaises(EngineError) as ctx:
                    validate_endpoint(url)
                self.assertEqual(ctx.exception.code, "ENDPOINT_NOT_ALLOWED")


class EngineProcessTests(unittest.TestCase):
    def setUp(self):
        self.engine = EngineProcess()

    def tearDown(self):
        self.engine.close()

    def test_hello_reports_versions(self):
        reply = self.engine.call("engine.hello")
        self.assertTrue(reply["ok"])
        self.assertTrue(reply["result"]["python"].startswith("3."))
        self.assertIsNotNone(reply["result"]["playwright"])

    def test_deep_health_starts_playwright_driver(self):
        reply = self.engine.call("engine.health", {"deep": True})
        self.assertTrue(reply["ok"], reply)
        self.assertTrue(reply["result"]["driverReady"])

    def test_errors_carry_ids_and_codes(self):
        self.assertEqual(self.engine.call("browser.check", {"endpoint": "http://8.8.8.8:9222"})["error"]["code"], "ENDPOINT_NOT_ALLOWED")
        self.assertEqual(self.engine.call("browser.check", {})["error"]["code"], "INVALID_PARAMS")
        self.assertEqual(self.engine.raw(b'{"id":"12345678-bbbb","cmd":"shell.exec","params":{}}')["error"]["code"], "UNKNOWN_COMMAND")
        malformed = self.engine.raw(b"{not json")
        self.assertIsNone(malformed["id"])
        self.assertEqual(malformed["error"]["code"], "INVALID_REQUEST")

    def test_unreachable_endpoint_is_retryable_failure(self):
        reply = self.engine.call("browser.check", {"endpoint": "http://127.0.0.1:9", "timeoutMs": 3000})
        self.assertFalse(reply["ok"])
        self.assertIn(reply["error"]["code"], {"CONNECT_FAILED", "CONNECT_TIMEOUT"})
        self.assertTrue(reply["error"]["retryable"])

    def test_still_responsive_after_errors(self):
        self.engine.raw(b"garbage")
        self.assertTrue(self.engine.call("engine.health")["ok"])

    def test_oversized_line_rejected_once_then_resyncs(self):
        huge = b'{"id":"12345678-cccc","cmd":"engine.hello","params":{"x":"' + b"a" * (3 * 1024 * 1024) + b'"}}'
        self.assertEqual(self.engine.raw(huge)["error"]["code"], "INVALID_REQUEST")
        self.assertTrue(self.engine.call("engine.hello")["ok"])  # the next reply is ours: nothing extra was queued

    def test_exits_when_parent_closes_stdin(self):
        self.engine.proc.stdin.close()
        self.assertEqual(self.engine.proc.wait(timeout=10), 0)

    def test_clean_shutdown(self):
        reply = self.engine.call("engine.shutdown")
        self.assertTrue(reply["result"]["stopping"])
        self.assertEqual(self.engine.proc.wait(timeout=10), 0)


if __name__ == "__main__":
    unittest.main()
