"""Offline ledger contracts; no semantic-quality assertions or model calls."""
import copy
import tempfile
import unittest
import subprocess
import sys
from pathlib import Path
from explore import apply, initial


class ExplorationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "cache.py").write_text("def key(identity, revision):\n    return identity, revision\n")
        (self.root / "store.py").write_text("def put(identity):\n    revision = 0\n    return revision\n")
        self.state = initial(self.root)

    def request(self, anchor="revision", **extra):
        return {"questions": [{"text": "What identifies the cached payload?", "anchors": [anchor]}], **extra}

    def test_incremental_question_and_focus(self):
        first, result = apply(self.state, self.root, self.request())
        self.assertTrue(first["nodes"])
        node = next(n for n, value in first["nodes"].items() if value["path"] == "store.py")
        second, _ = apply(first, self.root, self.request("identity", focus=[node]))
        self.assertEqual(second["usage"]["requests"], 2)
        self.assertEqual(second["usage"]["files"] - first["usage"]["files"], 1)
        self.assertEqual(first["questions"][result["question_ids"][0]]["status"], "open")
        self.assertEqual(self.state["nodes"], {})

    def test_duplicate_evidence_not_charged_twice(self):
        first, _ = apply(self.state, self.root, self.request())
        second, _ = apply(first, self.root, self.request())
        self.assertEqual(first["usage"]["source_bytes"], second["usage"]["source_bytes"])

    def test_changed_inspected_source_rejects_followup(self):
        state, _ = apply(self.state, self.root, self.request())
        (self.root / "store.py").write_text("changed\n")
        with self.assertRaisesRegex(ValueError, "source changed"):
            apply(state, self.root, self.request())

    def test_fabricated_quote_rejected(self):
        state, _ = apply(self.state, self.root, self.request())
        next(iter(state["nodes"].values()))["quote"] = "fabricated"
        with self.assertRaisesRegex(ValueError, "invalid evidence"):
            apply(state, self.root, self.request())

    def test_budget_limits_mark_truncation_not_absence(self):
        self.state["limits"]["source_bytes"] = 1
        state, result = apply(self.state, self.root, self.request())
        self.assertTrue(result["truncated"])
        self.assertEqual(state["nodes"], {})
        self.assertTrue(all(q["status"] == "open" for q in state["questions"].values()))
        self.state["limits"]["scan_bytes"] = 1
        state, result = apply(self.state, self.root, self.request())
        self.assertEqual(state["usage"]["scan_bytes"], 0)
        self.assertTrue(result["truncated"])

    def test_unknown_focus_is_transactional(self):
        before = copy.deepcopy(self.state)
        with self.assertRaises(ValueError):
            apply(self.state, self.root, self.request(focus=["missing"]))
        self.assertEqual(before, self.state)

    def test_symlinks_and_sensitive_names_excluded(self):
        (self.root / ".env.production").write_text("revision=secret")
        (self.root / "alias.py").symlink_to(self.root / "cache.py")
        state, _ = apply(self.state, self.root, self.request())
        self.assertEqual(set(state["files"]), {"cache.py", "store.py"})

    def test_request_limit(self):
        self.state["usage"]["requests"] = self.state["limits"]["requests"]
        with self.assertRaisesRegex(ValueError, "request limit"):
            apply(self.state, self.root, self.request())

    def test_proposals_never_become_verified_edges(self):
        state, result = apply(self.state, self.root, self.request())
        nodes = list(state["nodes"])
        state, _ = apply(state, self.root, {"action": "record", "proposal": {
            "question_id": result["question_ids"][0], "claim": "Possible identity lifecycle collision",
            "evidence": nodes, "relation": "candidate_dependency", "endpoints": nodes[:2]}})
        self.assertEqual(state["proposals"][0]["standing"], "unverified_proposal")
        self.assertEqual(state["semantic_validation"], "not performed")

    def test_unresolved_evidence_and_cross_root_rejected(self):
        state, result = apply(self.state, self.root, self.request())
        with self.assertRaisesRegex(ValueError, "source evidence"):
            apply(state, self.root, {"action": "record", "proposal": {
                "question_id": result["question_ids"][0], "claim": "Claim", "evidence": ["missing"]}})
        with tempfile.TemporaryDirectory() as elsewhere:
            with self.assertRaisesRegex(ValueError, "root changed"):
                apply(state, elsewhere, self.request())

    def test_question_treatment_requires_explicit_native_profile(self):
        runner = Path(__file__).with_name("run.py")
        result = subprocess.run([sys.executable, "-B", str(runner), "--variant", "survey",
                                 "--strategy", "questions", "--tool-profile", "none"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("question-led treatment requires", result.stderr)

    def test_nonmatch_is_not_absence(self):
        state, result = apply(self.state, self.root, self.request("not_present"))
        self.assertFalse(state["nodes"])
        self.assertEqual(state["questions"][result["question_ids"][0]]["status"], "open")


if __name__ == "__main__":
    unittest.main()
