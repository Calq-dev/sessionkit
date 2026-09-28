// sessionkit compact — compact a Claude Code conversation without a summary.
//
// Claude Code's own compaction asks a model to summarize the conversation. A summary is lossy: a
// path, an exact error, a constraint can disappear although it matters later. Here nothing is
// rewritten. Jev (TypeSafe) sees the whole conversation, with every tool output replaced by a
// short note, and for every tool call answers two questions: should the call stay, and should
// its full output stay verbatim. What it lets go is cut to its first lines or dropped with its
// call; all text of the person and of Claude stays as it was. A port of fast-jev-compaction.
//
// Claude Code hands the conversation over through a function hook (the plugin that sessionkit
// setup installs): `sessionkit compact --hook` reads the messages as JSON on stdin and prints a
// plan on stdout that says, per message, keep it, rebuild it from these parts, or leave it out.
// Anything that goes wrong makes the hook fall back to Claude Code's own summary.
//
// `sessionkit compact <session>` runs the same selection over a transcript and prints what it
// would keep, without changing anything.

use crate::Result;
use crate::js;
use crate::start::{PRICE_PER_MILLION_TOKENS, model, post, session_files};
use crate::usage::projects_dir;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::sync::LazyLock;

const USAGE: &str = "Usage: sessionkit compact <session> [--verbose]
       sessionkit compact --hook

Compacts a Claude Code conversation without a summary: Jev (TypeSafe) decides per tool call
whether the call and its output are still needed; the rest is cut or dropped, and all text stays
verbatim. In Claude Code this runs on /compact and auto-compaction, through the plugin that
sessionkit setup installs.

With a session (an id, an id prefix, a transcript file, or last) it shows what a compaction now
would keep, and changes nothing. That sends the conversation to TypeSafe and costs a little.

Options:
  --verbose   list the decision and both probabilities for every tool call
  --hook      read Claude Code's messages as JSON on stdin and print the plan (for the plugin)
  --measure [n]  measure the questions on n recent sessions (default 12; costs money)
  -h, --help  show this help";

const KEEP_THRESHOLD: f64 = 0.5;
const PRESERVE_RECENT_MESSAGES: usize = 6;
const MAX_STATE_TOKENS: usize = 25_000;
const MAX_REQUEST_TOKENS: usize = 30_000; // state plus questions, under Jev's 32k request limit
const REQUEST_OVERHEAD_TOKENS: usize = 20;
const TRUNCATE_HEAD_CHARS: usize = 300;
const MIN_REDUCTION: f64 = 0.25; // below this the summary of Claude Code frees more
const CONCURRENCY: usize = 6;
const INPUT_CHARS: [usize; 3] = [1000, 200, 60];
const TEXT_HEAD: usize = 400;
const TEXT_TAIL: usize = 150;

const STATE_CONTEXT: &str = "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.";

// ---------------------------------------------------------------- messages

pub struct ToolUse {
    id: String,
    tool: String,
    input: Value,
    text: Option<String>,
    is_error: bool,
}

pub struct ToolResult {
    id: String,
    text: String,
    is_error: bool,
}

pub struct Message {
    role: String,
    text: String,
    uses: Vec<ToolUse>,
    results: Vec<ToolResult>,
}

/// A message in the shape of Claude Code's SessionMessage.
fn message_of(value: &Value) -> Message {
    let list = |key: &str| value.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    Message {
        role: js::str_of(value, "role").to_string(),
        text: js::str_of(value, "text").to_string(),
        uses: list("toolUses").iter().map(|u| ToolUse {
            id: js::str_of(u, "tool_use_id").to_string(),
            tool: js::str_of(u, "tool").to_string(),
            input: u.get("input").cloned().unwrap_or_else(|| json!({})),
            text: u.get("text").and_then(Value::as_str).map(str::to_string),
            is_error: js::truthy(u.get("isError")),
        }).collect(),
        results: list("toolResults").iter().map(|r| ToolResult {
            id: js::str_of(r, "tool_use_id").to_string(),
            text: js::str_of(r, "text").to_string(),
            is_error: js::truthy(r.get("isError")),
        }).collect(),
    }
}

/// Characters of text, tool input and tool output a message holds.
fn message_chars(message: &Message) -> usize {
    js::len(&message.text) + message.uses.iter().map(|u| js::len(&js::stringify(&u.input))).sum::<usize>()
        + message.results.iter().map(|r| js::len(&r.text)).sum::<usize>()
}

// ---------------------------------------------------------------- calls

struct ToolCall {
    id: String,
    use_id: String,
    tool: String,
    input: Value,
    call_index: usize,
    result_chars: usize,
    is_error: bool,
    pinned: bool,
}

fn is_pinned(index: usize, total: usize) -> bool {
    index == 0 || index + PRESERVE_RECENT_MESSAGES >= total
}

