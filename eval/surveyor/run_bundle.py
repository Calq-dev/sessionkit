"""Explicitly paid, three-file bundle pilot. Default prepares requests offline.

Only the three allowlisted PHP files are sent. Never reads repository credentials,
research exports, tests or user data. Private artifacts outside both repositories.
No retries, no SDK retry machinery, no Claude calls, no project writes.
"""
import argparse
import hashlib
import json
import math
import os
import subprocess
import time
from pathlib import Path
from urllib.request import Request, urlopen
from bundle import QUESTIONS, fingerprint, request, unpack

FILES = ["app/Frameworks/Lifecycle.php", "app/Frameworks/Revisions.php", "app/Frameworks/DraftContent.php"]
PRICE = 0.042  # Local SessionKit tariff assumption, USD/M input tokens; not billing.
CAP = 0.02
REVIEW = {
    FILES[0]: {q: "supported" for q in ["B01", "B02", "V01", "V02", "V03", "V04", "V05", "V06", "V07"]},
    FILES[1]: {q: "supported" for q in ["B02", "B11", "V08", "V09", "V10", "V11"]},
    FILES[2]: {**{q: "supported" for q in ["B03", "B05", "B06", "B14", "B15"]}, "V12": "contradicted"},
}
for expectations in REVIEW.values():
    expectations["B12"] = "not_demonstrated"


def save(path, value):
    # Artifacts contain private source: never publish the raw files.
    with path.open("w", encoding="utf-8") as out:
        path.chmod(0o600)
        json.dump(value, out, indent=2)


def approved_source(root, relative):
    path = root / relative
    if any((root / Path(*Path(relative).parts[:i])).is_symlink()
           for i in range(1, len(Path(relative).parts) + 1)):
        raise ValueError("symlink source")
    path.resolve(strict=True).relative_to(root)
    return path


def prepare(root, destination):
    root = root.resolve(strict=True)
    requests, manifest = [], {"root": str(root), "model": "jev-1.13.0", "price_assumption_usd_per_M_input": PRICE,
        "cap_estimate_usd": CAP, "source_files": {}, "review_expectations": REVIEW,
        "review_status": "assistant-selected source review, not independent gold",
        "protocol_sha256": fingerprint(QUESTIONS), "planned_requests": 3,
        "questions_per_request": 56, "estimated_tokens_per_byte": 1,
        "cost_basis": "conservative one input token per serialized UTF-8 byte at local tariff; not a provider cap"}
    for index, relative in enumerate(FILES):
        raw = approved_source(root, relative).read_bytes()
        body = request(relative, raw.decode("utf-8"))
        payload = json.dumps(body).encode()
        manifest["source_files"][relative] = {"sha256": hashlib.sha256(raw).hexdigest(),
            "source_bytes": len(raw), "request_sha256": fingerprint(body), "request_bytes": len(payload),
            "reserved_usd": len(payload) * PRICE / 1e6}
        requests.append(body)
    manifest["estimated_max_usd"] = sum(v["reserved_usd"] for v in manifest["source_files"].values())
    if manifest["estimated_max_usd"] > CAP:
        raise ValueError("planned requests exceed approved cost estimate")
    if destination.exists():
        raise ValueError("use a fresh artifact directory; do not overwrite a previous run")
    destination.mkdir(mode=0o700, parents=True)
    for index, body in enumerate(requests):
        save(destination / f"request-{index}.json", body)
    save(destination / "manifest.json", manifest)
    return manifest


