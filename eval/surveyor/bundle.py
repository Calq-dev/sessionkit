"""Fixed file-survey bundle: 28 propositions plus 28 evidence selections.

Source observations only. Domain-specific version-workflow module is deliberately
selected for this pilot, not assumed applicable to every repository.
"""
import hashlib
import json

BASE = [
    ("B01", "This file opens a database transaction around a write operation."),
    ("B02", "This file explicitly acquires a database row lock."),
    ("B03", "This file explicitly rejects writes to a version that is not a draft."),
    ("B04", "At least one operation requires its caller to supply a transaction rather than opening one locally."),
    ("B05", "Derived state is deferred until the outermost batch completes."),
    ("B06", "A finally block clears or decrements in-memory batch bookkeeping even if work fails."),
    ("B07", "At least one repeat operation returns or skips work when the requested state already exists."),
    ("B08", "This file directly creates persisted domain records."),
    ("B09", "This file directly updates persisted domain records."),
    ("B10", "This file directly deletes persisted domain records."),
    ("B11", "This file creates a record with an explicit queued-work status."),
    ("B12", "This file directly makes a paid external language-model API request."),
    ("B13", "This file itself checks the acting user's role or permission before a write."),
    ("B14", "This file generates a new lineage identifier for new domain content."),
    ("B15", "This file preserves an existing lineage identifier when copying or replacing domain content."),
    ("B16", "This file delegates domain work to an injected collaborator or supplied callback."),
]
VERSION_WORKFLOW = [
    ("V01", "Publication is blocked when review proposals remain pending."),
    ("V02", "Publication is blocked while criterion revisions remain unfinished."),
    ("V03", "Publication is blocked while extraction work is queued or running."),
    ("V04", "Publication requires each included criterion to have an included checkpoint."),
    ("V05", "Publishing supersedes the previous published version and updates the framework's published/draft pointers."),
    ("V06", "A new draft retains the published version's pinned template revision when it still belongs to the same template."),
    ("V07", "A draft can explicitly adopt the latest template revision and reconcile its content."),
    ("V08", "Requesting a criterion revision requires a source segment identifier."),
    ("V09", "A repeated revision request returns without creating another revision when one is already working."),
    ("V10", "Applying a revision round waits until none of that version's revisions are still working."),
    ("V11", "A ready revision is applied only to a draft; results for a non-draft version are dismissed."),
    ("V12", "Automatic reconciliation never modifies any field of a human-decided document requirement."),
]
QUESTIONS = BASE + VERSION_WORKFLOW
ASSESSMENT = {
    "supported": "Executable code in this file supports the proposition under its stated conditions. Imports, names and comments alone are insufficient.",
    "contradicted": "Executable code shows a specific branch or operation inconsistent with the proposition. Missing mentions alone are not contradiction.",
    "uncertain": "Relevant code is present but target identity, conditions or delegated behavior prevent deciding the proposition from this file alone.",
    "not_demonstrated": "This file does not establish the proposition. It may be implemented elsewhere; do not claim repository-wide absence.",
}


def request(path, text, model="jev-1.13.0"):
    lines = text.splitlines()
    # Twelve-line source windows overlap by two lines; below Choice's option limit.
    passages = {f"P{i // 10 + 1:03}": {"start": i + 1, "end": min(i + 12, len(lines)),
                 "text": "\n".join(lines[i:i + 12])} for i in range(0, len(lines), 10)}
    if len(passages) > 254:
        raise ValueError("source exceeds this pilot's evidence option limit")
    questions = {}
    for qid, proposition in QUESTIONS:
        questions[qid] = {"type": "choice", "instructions":
            f"Assess this proposition using executable code in source.passages only: {proposition} "
            "Judge the exact scope and quantifiers. Do not promote a docblock into verified behavior or assume behavior in another file.",
            "criteria": ASSESSMENT}
        questions[qid + "_evidence"] = {"type": "choice", "instructions":
            f"For this proposition select the source.passages ID containing the strongest executable support or counterexample: {proposition} "
            "Choose none if no executable evidence bears on it. A passage can be only local evidence, not proof of a whole-file universal claim.",
            "criteria": {**dict.fromkeys(passages), "none": "No executable evidence in this file bears on the proposition."}}
    return {"model": model, "state": {"source": {"path": path, "passages": passages},
            "scope": "One complete file, represented by overlapping verbatim source windows. No runtime observations, user intent or other files supplied."},
            "questions": questions}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def unpack(body, response):
    answers = response.get("answers", {})
    if set(answers) != set(body["questions"]):
        raise ValueError("incomplete or unexpected answer IDs")
    result = []
    passages = body["state"]["source"]["passages"]
    for qid, proposition in QUESTIONS:
        assessment, evidence = answers[qid], answers[qid + "_evidence"]
        choice, selected = assessment["choice"], evidence["choice"]
        if choice not in ASSESSMENT or selected not in [*passages, "none"]:
            raise ValueError("unknown choice")
        probabilities = assessment["probabilities"]
        evidence_probabilities = evidence["probabilities"]
        for label, values, options in [("assessment", probabilities, ASSESSMENT),
                                       ("evidence", evidence_probabilities, body["questions"][qid + "_evidence"]["criteria"])]:
            if set(values) != set(options) or any(type(v) not in (int, float) or not 0 <= v <= 1 for v in values.values()):
                raise ValueError("invalid " + label + " probabilities")
        result.append({"id": qid, "proposition": proposition, "assessment": choice,
                       "choice_probability": probabilities[choice], "provider_confidence": assessment.get("confidence"),
                       "evidence_choice_probability": evidence_probabilities[selected],
                       "evidence_provider_confidence": evidence.get("confidence"), "evidence_id": selected,
                       "evidence": None if selected == "none" else passages[selected],
                       "standing": "model_proposal_not_verified"})
    return result