/// Every tool call paired with its result. A call without a result is no candidate: there is
/// nothing to drop yet.
fn collect_calls(messages: &[Message]) -> Vec<ToolCall> {
    let mut results: HashMap<&str, (usize, &ToolResult)> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        for result in &message.results {
            results.insert(&result.id, (index, result));
        }
    }
    let mut calls = Vec::new();
    for (call_index, message) in messages.iter().enumerate() {
        for tool in &message.uses {
            let Some(&(result_index, result)) = results.get(tool.id.as_str()) else { continue };
            calls.push(ToolCall {
                id: format!("t{}", calls.len() + 1),
                use_id: tool.id.clone(),
                tool: tool.tool.clone(),
                input: tool.input.clone(),
                call_index,
                result_chars: js::len(&result.text),
                is_error: result.is_error,
                pinned: is_pinned(call_index, messages.len()) || is_pinned(result_index, messages.len()),
            });
        }
    }
    calls
}

// ---------------------------------------------------------------- state

static TOKEN_PIECES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]").unwrap());
static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// Tokens without a tokenizer: a word costs one token per six letters, a digit half a token, any
/// other symbol nine tenths. fast-jev-compaction calibrated this against the usage Jev reports:
/// it lands a little above the real count, where characters per token undercount JSON.
fn estimate_tokens(text: &str) -> usize {
    let mut tokens = 0.0;
    for piece in TOKEN_PIECES.find_iter(text) {
        let piece = piece.as_str();
        let first = piece.as_bytes()[0];
        tokens += if first.is_ascii_digit() {
            piece.len() as f64 / 2.0
        } else if first.is_ascii_alphabetic() {
            (1 + (piece.len() - 1) / 6) as f64
        } else {
            0.9
        };
    }
    tokens.ceil() as usize
}

fn truncate(text: &str, limit: usize) -> String {
    if js::len(text) <= limit { text.to_string() } else { format!("{}…", js::head(text, limit.saturating_sub(1))) }
}

fn abridge(text: &str) -> String {
    let length = js::len(text);
    if length <= TEXT_HEAD + TEXT_TAIL + 40 {
        return text.to_string();
    }
    format!("{}\n[… {} chars omitted …]\n{}", js::head(text, TEXT_HEAD), length - TEXT_HEAD - TEXT_TAIL, js::slice(text, length - TEXT_TAIL, length))
}

fn input_text(input: &Value, limit: usize) -> String {
    truncate(&js::stringify(input), limit)
}

/// One call as a single line, for when the structured form is too costly.
fn call_line(call: &ToolCall) -> String {
    let input: Vec<String> = call.input.as_object().into_iter().flatten().map(|(key, value)| {
        let text = match value.as_str() {
            Some(text) => text.to_string(),
            None => input_text(&json!({key.as_str(): value}), 200),
        };
        format!("{key}={}", SPACE.replace_all(&text, " "))
    }).collect();
    format!("{} {} {} → {} {}ch", call.id, call.tool, truncate(&input.join(" "), INPUT_CHARS[2]), if call.is_error { "error" } else { "ok" }, call.result_chars)
}

enum Calls {
    Full(Vec<Value>),
    Lines(Vec<String>),
}

struct Entry {
    i: usize,
    role: String,
    text: String,
    calls: Option<Calls>,
}

impl Entry {
    fn json(&self) -> Value {
        let mut entry = json!({"i": self.i, "role": self.role, "text": self.text});
        match &self.calls {
            Some(Calls::Full(calls)) => entry["tool_calls"] = Value::Array(calls.clone()),
            Some(Calls::Lines(lines)) => entry["tool_calls"] = json!(lines),
            None => {}
        }
        entry
    }

    fn tokens(&self) -> usize {
        estimate_tokens(&js::stringify(&self.json())) + 1
    }
}

fn calls_by_message(calls: &[ToolCall]) -> HashMap<usize, Vec<&ToolCall>> {
    let mut by_message: HashMap<usize, Vec<&ToolCall>> = HashMap::new();
    for call in calls {
        by_message.entry(call.call_index).or_default().push(call);
    }
    by_message
}

fn history(messages: &[Message], calls: &[ToolCall], input_chars: usize) -> Vec<Entry> {
    let by_message = calls_by_message(calls);
    messages.iter().enumerate().filter_map(|(i, message)| {
        let own: Vec<Value> = by_message.get(&i).into_iter().flatten().map(|call| json!({
            "id": call.id,
            "tool": call.tool,
            "input": input_text(&call.input, input_chars),
            "result": format!("{}, {} chars (omitted)", if call.is_error { "error" } else { "ok" }, call.result_chars),
        })).collect();
        if js::trim(&message.text).is_empty() && own.is_empty() {
            return None;
        }
        Some(Entry { i, role: message.role.clone(), text: message.text.clone(), calls: (!own.is_empty()).then_some(Calls::Full(own)) })
    }).collect()
}

/// The last three prompts of the person: what the conversation is about now.
fn goal(messages: &[Message]) -> String {
    let prompts: Vec<String> = messages.iter()
        .filter(|m| m.role == "user" && !js::trim(&m.text).is_empty() && m.results.is_empty())
        .map(|m| truncate(&m.text, 500)).collect();
    prompts[prompts.len().saturating_sub(3)..].join("\n")
}

