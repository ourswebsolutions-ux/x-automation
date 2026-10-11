"""Real CDP integration: needs a Chromium started with --remote-debugging-port.

Set AXORA_TEST_CDP_ENDPOINT=http://127.0.0.1:<port>. scripts/test-engine.mjs
starts a real Chrome/Chromium for this. Without the variable the test is skipped
— it never fakes a browser.
"""
import os
import tempfile
import unittest

from helpers import EngineProcess

ENDPOINT = os.environ.get("AXORA_TEST_CDP_ENDPOINT")


@unittest.skipUnless(ENDPOINT, "AXORA_TEST_CDP_ENDPOINT not set (no real browser to attach to)")
class CdpIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = EngineProcess()

    def tearDown(self):
        self.engine.close()

    def test_check_connects_and_disconnects_without_closing_browser(self):
        first = self.engine.call("browser.check", {"endpoint": ENDPOINT})
        self.assertTrue(first["ok"], first)
        self.assertGreaterEqual(first["result"]["contexts"], 1)
        second = self.engine.call("browser.check", {"endpoint": ENDPOINT})
        self.assertTrue(second["ok"], "browser must still be running after the first disconnect")

    def test_self_test_drives_controlled_page_in_existing_context(self):
        shots = tempfile.mkdtemp(prefix="axora-shots-")
        reply = self.engine.call("browser.selfTest", {"endpoint": ENDPOINT, "screenshotDir": shots})
        self.assertTrue(reply["ok"], reply)
        result = reply["result"]
        self.assertTrue(result["ok"])
        self.assertTrue(result["usedExistingContext"])
        self.assertEqual(result["pagesBefore"], result["pagesAfter"], "only the test tab may be opened and closed")
        names = [s["step"] for s in result["steps"]]
        self.assertEqual(names, ["connect", "open-tab", "navigate", "interact", "screenshot", "close-tab"])
        files = os.listdir(shots)
        self.assertEqual(len(files), 1)
        with open(os.path.join(shots, files[0]), "rb") as f:
            self.assertEqual(f.read(8), b"\x89PNG\r\n\x1a\n")


if __name__ == "__main__":
    unittest.main()
