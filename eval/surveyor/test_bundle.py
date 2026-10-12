"""Offline fixed-bundle and paid-dispatch safeguards. Network always mocked."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from bundle import QUESTIONS, ASSESSMENT, request, unpack
from run_bundle import FILES, prepare, execute


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"
        self.destination = Path(self.temp.name) / "private-results"
        for relative in FILES:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("<?php\n// Synthetic offline test, not LMNL source.\nclass Example {}\n")
        (self.root / ".env").write_text("NEVER_SEND_THIS")

    def response(self, body):
        return {"model": body["model"], "usage": {"input_tokens": 10}, "answers": {
            name: {"type": "choice", "choice": "none" if name.endswith("_evidence") else "not_demonstrated",
                   "probabilities": dict.fromkeys(question["criteria"], 1 / len(question["criteria"]))}
            for name, question in body["questions"].items()}}

    def test_bundle_is_fixed_and_windows_are_exact(self):
        text = "\n".join("line " + str(i) for i in range(75))
        body = request("file.php", text)
        self.assertEqual(len(QUESTIONS), 28)
        self.assertEqual(len(body["questions"]), 56)
        for passage in body["state"]["source"]["passages"].values():
            self.assertEqual(passage["text"], "\n".join(text.splitlines()[passage["start"] - 1:passage["end"]]))
        self.assertTrue(all(r["standing"] == "model_proposal_not_verified" for r in unpack(body, self.response(body))))

    def test_incomplete_and_unknown_answers_rejected(self):
        body = request("file.php", "code")
        answer = self.response(body)
        del answer["answers"]["B01"]
        with self.assertRaises(ValueError):
            unpack(body, answer)
        answer = self.response(body)
        answer["answers"]["B01_evidence"]["choice"] = "P999"
        with self.assertRaises(ValueError):
            unpack(body, answer)

    def test_prepare_does_not_access_credentials_or_network(self):
        with patch("run_bundle.credential", side_effect=AssertionError), patch("run_bundle.urlopen", side_effect=AssertionError):
            manifest = prepare(self.root, self.destination)
        self.assertEqual(set(manifest["source_files"]), set(FILES))
        self.assertLess(manifest["estimated_max_usd"], 0.02)
        self.assertNotIn("NEVER_SEND_THIS", "".join(p.read_text() for p in self.destination.glob("*.json")))
        with self.assertRaises(ValueError):
            prepare(self.root, self.destination)

    def test_changed_source_prevents_dispatch(self):
        prepare(self.root, self.destination)
        (self.root / FILES[0]).write_text("changed")
        with patch("run_bundle.credential", side_effect=AssertionError), patch("run_bundle.urlopen", side_effect=AssertionError):
            with self.assertRaisesRegex(ValueError, "source or request changed"):
                execute(self.root, self.destination)

    def test_three_batches_usage_and_no_retry(self):
        prepare(self.root, self.destination)
        def fake_urlopen(call, timeout):
            return io.BytesIO(json.dumps(self.response(json.loads(call.data))).encode())
        with patch("run_bundle.credential", return_value="fake"), patch("run_bundle.urlopen", side_effect=fake_urlopen) as network:
            with patch("builtins.print"):
                cost = execute(self.root, self.destination)
            self.assertEqual(network.call_count, 3)
            self.assertAlmostEqual(cost, 30 * 0.042 / 1e6)
            with self.assertRaisesRegex(ValueError, "already started"):
                execute(self.root, self.destination)
            self.assertEqual(network.call_count, 3)

    def test_missing_usage_stops_after_one_call(self):
        prepare(self.root, self.destination)
        def fake_urlopen(call, timeout):
            answer = self.response(json.loads(call.data))
            answer["usage"] = {}
            return io.BytesIO(json.dumps(answer).encode())
        with patch("run_bundle.credential", return_value="fake"), patch("run_bundle.urlopen", side_effect=fake_urlopen) as network:
            with self.assertRaisesRegex(ValueError, "missing usage"):
                execute(self.root, self.destination)
            self.assertEqual(network.call_count, 1)

    def test_uncertain_failure_stops_without_retry(self):
        prepare(self.root, self.destination)
        with patch("run_bundle.credential", return_value="fake"), patch("run_bundle.urlopen", side_effect=TimeoutError) as network:
            with self.assertRaisesRegex(RuntimeError, "without retry"):
                execute(self.root, self.destination)
            self.assertEqual(network.call_count, 1)
        failure = json.loads((self.destination / "failed-0.json").read_text())
        self.assertIsNone(failure["incurred_cost_usd"])


if __name__ == "__main__":
    unittest.main()