struct Fitted {
    state: Value,
    tokens: usize,
    stage: &'static str,
}

/// The whole conversation as state, shrunk in stages until it fits MAX_STATE_TOKENS: tool
/// inputs cut shorter, then long texts abridged oldest first (pinned messages last), then old
/// texts replaced by a note, then old calls reduced to one line each, then old messages without
/// calls left out, then runs of old call-only messages folded together.
fn fit_state(messages: &[Message], calls: &[ToolCall]) -> Result<Fitted> {
    let goal = goal(messages);
    let state_of = |entries: &[Entry]| json!({"context": STATE_CONTEXT, "goal": goal, "history": entries.iter().map(Entry::json).collect::<Vec<_>>()});
    let base = estimate_tokens(&js::stringify(&state_of(&[])));
    let total = |entries: &[Entry]| base + entries.iter().map(Entry::tokens).sum::<usize>();

    for (n, &limit) in INPUT_CHARS.iter().enumerate() {
        let entries = history(messages, calls, limit);
        let tokens = total(&entries);
        if tokens <= MAX_STATE_TOKENS || n == INPUT_CHARS.len() - 1 {
            if tokens <= MAX_STATE_TOKENS {
                let stage = ["full", "inputs<=200", "inputs<=60"][n];
                return Ok(Fitted { state: state_of(&entries), tokens, stage });
            }
            return shrink(messages, calls, entries, tokens, &state_of, base);
        }
    }
    unreachable!()
}

fn shrink(messages: &[Message], calls: &[ToolCall], mut entries: Vec<Entry>, mut tokens: usize, state_of: &dyn Fn(&[Entry]) -> Value, base: usize) -> Result<Fitted> {
    let total = messages.len();
    let pinned = |entry: &Entry| is_pinned(entry.i, total);
    let mut per_entry: Vec<usize> = entries.iter().map(Entry::tokens).collect();
    let order: Vec<usize> = (0..entries.len()).filter(|&i| !pinned(&entries[i])).chain((0..entries.len()).filter(|&i| pinned(&entries[i]))).collect();
    let done = |entries: &[Entry], tokens: usize, stage: &'static str| Ok(Fitted { state: state_of(entries), tokens, stage });
    let mut change = |entries: &mut Vec<Entry>, index: usize, tokens: &mut usize, edit: &dyn Fn(&mut Entry)| {
        edit(&mut entries[index]);
        let now = entries[index].tokens();
        *tokens = *tokens + now - per_entry[index];
        per_entry[index] = now;
    };

    for &index in &order {
        if js::len(&entries[index].text) <= TEXT_HEAD + TEXT_TAIL + 40 {
            continue;
        }
        change(&mut entries, index, &mut tokens, &|e| e.text = abridge(&e.text));
        if tokens <= MAX_STATE_TOKENS {
            return done(&entries, tokens, "texts abridged");
        }
    }
    for &index in &order {
        if pinned(&entries[index]) || entries[index].text.is_empty() {
            continue;
        }
        let original = js::len(&messages[entries[index].i].text);
        change(&mut entries, index, &mut tokens, &|e| e.text = format!("[… {original} chars omitted …]"));
        if tokens <= MAX_STATE_TOKENS {
            return done(&entries, tokens, "old messages collapsed");
        }
    }
    let by_message = calls_by_message(calls);
    for &index in &order {
        let Some(own) = by_message.get(&entries[index].i).filter(|_| !pinned(&entries[index])) else { continue };
        let lines: Vec<String> = own.iter().map(|call| call_line(call)).collect();
        change(&mut entries, index, &mut tokens, &|e| e.calls = Some(Calls::Lines(lines.clone())));
        if tokens <= MAX_STATE_TOKENS {
            return done(&entries, tokens, "old calls compacted");
        }
    }
    let mut left = HashSet::new();
    for &index in &order {
        if pinned(&entries[index]) || entries[index].calls.is_some() {
            continue;
        }
        left.insert(index);
        tokens -= per_entry[index];
        if tokens <= MAX_STATE_TOKENS {
            let kept: Vec<Entry> = entries.into_iter().enumerate().filter(|(i, _)| !left.contains(i)).map(|(_, e)| e).collect();
            return done(&kept, tokens, "old messages left out");
        }
    }
    // Fold runs of old call-only entries of one role into one entry: the envelope once per run.
    let mut merged: Vec<Entry> = Vec::new();
    let foldable = |e: &Entry| !pinned(e) && e.text.is_empty() && matches!(e.calls, Some(Calls::Lines(_)));
    for (i, entry) in entries.into_iter().enumerate() {
        if left.contains(&i) {
            continue;
        }
        if let Some(previous) = merged.last_mut().filter(|p| foldable(p) && foldable(&entry) && p.role == entry.role) {
            if let (Some(Calls::Lines(into)), Some(Calls::Lines(lines))) = (&mut previous.calls, entry.calls) {
                into.extend(lines);
            }
            continue;
        }
        merged.push(entry);
    }
    let tokens = base + merged.iter().map(Entry::tokens).sum::<usize>();
    if tokens <= MAX_STATE_TOKENS {
        return done(&merged, tokens, "old calls merged");
    }
    Err(format!("history too large for Jev (~{tokens} tokens after shrinking, limit {MAX_STATE_TOKENS})"))
}

