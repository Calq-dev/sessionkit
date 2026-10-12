"""Experimental local evidence ledger; lexical retrieval only, no model/network.

JSON requests on stdin; --state must be outside the inspected repository.
Actions: explore (questions with explicit anchors), record (evidence-backed proposal).
This is NOT semantic repository search or a production MCP tool.
"""
import argparse
import copy
import hashlib
import json
import os
import re
import uuid
from pathlib import Path

EXCLUDE = {".git", ".claude", ".env", "node_modules", "vendor", "target", "__pycache__"}
LIMITS = {"requests": 20, "source_bytes": 12000, "scan_bytes": 2000000, "files": 200}


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def source(root, relative):
    path = root / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("unsafe source path")
    if any(p in EXCLUDE or p.startswith(".env") for p in Path(relative).parts):
        raise ValueError("excluded source")
    if any((root / Path(*Path(relative).parts[:i])).is_symlink()
           for i in range(1, len(Path(relative).parts) + 1)):
        raise ValueError("symlink source")
    path.resolve(strict=True).relative_to(root)
    return path


def initial(root):
    return {"schema_version": 1, "exploration_id": uuid.uuid4().hex, "root": str(root),
            "scope": "inspected file contents only; not a complete repository snapshot",
            "files": {}, "questions": {}, "nodes": {}, "proposals": [],
            "usage": dict.fromkeys(LIMITS, 0), "limits": LIMITS.copy(),
            "semantic_validation": "not performed", "paid_calls": 0}


def verify(state, root):
    if state["root"] != str(root):
        raise ValueError("exploration root changed")
    for relative, fingerprint in state["files"].items():
        if hashlib.sha256(source(root, relative).read_bytes()).hexdigest() != fingerprint:
            raise ValueError("inspected source changed: " + relative)
    for node in state["nodes"].values():
        lines = source(root, node["path"]).read_text().splitlines()
        if (node["source_sha256"] != state["files"][node["path"]]
                or not 1 <= node["start"] <= node["end"] <= len(lines)
                or "\n".join(lines[node["start"] - 1:node["end"]]) != node["quote"]):
            raise ValueError("invalid evidence")


def files(root):
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE
                         and not d.startswith(".env") and not (Path(directory) / d).is_symlink())
        for name in sorted(names):
            relative = str((Path(directory) / name).relative_to(root))
            try:
                path = source(root, relative)
            except ValueError:
                continue
            yield relative, path


def explore(state, root, request):
    questions = request.get("questions", [])
    if not 1 <= len(questions) <= 10:
        raise ValueError("provide 1-10 questions")
    focus = request.get("focus", [])
    if any(node not in state["nodes"] for node in focus):
        raise ValueError("unknown focus node")
    for question in questions:
        if (not isinstance(question.get("text"), str) or not question["text"].strip()
                or len(question["text"]) > 4096):
            raise ValueError("question text required")
        anchors = question.get("anchors", [])
        if not 1 <= len(anchors) <= 10 or any(not isinstance(a, str) or not a.strip() or len(a) > 128 for a in anchors):
            raise ValueError("explicit nonempty lexical anchors required")
    ids = []
    for question in questions:
        qid = digest(json.dumps({"question": question, "focus": focus}, sort_keys=True))[:24]
        state["questions"].setdefault(qid, {**question, "focus": focus, "evidence": [], "status": "open"})
        ids.append(qid)
    paths = ([ (state["nodes"][n]["path"], source(root, state["nodes"][n]["path"])) for n in focus]
             if focus else files(root))
    truncated = False
    seen = set()
    for relative, path in paths:
        if relative in seen:
            continue
        seen.add(relative)
        size = path.stat().st_size
        if (state["usage"]["files"] >= state["limits"]["files"]
                or state["usage"]["scan_bytes"] + size > state["limits"]["scan_bytes"]):
            truncated = True
            break
        state["usage"]["files"] += 1
        state["usage"]["scan_bytes"] += size
        raw = path.read_bytes()
        if len(raw) != size:
            raise ValueError("source changed during scan")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if "\x00" in text:
            continue
        fingerprint = hashlib.sha256(raw).hexdigest()
        # Even an inspected nonmatch is part of the limited snapshot.
        state["files"][relative] = fingerprint
        lines = text.splitlines()
        for qid in ids:
            question = state["questions"][qid]
            for i, line in enumerate(lines):
                if not any(re.search(r"(?<!\w)" + re.escape(a) + r"(?!\w)", line, re.I)
                           for a in question["anchors"]):
                    continue
                start, end = max(1, i), min(len(lines), i + 3)
                quote = "\n".join(lines[start - 1:end])
                node = {"path": relative, "source_sha256": fingerprint,
                        "start": start, "end": end, "quote": quote, "standing": "retrieval_lead"}
                nid = digest(json.dumps(node, sort_keys=True))[:24]
                if nid not in state["nodes"]:
                    size = len(quote.encode())
                    if state["usage"]["source_bytes"] + size > state["limits"]["source_bytes"]:
                        truncated = True
                        continue
                    state["nodes"][nid] = node
                    state["usage"]["source_bytes"] += size
                if nid not in question["evidence"]:
                    question["evidence"].append(nid)
    return {"question_ids": ids, "truncated": truncated,
            "warning": "Lexical leads only; no match is not evidence of absence."}


def record(state, request):
    proposal = request["proposal"]
    if proposal.get("question_id") not in state["questions"]:
        raise ValueError("unknown question")
    if not isinstance(proposal.get("claim"), str) or not proposal["claim"].strip():
        raise ValueError("claim required")
    if not proposal.get("evidence") or any(n not in state["nodes"] for n in proposal["evidence"]):
        raise ValueError("known source evidence required")
    for field in ["counterevidence", "endpoints"]:
        if any(n not in state["nodes"] for n in proposal.get(field, [])):
            raise ValueError("unresolved " + field)
    if proposal.get("relation") and len(proposal.get("endpoints", [])) != 2:
        raise ValueError("relation requires two evidence endpoints")
    state["proposals"].append({**proposal, "standing": "unverified_proposal",
                               "semantic_validation": "required"})
    return {"proposal_index": len(state["proposals"]) - 1}


def apply(state, root, request):
    """Transactional: rejected requests cannot mutate the supplied ledger."""
    root = Path(root).resolve(strict=True)
    verify(state, root)
    candidate = copy.deepcopy(state)
    if candidate["usage"]["requests"] >= candidate["limits"]["requests"]:
        raise ValueError("request limit exceeded")
    candidate["usage"]["requests"] += 1
    action = request.get("action", "explore")
    if action == "explore":
        result = explore(candidate, root, request)
    elif action == "record":
        result = record(candidate, request)
    else:
        raise ValueError("unknown action")
    verify(candidate, root)
    return candidate, result


def main():
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    root, destination = args.root.resolve(strict=True), args.state.resolve()
    if destination.is_relative_to(root):
        parser.error("temporary state must be outside source root")
    state = json.loads(destination.read_text()) if destination.exists() else initial(root)
    state, result = apply(state, root, json.load(sys.stdin))
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(state, indent=2))
    temporary.replace(destination)
    print(json.dumps({"result": result, "ledger": state}, indent=2))


if __name__ == "__main__":
    main()