def credential():
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        return key
    for service in ["sessionkit", "jev-start"]:
        result = subprocess.run(["security", "find-generic-password", "-s", service,
                                 "-a", "TYPESAFE_API_KEY", "-w"], capture_output=True, text=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    raise ValueError("no existing TypeSafe credential; do not read LMNL .env")


def execute(root, destination):
    root = root.resolve(strict=True)
    manifest = json.loads((destination / "manifest.json").read_text())
    if (manifest.get("root") != str(root) or manifest["protocol_sha256"] != fingerprint(QUESTIONS)
            or manifest["source_files"].keys() != dict.fromkeys(FILES).keys()
            or manifest["price_assumption_usd_per_M_input"] != PRICE
            or manifest["planned_requests"] != 3):
        raise ValueError("prepared plan does not match the approved pilot")
    bodies = [json.loads((destination / f"request-{i}.json").read_text()) for i in range(3)]
    for relative, body in zip(FILES, bodies):
        raw = approved_source(root, relative).read_bytes()
        entry = manifest["source_files"][relative]
        if (hashlib.sha256(raw).hexdigest() != entry["sha256"]
                or fingerprint(body) != entry["request_sha256"]
                or fingerprint(body) != fingerprint(request(relative, raw.decode("utf-8")))):
            raise ValueError("source or request changed after preparation")
    reservations = [len(json.dumps(body).encode()) * PRICE / 1e6 for body in bodies]
    if sum(reservations) > CAP:
        raise ValueError("cost estimate exceeds approval")
    if any(destination.glob("started-*.json")):
        raise ValueError("requests already started; no automatic retry/resume")
    key, used, results = credential(), 0.0, []
    for index, (relative, body, reservation) in enumerate(zip(FILES, bodies, reservations)):
        if used + sum(reservations[index:]) > CAP:
            raise ValueError("remaining reservation exceeds approved estimate")
        save(destination / f"started-{index}.json", {"source": relative, "reserved_usd": reservation})
        started = time.monotonic()
        call = Request("https://api.typesafe.ai/v1/systemone", json.dumps(body).encode(), headers={
            "Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            with urlopen(call, timeout=120) as response:
                answer = json.load(response)
        except Exception:
            save(destination / f"failed-{index}.json", {"status": "failed_or_uncertain", "incurred_cost_usd": None,
                                                       "retry": "manual approval required"})
            raise RuntimeError("paid request failed/uncertain; stopped without retry") from None
        save(destination / f"response-{index}.json", answer)
        usage = answer.get("usage", {})
        tokens = usage.get("input_tokens")
        if type(tokens) not in (int, float) or not math.isfinite(tokens) or tokens < 0:
            raise ValueError("missing usage; stop, do not assume zero cost")
        used += tokens * PRICE / 1e6
        rows = unpack(body, answer)
        if answer.get("model") != body["model"]:
            raise ValueError("provider model differs from prepared model; stop")
        unchanged = hashlib.sha256(approved_source(root, relative).read_bytes()).hexdigest() == manifest["source_files"][relative]["sha256"]
        if not unchanged:
            raise ValueError("source changed during paid request")
        results.append({"path": relative, "model": answer.get("model"), "usage": usage,
            "seconds": round(time.monotonic() - started, 2), "rows": rows,
            "source_sha256": manifest["source_files"][relative]["sha256"]})
        save(destination / "results.json", {"files": results, "paid_requests": index + 1,
             "cost_estimate_usd": used, "cost_basis": "API input usage at local tariff, not billing",
             "semantic_review": "required", "production_onboarding_changed": False})
        print(json.dumps({"path": relative, "answered": len(answer["answers"]),
                          "seconds": results[-1]["seconds"], "cumulative_cost_estimate_usd": used}), flush=True)
    return used


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--execute", action="store_true", help="send the prepared source to TypeSafe; paid")
    args = parser.parse_args()
    root, destination = args.root.resolve(strict=True), args.output.resolve()
    repo = Path(__file__).resolve().parents[2]
    if destination.is_relative_to(root) or destination.is_relative_to(repo):
        parser.error("private output must be outside source and SessionKit repositories")
    if args.execute:
        execute(root, destination)
    else:
        manifest = prepare(root, destination)
        print(json.dumps({"artifacts": str(destination), "planned_requests": 3, "questions_per_request": 56,
                          "estimated_max_usd": manifest["estimated_max_usd"]}, indent=2))


if __name__ == "__main__":
    main()