// ---------------------------------------------------------------- asking

/// The two questions about one call: keep the call, keep its output verbatim.
fn questions_for(call: &ToolCall) -> Map<String, Value> {
    let mut questions = Map::new();
    questions.insert(format!("call_{}", call.id), json!({"type": "noul", "instructions": format!(
        "Tool call {} ({}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next",
        call.id, call.tool)}));
    questions.insert(format!("result_{}", call.id), json!({"type": "noul", "instructions": format!(
        "The full output of tool call {} ({}, {} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do",
        call.id, call.tool, call.result_chars)}));
    questions
}

/// Split the candidates into requests that fit beside the state, which every request repeats.
fn batches<'a>(candidates: &[&'a ToolCall], state_tokens: usize) -> Result<Vec<Vec<&'a ToolCall>>> {
    let budget = MAX_REQUEST_TOKENS.saturating_sub(state_tokens + REQUEST_OVERHEAD_TOKENS);
    let mut out: Vec<Vec<&ToolCall>> = Vec::new();
    let (mut current, mut size) = (Vec::new(), 0);
    for &call in candidates {
        let tokens = estimate_tokens(&js::stringify(&Value::Object(questions_for(call))));
        if !current.is_empty() && size + tokens > budget {
            out.push(std::mem::take(&mut current));
            size = 0;
        }
        if current.is_empty() && tokens > budget {
            return Err(format!("the state leaves no room for questions (~{state_tokens} of {MAX_REQUEST_TOKENS} tokens)"));
        }
        current.push(call);
        size += tokens;
    }
    if !current.is_empty() {
        out.push(current);
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Action {
    Pinned,
    Keep,
    DropResult,
    DropCall,
}

struct Decision {
    action: Action,
    keep_call: f64,
    keep_result: f64,
}

fn decide(pinned: bool, keep_call: f64, keep_result: f64) -> Decision {
    let action = if pinned {
        Action::Pinned
    } else if keep_result >= KEEP_THRESHOLD {
        Action::Keep
    } else if keep_call >= KEEP_THRESHOLD {
        Action::DropResult
    } else {
        Action::DropCall
    };
    Decision { action, keep_call, keep_result }
}

// ---------------------------------------------------------------- the plan

fn cut(text: &str, is_error: bool) -> String {
    let length = js::len(text);
    if length <= TRUNCATE_HEAD_CHARS + 120 {
        return text.to_string();
    }
    format!("{}\n[sessionkit compact cut {} chars of this tool result{}; re-run the tool if needed]",
        js::head(text, TRUNCATE_HEAD_CHARS), length - TRUNCATE_HEAD_CHARS, if is_error { " (error)" } else { "" })
}

/// Per message: keep it as it is ({"keep": i}), rebuild it from its parts ({"from": i, ...}),
/// or leave it out. A part is {"keep": j}, the j-th tool block as it was, or {"keep": j, "text"},
/// the same block with its output cut. A dropped call goes together with its result, so no
/// result is ever left without its call. Also returns the characters left.
fn plan(messages: &[Message], actions: &HashMap<&str, Action>) -> (Vec<Value>, usize) {
    let mut out = Vec::new();
    let mut chars = 0;
    for (i, message) in messages.iter().enumerate() {
        let action = |id: &str| actions.get(id).copied().unwrap_or(Action::Keep);
        let mut changed = false;
        let mut size = js::len(&message.text);
        let mut uses = Vec::new();
        for (j, tool) in message.uses.iter().enumerate() {
            match action(&tool.id) {
                Action::DropCall => changed = true,
                Action::DropResult => {
                    let text = tool.text.as_deref().unwrap_or("");
                    let short = cut(text, tool.is_error);
                    size += js::len(&js::stringify(&tool.input));
                    if short != text {
                        changed = true;
                        uses.push(json!({"keep": j, "text": short}));
                    } else {
                        uses.push(json!({"keep": j}));
                    }
                }
                _ => {
                    size += js::len(&js::stringify(&tool.input));
                    uses.push(json!({"keep": j}));
                }
            }
        }
        let mut results = Vec::new();
        for (j, result) in message.results.iter().enumerate() {
            match action(&result.id) {
                Action::DropCall => changed = true,
                Action::DropResult => {
                    let short = cut(&result.text, result.is_error);
                    size += js::len(&short);
                    if short != result.text {
                        changed = true;
                        results.push(json!({"keep": j, "text": short}));
                    } else {
                        results.push(json!({"keep": j}));
                    }
                }
                _ => {
                    size += js::len(&result.text);
                    results.push(json!({"keep": j}));
                }
            }
        }
        if !changed {
            out.push(json!({"keep": i}));
        } else if js::trim(&message.text).is_empty() && uses.is_empty() && results.is_empty() {
            continue;
        } else {
            out.push(json!({"from": i, "toolUses": uses, "toolResults": results}));
        }
        chars += size;
    }
    (out, chars)
}

pub struct Compaction {
    plan: Vec<Value>,
    messages_before: usize,
    chars_before: usize,
    chars_after: usize,
    counts: [usize; 4],
    state_tokens: usize,
    stage: &'static str,
    requests: usize,
    tokens: f64,
    /// Per call: its id in the state, its tool_use id, the tool and the decision.
    decisions: Vec<(String, String, String, Decision)>,
}

impl Compaction {
    fn reduction(&self) -> f64 {
        if self.chars_before == 0 { 0.0 } else { (self.chars_before - self.chars_after) as f64 / self.chars_before as f64 }
    }

    fn summary(&self) -> String {
        let [pinned, kept, cut, dropped] = self.counts;
        let parts: Vec<String> = [(kept, "kept"), (cut, "outputs cut"), (dropped, "calls dropped"), (pinned, "pinned")].iter()
            .filter(|(n, _)| *n > 0).map(|(n, label)| format!("{n} {label}")).collect();
        format!("{}% smaller; {}; state ~{} tokens ({}) in {} request(s), ${}",
            js::round(self.reduction() * 100.0), if parts.is_empty() { "no tool calls".into() } else { parts.join(", ") },
            self.state_tokens, if self.stage.is_empty() { "none" } else { self.stage }, self.requests,
            js::fixed(self.tokens / 1e6 * PRICE_PER_MILLION_TOKENS, 4))
    }
}

/// Ask Jev about every call outside the pinned first and newest messages, and make the plan.
pub fn compact(messages: &[Message]) -> Result<Compaction> {
    let calls = collect_calls(messages);
    let candidates: Vec<&ToolCall> = calls.iter().filter(|c| !c.pinned).collect();
    let mut answers: HashMap<String, (f64, f64)> = HashMap::new();
    let (mut state_tokens, mut stage, mut requests, mut tokens) = (0, "", 0, 0.0);
    if !candidates.is_empty() {
        let fitted = fit_state(messages, &calls)?;
        let groups = batches(&candidates, fitted.tokens)?;
        let model = model();
        let replies = js::pool(&groups, CONCURRENCY, |group, _| -> Result<(Vec<(String, f64, f64)>, f64)> {
            let questions: Map<String, Value> = group.iter().flat_map(|call| questions_for(call)).collect();
            let data = post(&json!({"model": model, "state": fitted.state, "questions": questions}))?;
            let noul = |name: String| data["answers"][&name]["noul"].as_f64().filter(|p| p.is_finite()).ok_or(format!("Jev gave no answer for {name}"));
            let found = group.iter().map(|call| Ok((call.id.clone(), noul(format!("call_{}", call.id))?, noul(format!("result_{}", call.id))?)))
                .collect::<Result<Vec<_>>>()?;
            Ok((found, data["usage"]["input_tokens"].as_f64().unwrap_or(0.0)))
        });
        for reply in replies {
            let (found, used) = reply?;
            tokens += used;
            for (id, keep_call, keep_result) in found {
                answers.insert(id, (keep_call, keep_result));
            }
        }
        (state_tokens, stage, requests) = (fitted.tokens, fitted.stage, groups.len());
    }
    let mut counts = [0; 4];
    let mut actions: HashMap<&str, Action> = HashMap::new();
    let mut decisions = Vec::new();
    for call in &calls {
        let (keep_call, keep_result) = answers.get(&call.id).copied().unwrap_or((1.0, 1.0));
        let decision = decide(call.pinned, keep_call, keep_result);
        counts[decision.action as usize] += 1;
        actions.insert(&call.use_id, decision.action);
        decisions.push((call.id.clone(), call.use_id.clone(), call.tool.clone(), decision));
    }
    let (plan, chars_after) = plan(messages, &actions);
    Ok(Compaction {
        plan,
        messages_before: messages.len(),
        chars_before: messages.iter().map(message_chars).sum(),
        chars_after,
        counts,
        state_tokens,
        stage,
        requests,
        tokens,
        decisions,
    })
}

// ---------------------------------------------------------------- commands

/// The smallest reduction worth replacing the summary for. A build with the test-api feature
/// takes it from SESSIONKIT_COMPACT_MIN, so a test can compare every plan with fast-jev's.
fn min_reduction() -> f64 {
    #[cfg(feature = "test-api")]
    if let Ok(value) = std::env::var("SESSIONKIT_COMPACT_MIN") {
        return js::parse_number(Some(&value));
    }
    MIN_REDUCTION
}

/// For the plugin: messages on stdin, the plan or the reason to fall back on stdout.
fn hook() -> Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).map_err(|e| e.to_string())?;
    let data = js::parse(&input).ok_or("stdin is not JSON")?;
    let messages: Vec<Message> = data["messages"].as_array().ok_or("no messages on stdin")?.iter().map(message_of).collect();
    let answer = match compact(&messages) {
        Err(error) => json!({"fallback": error}),
        Ok(result) if result.reduction() < min_reduction() => {
            json!({"fallback": format!("below the minimum of {}%: {}", js::round(MIN_REDUCTION * 100.0), result.summary())})
        }
        Ok(result) => {
            let kept = result.plan.len();
            json!({"plan": result.plan, "summary": format!("kept {kept}/{} messages, no summary ({})", result.messages_before, result.summary())})
        }
    };
    println!("{}", js::stringify(&answer));
    Ok(())
}

