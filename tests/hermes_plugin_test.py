"""The Hermes plugin link must only run the closed operation list on loopback."""
import asyncio
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("wabotia_link", Path(__file__).parents[1] / "public/hermes-plugin/link.py")
link = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(link)

JOB = "11111111-2222-3333-4444-555555555555"


class Response:
    def __init__(self, status=200, data=None, content=b"", headers=None):
        self.status_code, self._data, self.content, self.headers = status, data, content, headers or {}

    def json(self):
        if self._data is None:
            raise ValueError("no json")
        return self._data


class Http:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / ".env").write_text("API_SERVER_KEY=default-key-0000000000\n")
        (self.root / "profiles" / "wabotia").mkdir(parents=True)
        (self.root / "profiles" / "wabotia" / ".env").write_text('export API_SERVER_KEY="profile-key-000000000"\n')
        (self.root / "profiles" / "rascunho").mkdir()

    def make(self, *replies):
        http = Http(replies)
        return link.WabotiaLink("https://wabotia.example.com", "wabl_token", http, root=self.root), http

    def run_job(self, worker, **job):
        return asyncio.run(worker.execute({"id": JOB, "deadline_ms": 12000, **job}))

    def test_rejects_unsafe_addresses(self):
        for url in ["http://wabotia.example.com", "https://user@x.example.com", "https://x.example.com/path", ""]:
            with self.assertRaises(ValueError):
                link.WabotiaLink(url, "t", Http([]), root=self.root)
        with self.assertRaises(ValueError):
            link.WabotiaLink("https://x.example.com", "t", Http([]), api_base="http://10.0.0.5:8642", root=self.root)

    def test_lists_profiles_without_exposing_keys(self):
        worker, http = self.make()
        result = self.run_job(worker, op="profiles.list")
        self.assertEqual(result["body"]["profiles"], [
            {"name": "default", "display_name": "default", "api_enabled": True},
            {"name": "rascunho", "display_name": "rascunho", "api_enabled": False},
            {"name": "wabotia", "display_name": "wabotia", "api_enabled": True},
        ])
        self.assertEqual(http.calls, [])
        self.assertNotIn("key", str(result))

    def test_creates_run_on_profile_prefix_with_local_key(self):
        worker, http = self.make(Response(200, {"run_id": "run_1"}))
        result = self.run_job(worker, op="runs.create", profile="wabotia", body={"input": "oi"}, idempotency_key="wabotia:1")
        self.assertEqual(result, {"ok": True, "http_status": 200, "body": {"run_id": "run_1"}})
        method, url, kwargs = http.calls[0]
        self.assertEqual((method, url), ("POST", "http://127.0.0.1:8642/p/wabotia/v1/runs"))
        self.assertEqual(kwargs["headers"], {"Authorization": "Bearer profile-key-000000000", "Idempotency-Key": "wabotia:1"})
        self.assertEqual(kwargs["json"], {"input": "oi"})

    def test_forwards_session_key_and_drops_invalid_ones(self):
        worker, http = self.make(Response(200, {"run_id": "run_1"}), Response(200, {"run_id": "run_2"}))
        self.run_job(worker, op="runs.create", profile="wabotia", body={"input": "oi"}, session_key="wabotia:p:b:conv:c1")
        self.assertEqual(http.calls[0][2]["headers"]["X-Hermes-Session-Key"], "wabotia:p:b:conv:c1")
        self.run_job(worker, op="runs.create", profile="wabotia", body={"input": "oi"}, session_key="linha1\nlinha2")
        self.assertNotIn("X-Hermes-Session-Key", http.calls[1][2]["headers"])

    def test_default_profile_has_no_prefix_and_stop_posts(self):
        worker, http = self.make(Response(200, {"status": "running"}), Response(200, {}))
        self.run_job(worker, op="runs.get", run_id="run_1")
        self.run_job(worker, op="runs.stop", run_id="run_1")
        self.assertEqual([(c[0], c[1]) for c in http.calls], [
            ("GET", "http://127.0.0.1:8642/v1/runs/run_1"),
            ("POST", "http://127.0.0.1:8642/v1/runs/run_1/stop"),
        ])

    def test_refuses_unknown_operations_profiles_and_ids(self):
        worker, http = self.make()
        self.assertEqual(self.run_job(worker, op="shell.exec")["code"], "bad_op")
        self.assertEqual(self.run_job(worker, op="runs.get", run_id="../../etc")["code"], "bad_op")
        self.assertEqual(self.run_job(worker, op="capabilities.get", profile="../x")["code"], "bad_profile")
        self.assertEqual(self.run_job(worker, op="capabilities.get", profile="ausente")["code"], "bad_profile")
        self.assertEqual(self.run_job(worker, op="capabilities.get", profile="rascunho")["code"], "local_unauthorized")
        self.assertEqual(http.calls, [])

    def test_maps_local_failures(self):
        worker, _ = self.make(Response(500, {}), ConnectionError("down"), TimeoutError("slow"))
        self.assertEqual(self.run_job(worker, op="capabilities.get"), {"ok": False, "http_status": 500, "code": "local_error"})
        self.assertEqual(self.run_job(worker, op="capabilities.get")["code"], "local_unreachable")
        self.assertEqual(self.run_job(worker, op="capabilities.get")["code"], "timeout")

    def test_artifact_is_uploaded_once_and_not_reported(self):
        worker, http = self.make(Response(200, content=b"documento", headers={"Content-Type": "text/plain"}), Response(200, {}))
        result = self.run_job(worker, op="artifacts.download", profile="wabotia", artifact_id="artifact-12345")
        self.assertIsNone(result)
        method, url, kwargs = http.calls[1]
        self.assertEqual((method, url), ("PUT", f"https://wabotia.example.com/api/hermes-link/artifacts/{JOB}"))
        self.assertEqual(kwargs["content"], b"documento")
        self.assertEqual(kwargs["headers"]["Content-Type"], "text/plain")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer wabl_token")

    def test_artifact_upload_failure_is_not_retried(self):
        worker, http = self.make(Response(200, content=b"x"), ConnectionError("down"))
        self.assertEqual(self.run_job(worker, op="artifacts.download", artifact_id="artifact-12345")["code"], "upload_failed")
        self.assertEqual(len(http.calls), 2)

    def test_redelivered_job_repeats_the_result_without_running_again(self):
        worker, http = self.make(Response(200, {"run_id": "run_1"}), Response(200, {}), Response(200, {}))
        job = {"id": JOB, "op": "runs.create", "body": {"input": "oi"}, "deadline_ms": 12000}
        asyncio.run(worker.handle(job))
        asyncio.run(worker.handle(job))
        self.assertEqual([c[1].rsplit("/", 1)[-1] for c in http.calls], ["runs", "results", "results"])
        self.assertEqual(http.calls[1][2]["json"], http.calls[2][2]["json"])

    def test_loop_stops_when_token_is_revoked(self):
        worker, http = self.make(Response(200, {"jobs": []}), Response(401, {}))
        asyncio.run(worker.run())
        self.assertTrue(worker.revoked)
        self.assertEqual(len(http.calls), 2)


if __name__ == "__main__":
    unittest.main()
