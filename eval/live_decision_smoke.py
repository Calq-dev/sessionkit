"""Opt-in, paid synthetic CLI checks through a bounded local HTTP proxy.
Build with test-api; supply provider credentials via the environment. No real code
or transcripts are sent. Cost guards use conservative input-byte estimates and
research prices, not billing guarantees. No proxy-side retries.
"""
import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary")
parser.add_argument("--yes-paid", action="store_true")
parser.add_argument("--max-cost", type=float, default=0.05)
parser.add_argument("--report", type=Path, required=True)
parser.add_argument("--providers", nargs="+", choices=["clef", "decisions"], default=["clef", "decisions"])
args = parser.parse_args()
if not args.yes_paid or not 0 < args.max_cost <= 1:
    parser.error("Requires --yes-paid and a budget greater than zero and at most $1")
binary = str(Path(args.binary).resolve())
providers = {
    "clef": {"key": os.environ["CLOUDFLARE_AUTH_TOKEN"], "model": "clef", "price": 0.24,
             "url": "https://api.cloudflare.com/client/v4/accounts/" + os.environ["CLOUDFLARE_ACCOUNT_ID"] + "/ai/run/@cf/cloudflare/clef"},
    "decisions": {"key": os.environ["OPENAI_API_KEY"], "model": "gpt-6-luna", "price": 0.10,
                  "url": "https://api.openai.com/v1/decisions"},
}
selected = "clef"
lock = threading.Lock()
events = []
reserved_cost = 0.0
halted = False
report = {"synthetic_only": True, "budget_usd": args.max_cost, "costs_are_estimates": True, "runs": []}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        global reserved_cost, halted
        p = providers[selected]
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 8000:
            self.send_error(400, "Synthetic request-size limit exceeded")
            return
        body = self.rfile.read(length)
        if self.headers.get("Authorization") != "Bearer " + p["key"]:
            self.send_error(400, "Unexpected provider credential")
            return
        # One token per UTF-8 byte is deliberately conservative for this fixture.
        reserve = length / 1e6 * p["price"]
        with lock:
            if halted or len(events) >= 24 or reserved_cost + reserve > args.max_cost:
                self.send_error(400, "Request count or estimated budget limit exceeded")
                return
            reserved_cost += reserve
            event = {"provider": selected, "input_bytes": length, "reserved_estimate_usd": reserve}
            events.append(event)
        request = urllib.request.Request(p["url"], data=body,
                    headers={"Authorization": "Bearer " + p["key"], "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                reply = response.read(65536)
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
            detail = error.read(8000).decode(errors="replace")
            for provider in providers.values():
                detail = detail.replace(provider["key"], "[redacted]")
            event["provider_error"] = detail
            reply = json.dumps({"error": {"message": "Live provider HTTP " + str(status)}}).encode()
        except Exception as error:
            status = 502
            reply = json.dumps({"error": {"message": type(error).__name__}}).encode()
        event["status"] = status
        if status != 200:
            # Existing callers may retry; after a live failure, do not forward
            # any further attempts to the paid API during this run.
            with lock:
                halted = True
        if status == 200:
            data = json.loads(reply)
            event["response"] = data  # synthetic answers only; no real source or credentials
            event["request"] = json.loads(body)
            usage = data.get("usage") or data.get("result", {}).get("usage", {})
            event["input_tokens"] = usage.get("input_tokens")
            if event["input_tokens"] is not None:
                event["usage_estimate_usd"] = event["input_tokens"] / 1e6 * p["price"]
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix="sessionkit-live-synthetic-") as folder:
        root = Path(folder)
        code = root / "code"
        code.mkdir()
        retry = code / "upload.py"
        retry.write_text('''def upload_with_retry(send, payload):
    """Retry a failed upload at most twice. Never delete files."""
    for attempt in range(3):
        try:
            return send(payload)
        except ConnectionError:
            if attempt == 2:
                raise
''')
        (code / "display.py").write_text('''def display_name(person):
    """Format a name. No network or upload operations."""
    return person["name"].upper()
''')
        for selected in args.providers:
            p = providers[selected]
            home = root / selected
            home.mkdir()
            env = dict(os.environ, HOME=str(home), SESSIONKIT_PROVIDER=selected, SESSIONKIT_MODEL=p["model"],
                       SESSIONKIT_API=f"http://127.0.0.1:{server.server_port}")
            env.pop("SESSIONKIT_OP_REFERENCE", None)
            checks = [
                ("predicate-choice", ["ask", str(retry), "Does this function retry failed uploads?",
                  "Does this function delete files?", "How does it handle failed uploads?", "--options", "retry,delete"]),
                ("code-search", ["grep", "Where are failed uploads retried?", str(code), "--no-cache", "--agent-view"]),
            ]
            for name, command in checks:
                result = subprocess.run([binary, *command], env=env, capture_output=True, text=True, timeout=120)
                stdout, stderr = result.stdout, result.stderr
                for provider in providers.values():
                    stdout = stdout.replace(provider["key"], "[redacted]")
                    stderr = stderr.replace(provider["key"], "[redacted]")
                if name == "predicate-choice":
                    yes = re.search(r"(?m)^([0-9.]+)  Does this function retry failed uploads\?", stdout)
                    no = re.search(r"(?m)^([0-9.]+)  Does this function delete files\?", stdout)
                    choice = re.search(r"(?m)^([0-9.]+)  retry  ", stdout)
                    oracle = bool(yes and no and choice and float(yes[1]) >= 0.7 and float(no[1]) <= 0.3 and float(choice[1]) >= 0.7)
                else:
                    oracle = '"upload.py"' in stdout and '"display.py"' not in stdout and "Search status: complete." in stdout
                report["runs"].append({"provider": selected, "check": name, "exit_code": result.returncode,
                                       "oracle_passed": oracle, "stdout": stdout, "stderr": stderr})
                if result.returncode or not oracle:
                    raise RuntimeError(selected + " " + name + " failed; see synthetic report")
finally:
    server.shutdown()
    server.server_close()
    report["requests"] = events
    report["reserved_estimate_usd"] = reserved_cost
    report["usage_estimate_usd"] = sum(e.get("usage_estimate_usd", 0) for e in events)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
print("Synthetic live CLI checks completed:", len(events), "requests; usage-based research-price estimate $" +
      format(report["usage_estimate_usd"], ".6f"))