/// A transcript file: a path, `last` for the newest in this folder, or an id or id prefix.
fn transcript(name: &str) -> Result<PathBuf> {
    let path = PathBuf::from(name);
    if path.is_file() {
        return Ok(path);
    }
    if name == "last" {
        return session_files(false, 1)?.into_iter().next().ok_or("no sessions in this folder".into());
    }
    let mut found = Vec::new();
    for folder in js::read_dir_names(&projects_dir())? {
        for file in js::read_dir_names(&projects_dir().join(&folder)).unwrap_or_default() {
            if file.starts_with(name) && file.ends_with(".jsonl") {
                found.push(projects_dir().join(&folder).join(file));
            }
        }
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(format!("no session {name}")),
        n => Err(format!("{n} sessions start with {name}; give more of the id")),
    }
}

fn joined_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks.iter().filter(|b| js::str_of(b, "type") == "text").map(|b| js::str_of(b, "text")).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// The conversation since the last compaction boundary, as Claude Code hands it to the hook: one message
/// per transcript entry, so the thinking, text and tool blocks of one response come apart.
fn read_transcript(path: &PathBuf) -> Result<Vec<Message>> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let entries: Vec<Value> = text.lines().filter_map(js::parse).filter(|e| !js::truthy(e.get("isSidechain"))).collect();
    let start = entries.iter().rposition(|e| js::str_of(e, "subtype") == "compact_boundary").map_or(0, |i| i + 1);
    let mut messages: Vec<Message> = Vec::new();
    for entry in entries[start..].iter().filter(|e| ["user", "assistant"].contains(&js::str_of(e, "type"))) {
        let mut message = Message { role: js::str_of(entry, "type").to_string(), text: String::new(), uses: Vec::new(), results: Vec::new() };
        let blocks = match &entry["message"]["content"] {
            Value::String(text) => vec![json!({"type": "text", "text": text})],
            Value::Array(blocks) => blocks.clone(),
            _ => Vec::new(),
        };
        let mut texts = Vec::new();
        for block in blocks {
            match js::str_of(&block, "type") {
                "text" => texts.push(js::str_of(&block, "text").to_string()),
                "tool_use" => message.uses.push(ToolUse {
                    id: js::str_of(&block, "id").to_string(),
                    tool: js::str_of(&block, "name").to_string(),
                    input: block.get("input").cloned().unwrap_or_else(|| json!({})),
                    text: None,
                    is_error: false,
                }),
                "tool_result" => message.results.push(ToolResult {
                    id: js::str_of(&block, "tool_use_id").to_string(),
                    text: joined_text(&block["content"]),
                    is_error: js::truthy(block.get("is_error")),
                }),
                _ => {}
            }
        }
        message.text = texts.join("\n");
        messages.push(message);
    }
    Ok(messages)
}

