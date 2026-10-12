"""Isolated CLI installation smoke test; no credentials or paid requests."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

binary = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="sessionkit-smoke-") as folder:
    home = Path(folder)
    env = dict(os.environ, HOME=folder, SHELL="/bin/bash")
    for key in ("TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "SESSIONKIT_OP_REFERENCE", "ZDOTDIR", "SESSIONKIT_PROVIDER", "SESSIONKIT_PRICE_PER_MILLION"):
        env.pop(key, None)

    def run(*args):
        return subprocess.run([binary, *args], env=env, check=True,
                              capture_output=True, text=True).stdout

    projects = home / ".claude" / "projects" / "fixture"
    projects.mkdir(parents=True)
    (projects / "session.jsonl").write_text(json.dumps({
        "type": "assistant", "timestamp": "2026-10-10T10:00:00Z",
        "message": {"id": "smoke", "model": "claude-sonnet-4-6", "content": [],
                    "usage": {"input_tokens": 1, "output_tokens": 1}}
    }) + "\n")
    run("--help")
    run("usage", "--json")
    settings = home / ".claude" / "settings.json"
    settings.parent.mkdir(exist_ok=True)
    settings.write_text(json.dumps({"env": {"KEEP_ME": "yes"}}))
    run("setup", "--force")
    installed = json.loads(settings.read_text())
    assert installed["env"]["KEEP_ME"] == "yes"
    assert "sessionkit" in installed["statusLine"]["command"]
    run("setup", "--force")
    assert json.loads(settings.read_text()) == installed, "setup is not idempotent"
    run("setup", "--remove")
    removed = json.loads(settings.read_text())
    assert removed["env"]["KEEP_ME"] == "yes"
    assert "statusLine" not in removed
    if sys.platform.startswith("linux"):
        helpers = home / "helpers"
        helpers.mkdir()
        helper = helpers / "secret-tool"
        helper.write_text('''#!/usr/bin/env python3
import os, pathlib, sys
assert "fixture-key" not in sys.argv, "Secret leaked in process arguments"
service = sys.argv[sys.argv.index("service") + 1]
account = sys.argv[sys.argv.index("account") + 1]
p = pathlib.Path(os.environ["HOME"]) / ("fake-keyring-" + service + "-" + account)
if sys.argv[1] == "store":
    p.write_text(sys.stdin.read())
elif sys.argv[1] == "lookup":
    if not p.exists(): sys.exit(1)
    print(p.read_text())
elif sys.argv[1] == "clear":
    p.unlink(missing_ok=True)
else:
    sys.exit(2)
''')
        helper.chmod(0o700)
        env["PATH"] = str(helpers) + os.pathsep + env["PATH"]
        subprocess.run([binary, "auth", "login", "--stdin"], input="fixture-key", env=env,
                       check=True, capture_output=True, text=True)
        assert "Linux Secret Service" in run("auth", "status")
        env["TYPESAFE_API_KEY"] = "environment-key"
        assert "TYPESAFE_API_KEY" in run("auth", "status")
        env.pop("TYPESAFE_API_KEY")
        run("auth", "logout")
        assert "not configured" in run("auth", "status")
        for argv in [("login", "--stdin"), ("login", "--stdin", "--provider", "openrouter")]:
            subprocess.run([binary, "auth", *argv], input="fixture-key", env=env,
                           check=True, capture_output=True, text=True)
        assert "Linux Secret Service" in run("auth", "status", "--provider", "openrouter")
        env["OPENROUTER_API_KEY"] = "environment-key"
        assert "OPENROUTER_API_KEY" in run("auth", "status", "--provider", "openrouter")
        env.pop("OPENROUTER_API_KEY")
        run("auth", "logout", "--provider", "openrouter")
        assert "not configured" in run("auth", "status", "--provider", "openrouter")
        assert "Linux Secret Service" in run("auth", "status"), "OpenRouter logout must not remove TypeSafe credentials"
        run("auth", "logout")
print("Portable CLI smoke test passed")
