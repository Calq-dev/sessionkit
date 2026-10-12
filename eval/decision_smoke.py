"""HTTP contract tests for a binary built with --features test-api. No paid calls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

requests = []
backend = "jev"
invalid = False

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append((backend, body))
        assert self.headers["Authorization"] == "Bearer fixture-key"
        qs = body["questions"]
        if isinstance(qs, list):
            questions = [(q["name"], q) for q in qs]
            assert body["input"][0]["content"][0]["type"] == "input_text"
        else:
            questions = qs.items()
            assert "state" in body
        answers = {}
        for name, q in questions:
            if q["type"] in ("noul", "predicate"):
                answers[name] = {"type": "noul", "noul": 0.9}
            else:
                if backend == "decisions":
                    assert all(isinstance(c["description"], str) for c in q["choices"])
                choices = list(q["criteria"]) if "criteria" in q else [c["value"] for c in q["choices"]]
                answers[name] = {"type": "choice", "choice": choices[0],
                                 "probabilities": {v: 1.0 if i == 0 else 0.0 for i, v in enumerate(choices)}, "confidence": 0.9}
        if invalid:
            answers = {}
        data = {"answers": answers, "usage": {"input_tokens": 25}, "model": "fixture"}
        if backend == "decisions":
            data["answers"] = [dict(a, name=n) for n, a in answers.items()]
        if backend == "clef":
            data = {"success": True, "result": data}
        reply = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

binary = str(Path(sys.argv[1]).resolve())
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix="sessionkit-decision-") as folder:
        source = Path(folder) / "fixture.py"
        source.write_text("def retry_upload():\n    return True\n")
        env = dict(os.environ, HOME=folder, SESSIONKIT_API=f"http://127.0.0.1:{server.server_port}",
                   TYPESAFE_API_KEY="fixture-key", OPENROUTER_API_KEY="fixture-key", OPENAI_API_KEY="fixture-key", CLOUDFLARE_AUTH_TOKEN="fixture-key",
                   CLOUDFLARE_ACCOUNT_ID="fixture", SESSIONKIT_MODEL="fixture")
        for backend in ("jev", "openrouter", "decisions", "clef"):
            env["SESSIONKIT_PROVIDER"] = backend
            for args in [("ask", str(source), "Does it retry?"),
                         ("ask", str(source), "What does it do?", "--options", "retry,stop"),
                         ("grep", "Where are uploads retried?", folder)]:
                before = len(requests)
                result = subprocess.run([binary, *args], env=env, capture_output=True, text=True)
                assert result.returncode == 0, (backend, args, result.stderr)
                assert len(requests) > before, "Each provider must issue its own requests, not reuse another provider's cache"
            assert any(p == backend for p, _ in requests)
        # A credential-free user preference changes routing without a shell export.
        config = Path(folder) / ".config" / "sessionkit" / "decision.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"provider": "openrouter", "model": "~typesafe/jev-latest"}))
        backend = "openrouter"
        env.pop("SESSIONKIT_PROVIDER")
        env.pop("SESSIONKIT_MODEL")
        result = subprocess.run([binary, "ask", str(source), "Does it retry?"], env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        assert requests[-1][1]["model"] == "~typesafe/jev-latest"
        backend = "decisions"
        env["SESSIONKIT_PROVIDER"] = "decisions"
        result = subprocess.run([binary, "ask", str(source), "Does it retry?"], env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        assert requests[-1][1]["model"] == "gpt-6-luna", "Provider override must not inherit the OpenRouter model"
        env.pop("SESSIONKIT_PROVIDER")
        config.write_text("not json")
        before = len(requests)
        result = subprocess.run([binary, "ask", str(source), "Does it retry?"], env=env, capture_output=True, text=True)
        assert result.returncode != 0 and len(requests) == before, "Invalid config must fail closed"
        config.unlink()
        before = len(requests)
        env["SESSIONKIT_PROVIDER"] = "decisions"
        env.pop("OPENAI_API_KEY")
        result = subprocess.run([binary, "ask", str(source), "Does it retry?"], env=env, capture_output=True, text=True)
        assert result.returncode != 0 and len(requests) == before, "Missing selected credentials must not fall back to TypeSafe"
        env["OPENAI_API_KEY"] = "fixture-key"
        invalid = True
        result = subprocess.run([binary, "ask", str(source), "Does it retry?"], env=env, capture_output=True, text=True)
        assert result.returncode != 0, "Missing provider answers must not silently become false"
        before = len(requests)
        env["SESSIONKIT_PROVIDER"] = "unknown"
        result = subprocess.run([binary, "ask", str(source), "Does it retry?"], env=env, capture_output=True, text=True)
        assert result.returncode != 0 and len(requests) == before, "Unknown provider must not fall back"
finally:
    server.shutdown()
    server.server_close()
print("Decision provider HTTP contract tests passed (not live API verification)")