pub fn compact_main(argv: &[String]) -> Result<()> {
    let mut verbose = false;
    let mut session = None;
    for arg in argv {
        match arg.as_str() {
            "--hook" => return hook(),
            "--measure" => return measure(&argv[1..]),
            "--verbose" => verbose = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            other if other.starts_with("--") => {
                eprintln!("sessionkit compact: unknown option {other}\n\n{USAGE}");
                std::process::exit(2);
            }
            other => session = Some(other.to_string()),
        }
    }
    let Some(session) = session else {
        eprintln!("{USAGE}");
        std::process::exit(2);
    };
    let path = transcript(&session)?;
    let messages = read_transcript(&path)?;
    let result = compact(&messages)?;
    if verbose {
        for (id, _, tool, d) in result.decisions.iter().filter(|(_, _, _, d)| d.action != Action::Pinned) {
            println!("{id:>5} {:<12} {:<12} call {}  output {}", js::clip(tool, 12), format!("{:?}", d.action), js::fixed(d.keep_call, 2), js::fixed(d.keep_result, 2));
        }
        println!();
    }
    let kept = result.plan.len();
    println!("{}\n{} of {} messages, {} of {} characters: {}", path.display(), kept, result.messages_before,
        js::grouped(result.chars_after as f64), js::grouped(result.chars_before as f64), result.summary());
    if result.reduction() < MIN_REDUCTION {
        println!("Below {}%: Claude Code would use its own summary here.", js::round(MIN_REDUCTION * 100.0));
    }
    Ok(())
}

