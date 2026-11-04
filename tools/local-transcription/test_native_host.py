import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location("native_host", Path(__file__).with_name("native_host.py"))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class NativeHostTests(unittest.TestCase):
    def test_protocol_roundtrip_and_unicode(self):
        output = io.BytesIO()
        host.send_message(output, {"message": "caf\u00e9", "ok": True})
        output.seek(0)
        self.assertEqual(host.read_message(output), {"message": "caf\u00e9", "ok": True})
        self.assertIsNone(host.read_message(output))

    def test_protocol_rejects_bad_inputs(self):
        for data in (b"\0", struct.pack("<I", 70000), struct.pack("<I", 5) + b"{}",
                     struct.pack("<I", 2) + b"[]"):
            with self.subTest(data=data), self.assertRaises(ValueError):
                host.read_message(io.BytesIO(data))

    def test_url_scope(self):
        for url in ("https://stream.mux.com/file.m3u8?token=test",
                    "https://tenant.sharepoint.com/download?token=test",
                    "https://www.youtube.com/watch?v=12345678901"):
            self.assertEqual(host.validate_url(url), url)
        for url in ("http://stream.mux.com/file", "https://localhost/file", "https://127.0.0.1/",
                    "https://youtube.com.evil.example/", "file:///etc/passwd",
                    "https://user:secret@youtube.com/", "https://youtube.com:8443/"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                host.validate_url(url)

    def test_paths_and_windows_names(self):
        for name in ("../../bad:name", "CON", "NUL.txt", "", "Test.md"):
            output = host.safe_name(name)
            self.assertNotIn("/", output)
            self.assertNotIn("\\", output)
            self.assertNotIn(":", output)
            self.assertTrue(output)
        self.assertEqual(host.safe_name("Test.md"), "Test")
        for identifier in ("../escape", "", None):
            with self.assertRaises((ValueError, AttributeError, TypeError)):
                host.job_id(identifier)

    def test_status_ownership(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            host.write_json(directory / "request.json", {"origin": "chrome-extension://owner/"})
            host.write_json(directory / "status.json", {"state": "complete", "path": "output.md"})
            self.assertTrue(host.public_status(directory, "chrome-extension://owner/")["ok"])
            with self.assertRaises(ValueError):
                host.public_status(directory, "chrome-extension://other/")

    def test_start_validates_before_creating_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = {"jobs": temporary}
            message = {
                "command": "start", "id": str(uuid.uuid4()),
                "url": "https://stream.mux.com/audio.m3u8", "source": "https://pub.substack.com/p/post",
                "duration": 1356, "name": "Title", "format": "exe",
            }
            with self.assertRaises(ValueError):
                host.handle(message, "origin", config)
            self.assertEqual(list(Path(temporary).iterdir()), [])
            message.update(format="md", duration=float("inf"))
            with self.assertRaises(ValueError):
                host.handle(message, "origin", config)

    def test_worker_failure_is_persisted_and_signed_urls_are_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / str(uuid.uuid4())
            directory.mkdir()
            host.write_json(directory / "request.json", {
                "origin": "owner", "url": "https://stream.mux.com/audio.m3u8?secret=1",
                "source": "https://pub.substack.com/p/post", "duration": 1356,
                "name": "Title", "format": "md",
            })
            with patch.dict("sys.modules", {"transcribe": None}):
                host.work(directory.name, {"jobs": temporary})
            status = json.loads((directory / "status.json").read_text())
            self.assertEqual(status["state"], "failed")
            self.assertEqual(json.loads((directory / "request.json").read_text()), {"origin": "owner"})

    def test_errors_do_not_expose_signed_urls(self):
        message = host.clean_error(ValueError("Download failed https://stream.mux.com/file?secret=1"))
        self.assertNotIn("secret", message)
        self.assertIn("Download failed", message)

    def test_worker_full_output_collision_preview_rejection_and_cleanup(self):
        for format_, duration in (("md", 1356), ("vtt", 1356), ("md", 54)):
            with self.subTest(format=format_, duration=duration), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                directory = root / str(uuid.uuid4())
                directory.mkdir()
                downloads = root / "downloads"
                downloads.mkdir()
                existing = downloads / f"Title.{format_}"
                existing.write_text("existing transcript", encoding="utf-8")
                host.write_json(directory / "request.json", {
                    "origin": "owner", "url": "https://stream.mux.com/audio.m3u8?secret=1",
                    "source": "https://pub.substack.com/p/post", "duration": 1356,
                    "name": "Title", "format": format_,
                })
                media_paths = []

                def download(args, **kwargs):
                    media = Path(args[args.index("-o") + 1].replace("%(ext)s", "mp4"))
                    media.write_bytes(b"downloaded audio")
                    media_paths.append(media)
                    return SimpleNamespace(returncode=0, stdout=str(media), stderr="")

                def transcribe(media, model, language, output, vtt, md, *, progress, source_name):
                    self.assertEqual(source_name, "https://pub.substack.com/p/post")
                    self.assertEqual((vtt, md), (format_ == "vtt", format_ == "md"))
                    progress(0, duration)
                    progress(duration, duration)
                    rendered = output / f"audio.{format_}"
                    rendered.write_text("full transcript", encoding="utf-8")
                    return (rendered, None) if vtt else (None, rendered)

                config = {"jobs": temporary, "downloads": str(downloads), "model": "small"}
                with patch.object(host.subprocess, "run", side_effect=download), \
                        patch.dict("sys.modules", {"transcribe": SimpleNamespace(transcribe=transcribe)}):
                    host.work(directory.name, config)
                status = json.loads((directory / "status.json").read_text())
                self.assertEqual(existing.read_text(), "existing transcript")
                if duration == 1356:
                    self.assertEqual(status["state"], "complete")
                    self.assertEqual(Path(status["path"]).name, f"Title (1).{format_}")
                    self.assertEqual(Path(status["path"]).read_text(), "full transcript")
                else:
                    self.assertEqual(status["state"], "failed")
                    self.assertIn("preview", status["message"])
                    self.assertEqual(len(list(downloads.iterdir())), 1)
                self.assertTrue(media_paths)
                self.assertFalse(media_paths[0].parent.exists())
                self.assertEqual(json.loads((directory / "request.json").read_text()), {"origin": "owner"})


if __name__ == "__main__":
    unittest.main()
