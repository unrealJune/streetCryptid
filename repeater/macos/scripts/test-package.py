#!/usr/bin/env python3
"""Offline release gates: failed signing/notarization must never produce a feed."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sc-macos-package-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        scripts = self.root / "repeater/macos/scripts"
        scripts.mkdir(parents=True)
        shutil.copy(Path(__file__).with_name("package.sh"), scripts / "package.sh")
        self.script = scripts / "package.sh"
        self.app = self.root / "repeater/macos/artifacts/universal/streetCryptid Repeater.app"
        self.app.joinpath("Contents").mkdir(parents=True)
        with self.app.joinpath("Contents/Info.plist").open("wb") as file:
            plistlib.dump({"CFBundleVersion": "1.2.3", "SUPublicEDKey": "test-key"}, file)
        framework = self.app / "Contents/Frameworks/Sparkle.framework/Versions/B"
        for name in ["Downloader", "Installer"]:
            (framework / f"XPCServices/{name}.xpc").mkdir(parents=True)
        tools = self.root / "repeater/macos/.build/artifacts/sparkle/Sparkle/bin"
        tools.mkdir(parents=True)
        stub = self.root / "stub.py"
        stub.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(json.dumps([tool, *args]) + "\\n")
if tool == os.environ.get("FAIL_TOOL"):
    sys.exit(1)
if tool == "ditto":
    pathlib.Path(args[-1]).write_bytes(b"test archive")
elif tool == "git":
    for arg in args:
        if arg.startswith("--output="):
            pathlib.Path(arg.split("=", 1)[1]).write_bytes(b"test source")
elif tool == "generate_appcast":
    pathlib.Path(args[-1], "appcast.xml").write_text("<rss/>")
""")
        stub.chmod(0o755)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name in ["codesign", "lipo", "ditto", "xcrun", "spctl", "git"]:
            (bin_dir / name).symlink_to(stub)
        (tools / "generate_appcast").symlink_to(stub)
        self.log = self.root / "calls"
        self.env = dict(
            os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}",
            CALL_LOG=str(self.log), MACOS_SIGN_IDENTITY="test-identity",
            MACOS_NOTARY_PROFILE="test-notary", MACOS_SPARKLE_PUBLIC_KEY="test-key",
            MACOS_SPARKLE_PRIVATE_KEY_FILE=str(self.root / "test-key"),
        )
        self.feed = self.root / "repeater/macos/artifacts/release-1.2.3/appcast.xml"

    def run_package(self):
        return subprocess.run(
            ["bash", str(self.script), "1.2.3"], env=self.env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ).returncode

    def test_notarization_failure_stops_before_feed(self):
        self.env["FAIL_TOOL"] = "xcrun"
        self.assertNotEqual(self.run_package(), 0)
        self.assertFalse(self.feed.exists())

    def test_signing_failure_stops_before_notarization(self):
        self.env["FAIL_TOOL"] = "codesign"
        self.assertNotEqual(self.run_package(), 0)
        calls = self.log.read_text()
        self.assertNotIn("notarytool", calls)
        self.assertFalse(self.feed.exists())

    def test_missing_update_key_cannot_publish_unsigned_fallback(self):
        self.env.pop("MACOS_SPARKLE_PUBLIC_KEY")
        self.assertNotEqual(self.run_package(), 0)
        self.assertFalse(self.log.exists())

    def test_success_staples_and_assesses_before_signing_feed(self):
        self.assertEqual(self.run_package(), 0)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        feed_index = next(i for i, call in enumerate(calls) if call[0] == "generate_appcast")
        for prefix in [
            ["xcrun", "notarytool", "submit"],
            ["xcrun", "stapler", "staple"],
            ["xcrun", "stapler", "validate"],
            ["spctl", "--assess"],
        ]:
            self.assertTrue(any(call[:len(prefix)] == prefix for call in calls[:feed_index]))
        self.assertTrue(self.feed.exists())
        sign_calls = [call for call in calls if call[0] == "codesign" and "--sign" in call]
        self.assertEqual(sign_calls[-1][-1], str(self.app))
        self.assertNotIn("--deep", sign_calls[-1])


if __name__ == "__main__":
    unittest.main()