// ---------------------------------------------------------------- measuring

/// What happened to a file after the cut, for a Read before it: edited before it was read again
/// (its contents were still needed from the context), read again, or never touched again.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Label {
    Needed,
    Reread,
    Unused,
}

fn file_of(input: &Value) -> &str {
    input.get("file_path").or_else(|| input.get("notebook_path")).and_then(Value::as_str).unwrap_or("")
}

fn label(path: &str, after: &[Message]) -> Option<Label> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let mut mentioned = false;
    for message in after {
        for tool in &message.uses {
            let file = file_of(&tool.input);
            if file == path && tool.tool == "Read" {
                return Some(Label::Reread);
            }
            if file == path && ["Edit", "Write", "MultiEdit", "NotebookEdit"].contains(&tool.tool.as_str()) {
                return Some(Label::Needed);
            }
            if js::stringify(&tool.input).contains(name) {
                return None; // touched another way (grep, a shell command): no clean label
            }
        }
        mentioned |= message.text.contains(name);
    }
    // Named in text but never opened again: whether it was needed is not clear from code.
    (!mentioned).then_some(Label::Unused)
}

/// The share of (needed, unused) pairs in which the needed Read has the higher probability.
fn auc(needed: &[f64], unused: &[f64]) -> Option<f64> {
    if needed.is_empty() || unused.is_empty() {
        return None;
    }
    let mut wins = 0.0;
    for n in needed {
        for u in unused {
            wins += if n > u { 1.0 } else if n == u { 0.5 } else { 0.0 };
        }
    }
    Some(wins / (needed.len() * unused.len()) as f64)
}

fn median(values: &mut [f64]) -> String {
    if values.is_empty() {
        return "—".into();
    }
    values.sort_by(f64::total_cmp);
    js::fixed(values[values.len() / 2], 2)
}

/// Cut recent sessions at a prompt in their middle, compact what came before, and compare the
/// probabilities of Reads whose file was edited later with those whose file never came back.
fn measure(argv: &[String]) -> Result<()> {
    let sessions = argv.first().map_or(12.0, |n| js::parse_number(Some(n))) as usize;
    let mut rows: Vec<(usize, Label, f64, f64)> = Vec::new();
    let mut cost = 0.0;
    let mut cuts = 0;
    for path in session_files(true, 1000)? {
        if cuts >= sessions {
            break;
        }
        let messages = read_transcript(&path)?;
        let prompts: Vec<usize> = (0..messages.len())
            .filter(|&i| messages[i].role == "user" && messages[i].results.is_empty() && !js::trim(&messages[i].text).is_empty())
            .filter(|&i| i * 10 >= messages.len() * 2 && i * 10 <= messages.len() * 9).collect();
        let mut taken = 0;
        for &cut in &prompts {
            if taken >= 3 || cuts >= sessions {
                break;
            }
            let (before, after) = messages.split_at(cut);
            let reads: HashMap<&str, Label> = before.iter().flat_map(|m| &m.uses).filter(|u| u.tool == "Read")
                .filter_map(|u| Some((u.id.as_str(), label(file_of(&u.input), after)?))).collect();
            let labels: Vec<Label> = reads.values().copied().collect();
            if !labels.contains(&Label::Needed) || !labels.contains(&Label::Unused) {
                continue;
            }
            let result = compact(before)?;
            cost += result.tokens / 1e6 * PRICE_PER_MILLION_TOKENS;
            for (_, use_id, _, d) in &result.decisions {
                if let (Some(label), false) = (reads.get(use_id.as_str()), d.action == Action::Pinned) {
                    rows.push((cuts, *label, d.keep_call, d.keep_result));
                }
            }
            eprintln!("cut {cuts}: {} at message {cut} of {}: {} Reads labelled", path.file_name().unwrap().to_string_lossy(), messages.len(), reads.len());
            taken += 1;
            cuts += 1;
        }
    }
    println!("{cuts} cuts, {} labelled Reads, ${}\n", rows.len(), js::fixed(cost, 4));
    println!("{:<8} {:>5} {:>12} {:>14} {:>16}", "label", "n", "median call", "median output", "kept at 0.5");
    for label in [Label::Needed, Label::Reread, Label::Unused] {
        let of: Vec<&(usize, Label, f64, f64)> = rows.iter().filter(|r| r.1 == label).collect();
        let kept = of.iter().filter(|r| r.3 >= KEEP_THRESHOLD || r.2 >= KEEP_THRESHOLD).count();
        println!("{:<8} {:>5} {:>12} {:>14} {:>16}", format!("{label:?}"), of.len(), median(&mut of.iter().map(|r| r.2).collect::<Vec<_>>()),
            median(&mut of.iter().map(|r| r.3).collect::<Vec<_>>()), format!("{kept} of {}", of.len()));
    }
    // Within each cut: does a needed Read rank above an unused one?
    let (mut call_aucs, mut output_aucs) = (Vec::new(), Vec::new());
    for cut in 0..cuts {
        let pick = |label: Label, by: fn(&(usize, Label, f64, f64)) -> f64| rows.iter().filter(|r| r.0 == cut && r.1 == label).map(by).collect::<Vec<_>>();
        if let Some(a) = auc(&pick(Label::Needed, |r| r.2), &pick(Label::Unused, |r| r.2)) { call_aucs.push(a) }
        if let Some(a) = auc(&pick(Label::Needed, |r| r.3), &pick(Label::Unused, |r| r.3)) { output_aucs.push(a) }
    }
    println!("\nNeeded above unused, within a cut (0.5 is chance): call median {} over {} cuts, output median {}",
        median(&mut call_aucs), call_aucs.len(), median(&mut output_aucs));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(role: &str, text: &str) -> Message {
        Message { role: role.into(), text: text.into(), uses: Vec::new(), results: Vec::new() }
    }

    fn call(id: &str, output: &str) -> [Message; 2] {
        let mut use_ = text("assistant", "");
        use_.uses.push(ToolUse { id: id.into(), tool: "Read".into(), input: json!({"file_path": "a.rs"}), text: Some(output.into()), is_error: false });
        let mut result = text("user", "");
        result.results.push(ToolResult { id: id.into(), text: output.into(), is_error: false });
        [use_, result]
    }

    fn conversation(outputs: usize) -> Vec<Message> {
        let mut messages = vec![text("user", "fix the test")];
        for n in 0..outputs {
            messages.extend(call(&format!("u{n}"), &"line\n".repeat(200)));
        }
        messages.extend((0..PRESERVE_RECENT_MESSAGES).map(|_| text("assistant", "done")));
        messages
    }

    #[test]
    fn tokens_are_estimated_as_fast_jev_does() {
        assert_eq!(estimate_tokens("hello"), 1);
        assert_eq!(estimate_tokens("abcdefghijklm"), 3);
        assert_eq!(estimate_tokens("1234"), 2);
        assert_eq!(estimate_tokens("{}"), 2);
    }

    #[test]
    fn the_first_and_newest_messages_are_pinned() {
        let messages = conversation(3);
        let calls = collect_calls(&messages);
        assert_eq!(calls.len(), 3);
        assert!(calls.iter().all(|c| !c.pinned));
        let short = conversation(0);
        assert!(is_pinned(0, short.len()) && is_pinned(short.len() - 1, short.len()));
    }

    #[test]
    fn decisions_follow_the_threshold() {
        assert_eq!(decide(false, 0.9, 0.6).action, Action::Keep);
        assert_eq!(decide(false, 0.9, 0.2).action, Action::DropResult);
        assert_eq!(decide(false, 0.1, 0.2).action, Action::DropCall);
        assert_eq!(decide(true, 0.0, 0.0).action, Action::Pinned);
    }

    #[test]
    fn the_plan_cuts_outputs_and_drops_calls_with_their_results() {
        let messages = conversation(3);
        let actions: HashMap<&str, Action> = [("u0", Action::DropResult), ("u1", Action::DropCall)].into_iter().collect();
        let (plan, chars) = plan(&messages, &actions);
        assert_eq!(plan[0], json!({"keep": 0}));
        assert_eq!(plan[1]["from"], 1);
        assert!(plan[1]["toolUses"][0]["text"].as_str().unwrap().contains("sessionkit compact cut"));
        assert_eq!(plan[2]["toolResults"][0]["keep"], 0);
        assert!(plan[2]["toolResults"][0]["text"].as_str().unwrap().starts_with("line\n"));
        // u1: both messages are left out, since nothing else is in them.
        assert_eq!(plan[3], json!({"keep": 5}));
        assert_eq!(plan.len(), messages.len() - 2);
        assert!(chars < messages.iter().map(message_chars).sum::<usize>());
    }

    #[test]
    fn the_state_shrinks_until_it_fits() {
        let mut messages = vec![text("user", "fix the test")];
        for n in 0..400 {
            messages.push(text("user", &"please look at this ".repeat(30)));
            messages.extend(call(&format!("u{n}"), "x"));
        }
        messages.extend((0..PRESERVE_RECENT_MESSAGES).map(|_| text("assistant", "done")));
        let calls = collect_calls(&messages);
        let fitted = fit_state(&messages, &calls).unwrap();
        assert!(fitted.tokens <= MAX_STATE_TOKENS);
        assert_ne!(fitted.stage, "full");
        let small = conversation(2);
        assert_eq!(fit_state(&small, &collect_calls(&small)).unwrap().stage, "full");
    }

    #[test]
    fn questions_are_split_into_requests_that_fit() {
        let messages = conversation(400);
        let calls = collect_calls(&messages);
        let candidates: Vec<&ToolCall> = calls.iter().collect();
        let groups = batches(&candidates, 25_000).unwrap();
        assert!(groups.len() > 1);
        assert_eq!(groups.iter().map(Vec::len).sum::<usize>(), 400);
    }
}
