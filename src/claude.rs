// sessionkit statusline and sessionkit hook — show in Claude Code what the prompt cache costs.
//
// Claude Code does not show that a session with 800k tokens of context re-reads all of them on
// every call, or that the first call after an idle hour writes them all again. These commands do:
//
//   statusline           context, cost per call (or, on a subscription, the usage limits and an
//                        estimate of what one call takes from them), and the cache time
//   hook session-start   on --resume: what the first request will cost when the cache is cold
//   hook prompt          before a message to a cold, expensive session: stop it once and say why
//
// Everything here reaches the user only (the status line, systemMessage, a block reason). Nothing
// is added to Claude's context, so the checks cost no tokens.

use crate::Result;
use crate::cache::{CacheState, FIVE_MINUTES, cache_state};
use crate::js::{self, fixed, num};
use crate::next::{env_pid, handoff_key, leave_handoff, terminate};
use crate::usage::{home, price_of, read_price};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const LIMIT_SAMPLE_WINDOW: usize = 100; // the newest warm calls the estimate uses
const LIMIT_MIN_SAMPLES: usize = 5;
const LIMIT_FRESH_MS: f64 = 3.0 * 60.0 * 1000.0; // a delta over a longer gap mixes in other sessions' calls
const SOON_MS: f64 = 10.0 * 60.0 * 1000.0;

const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";
const DIM: &str = "\x1b[2m";
const RESET: &str = "\x1b[0m";

fn setting(name: &str, fallback: f64) -> f64 {
    std::env::var(format!("SESSIONKIT_{name}")).map_or(fallback, |value| js::parse_number(Some(&value)))
}

fn cache_dir() -> PathBuf {
    home().join(".cache").join("sessionkit")
}

fn read_input() -> Value {
    let mut text = String::new();
    let _ = std::io::stdin().read_to_string(&mut text);
    js::parse(&text).unwrap_or(json!({}))
}

fn tokens(value: f64) -> String {
    if value >= 1e6 { format!("{}M", fixed(value / 1e6, 1)) } else { format!("{}K", js::number(js::round(value / 1e3))) }
}

fn usd(value: f64) -> String {
    if value >= 10.0 {
        format!("${}", fixed(value, 0))
    } else if value >= 1.0 {
        format!("${}", fixed(value, 2))
    } else {
        format!("${}", fixed(value, 3))
    }
}

fn minutes(ms: f64) -> String {
    if ms >= 3600000.0 {
        format!("{}h{:0>2}", js::number((ms / 3600000.0).floor()), js::number(((ms % 3600000.0) / 60000.0).floor()))
    } else {
        format!("{}m", js::number(js::round(ms / 60000.0).max(1.0)))
    }
}

fn session_id(input: &Value) -> String {
    if let Some(id) = input.get("session_id").filter(|v| !v.is_null()) {
        return id.as_str().map_or_else(|| id.to_string(), str::to_string);
    }
    let path = js::str_of(input, "transcript_path");
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    name.strip_suffix(".jsonl").map(str::to_string).unwrap_or(name)
}

fn transcript_state(input: &Value) -> Option<CacheState> {
    let path = js::str_of(input, "transcript_path");
    if path.is_empty() || !Path::new(path).exists() { None } else { cache_state(Path::new(path)) }
}

/// The cache state, from what Claude Code hands the status line when it has it, and from the
/// transcript otherwise: before the first response of a resumed session there is no prompt_cache.
fn state_for(input: &Value) -> Option<CacheState> {
    let from_transcript = transcript_state(input);
    let usage = input.get("context_window").and_then(|w| w.get("current_usage")).filter(|u| js::truthy(Some(u)));
    let model = input.get("model").and_then(|m| m.get("id")).and_then(Value::as_str).map(str::to_string)
        .or_else(|| from_transcript.as_ref().and_then(|state| state.model.clone()));
    let price = price_of(model.as_deref());
    let context = match usage {
        Some(usage) => js::num_of(usage, "input_tokens") + js::num_of(usage, "cache_read_input_tokens")
            + js::num_of(usage, "cache_creation_input_tokens"),
        None => from_transcript.as_ref().map_or(0.0, |state| state.context),
    };
    let (true, Some(price)) = (js::truthy_number(context), price) else { return from_transcript };
    let factor = if js::truthy(input.get("fast_mode")) { 2.0 } else { 1.0 };
    let write_factor = if from_transcript.as_ref().is_some_and(|state| state.ttl == FIVE_MINUTES) { 1.25 } else { 2.0 };
    let cache = input.get("prompt_cache").filter(|c| js::truthy(Some(c)));
    let warm = match cache {
        Some(cache) => js::truthy(cache.get("warm")),
        None => from_transcript.as_ref().is_some_and(|state| state.warm),
    };
    let expires_at = cache.and_then(|c| c.get("expires_at")).and_then(Value::as_f64).filter(|&at| js::truthy_number(at));
    let left = match expires_at {
        Some(at) => (at * 1000.0 - js::now()).max(0.0),
        None => from_transcript.as_ref().map_or(0.0, |state| state.left),
    };
    Some(CacheState {
        context,
        model,
        warm,
        left,
        ttl: from_transcript.as_ref().map_or(f64::NAN, |state| state.ttl),
        last_call_time: from_transcript.as_ref().map_or(f64::NAN, |state| state.last_call_time),
        last_call_cold: from_transcript.as_ref().is_some_and(|state| state.last_call_cold),
        per_call: Some((context * read_price(&price) * factor) / 1e6),
        cold_call: Some((context * price.input * write_factor * factor) / 1e6),
    })
}

// ---------------------------------------------------------------- subscription limits

fn read_json(path: &Path) -> Option<Value> {
    js::parse(&std::fs::read_to_string(path).ok()?)
}

fn read_samples(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path).map(|text| text.split('\n').filter_map(js::parse).filter(|v| js::truthy(Some(v))).collect())
        .unwrap_or_default()
}

/// Learn what one call takes from the 5-hour limit. Anthropic does not publish how tokens map to
/// the limit, so every status line update compares the limit with the previous update of this
/// session: when one new call came in between, and that update is recent, the increase belongs
/// mostly to that call. Other sessions running at the same time add noise that stays in.
fn learn_limit(id: &str, five_hour: Option<&Value>, state: &CacheState) -> std::io::Result<()> {
    let percentage = five_hour.and_then(|five| five.get("used_percentage")).and_then(Value::as_f64);
    let (true, Some(five_hour), Some(percentage)) = (js::truthy_number(state.last_call_time), five_hour, percentage) else {
        return Ok(());
    };
    let state_dir = cache_dir().join("limit-state");
    let samples_file = cache_dir().join("limit-samples.jsonl");
    std::fs::create_dir_all(&state_dir)?;
    let path = state_dir.join(format!("{id}.json"));
    let previous = read_json(&path);
    let now = js::now();
    let resets_at = five_hour.get("resets_at").cloned();
    if let Some(previous) = previous.filter(|p| js::truthy(Some(p))) {
        let same_window = previous.get("resetsAt").cloned() == resets_at;
        let call_time = previous.get("callTime").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let seen_at = previous.get("seenAt").and_then(Value::as_f64).unwrap_or(f64::NAN);
        if same_window && state.last_call_time > call_time && now - seen_at < LIMIT_FRESH_MS {
            let before = previous.get("percentage").and_then(Value::as_f64).unwrap_or(f64::NAN);
            let delta = percentage - before;
            if (0.0..10.0).contains(&delta) {
                let sample = json!({"time": num(now), "delta": num(delta), "context": num(state.context), "cold": state.last_call_cold});
                let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&samples_file)?;
                writeln!(file, "{}", js::stringify(&sample))?;
                let samples = read_samples(&samples_file);
                if samples.len() > 4 * LIMIT_SAMPLE_WINDOW {
                    let kept: Vec<String> = samples[samples.len() - 2 * LIMIT_SAMPLE_WINDOW..].iter().map(js::stringify).collect();
                    std::fs::write(&samples_file, format!("{}\n", kept.join("\n")))?;
                }
            }
        }
    }
    let mut record = serde_json::Map::new();
    record.insert("percentage".into(), num(percentage));
    if let Some(resets_at) = resets_at {
        record.insert("resetsAt".into(), resets_at);
    }
    record.insert("callTime".into(), num(state.last_call_time));
    record.insert("seenAt".into(), num(now));
    std::fs::write(&path, js::stringify(&Value::Object(record)))
}

/// The estimated share of the 5-hour limit one warm call takes at this context, or None.
fn limit_per_call(context: f64) -> Option<f64> {
    let samples = read_samples(&cache_dir().join("limit-samples.jsonl"));
    let warm: Vec<&Value> = samples.iter().filter(|sample| !js::truthy(sample.get("cold"))).collect();
    let warm = &warm[warm.len().saturating_sub(LIMIT_SAMPLE_WINDOW)..];
    if warm.len() < LIMIT_MIN_SAMPLES {
        return None;
    }
    let field = |sample: &Value, key: &str| sample.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
    let total_context = warm.iter().fold(0.0, |sum, sample| sum + field(sample, "context"));
    if !js::truthy_number(total_context) {
        return None;
    }
    Some((warm.iter().fold(0.0, |sum, sample| sum + field(sample, "delta")) / total_context) * context)
}

fn clock(epoch_seconds: f64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt((epoch_seconds * 1000.0) as i64).single()
        .map(|time| time.format("%H:%M").to_string()).unwrap_or_default()
}

fn percent(value: f64) -> String {
    if value < 10.0 { format!("{}%", fixed(value, 1)) } else { format!("{}%", js::number(js::round(value))) }
}

fn limit_color(value: f64) -> &'static str {
    if value >= 90.0 { RED } else if value >= 70.0 { YELLOW } else { "" }
}

fn limits_text(limits: &Value) -> String {
    let mut parts = Vec::new();
    let used = |key: &str| limits.get(key).and_then(|window| window.get("used_percentage")).and_then(Value::as_f64);
    if let Some(five) = used("five_hour") {
        let resets_at = limits["five_hour"].get("resets_at").and_then(Value::as_f64).filter(|&at| js::truthy_number(at));
        let reset = resets_at.map_or(String::new(), |at| format!(" {DIM}(reset {}){RESET}", clock(at)));
        parts.push(format!("{}5h {}{RESET}{reset}", limit_color(five), percent(five)));
    }
    if let Some(seven) = used("seven_day") {
        parts.push(format!("{}7d {}{RESET}", limit_color(seven), percent(seven)));
    }
    parts.join(" · ")
}

// ---------------------------------------------------------------- the status line

/// On a subscription (Claude Code sends rate_limits), the limits and what one call takes from
/// them, next to the API value of the tokens. On an API key, the dollars.
pub fn statusline_main() -> Result<()> {
    let input = read_input();
    let Some(state) = state_for(&input) else {
        println!("{DIM}sessionkit: no calls yet{RESET}");
        return Ok(());
    };
    let context = format!("context {}", tokens(state.context));
    // The JavaScript version stopped with an error here; there is nothing to price.
    let (Some(per_call), Some(cold_call)) = (state.per_call, state.cold_call) else {
        println!("{context} · {DIM}no price known for {}{RESET}", state.model.as_deref().unwrap_or("this model"));
        return Ok(());
    };

    let limits = input.get("rate_limits").filter(|l| js::truthy(Some(l)));
    if let Some(limits) = limits.filter(|l| js::truthy(l.get("five_hour")) || js::truthy(l.get("seven_day"))) {
        let _ = learn_limit(&session_id(&input), limits.get("five_hour").filter(|f| js::truthy(Some(f))), &state);
        let estimate = limit_per_call(state.context).map_or(String::new(), |share| {
            format!(" · ≈ +{}%/call", if share < 0.1 { fixed(share, 2) } else { fixed(share, 1) })
        });
        let cache = if state.warm {
            format!("{}cache warm {}{RESET} {DIM}(cold: {}){RESET}", if state.left < SOON_MS { YELLOW } else { GREEN },
                minutes(state.left), usd(cold_call))
        } else {
            format!("{RED}cache cold: next call rewrites {} ≈ {}{RESET}", tokens(state.context), usd(cold_call))
        };
        println!("{context} · {}/call · {}{estimate} · {cache}", usd(per_call), limits_text(limits));
        return Ok(());
    }

    let per_call = format!("{}/call", usd(per_call));
    if state.warm {
        let color = if state.left < SOON_MS { YELLOW } else { GREEN };
        println!("{context} · {per_call} · {color}cache warm {}{RESET} {DIM}(cold: {}){RESET}", minutes(state.left), usd(cold_call));
    } else {
        println!("{context} · {RED}cache cold: next message ≈ {}{RESET} {DIM}· cheaper: sessionkit start --session {}{RESET}",
            usd(cold_call), js::head(&session_id(&input), 8));
    }
    Ok(())
}

/// On --resume or fork, before the first request: Claude Code's own estimate of the cache write.
fn session_start(input: &Value) -> Option<Value> {
    let source = js::str_of(input, "source");
    if !["resume", "fork"].contains(&source) || !js::truthy(input.get("prompt_cache_likely_expired")) {
        return None;
    }
    let cost = input.get("estimated_cache_write_usd").and_then(Value::as_f64).unwrap_or(f64::NAN);
    if !(cost >= setting("WARN_RESUME_ABOVE", 1.0)) {
        return None;
    }
    let seconds = input.get("seconds_since_last_response").and_then(Value::as_f64).filter(|&s| js::truthy_number(s));
    let idle = seconds.map_or(String::new(), |s| format!(" after {}", minutes(s * 1000.0)));
    Some(json!({
        "systemMessage": format!("sessionkit: the prompt cache has expired{idle}. Your first message writes \
            {} tokens to the cache again: about {}, and every later message re-reads them. Cheaper: exit and run \
            sessionkit start --session {} \"your prompt\", which starts fresh with only what matters.",
            tokens(js::num_of(input, "context_tokens")), usd(cost), js::head(&session_id(input), 8)),
    }))
}

/// Before a message to a session whose cache has gone cold, when writing the context again costs
/// more than the limit. When something in this terminal can open the next session (see next.rs),
/// close this one and continue the message in a fresh one. Else stop the message once: sending it
/// again goes through, until the next call makes the cache warm and the check starts over.
/// Returns the hook result and the Claude Code to stop once the result is out.
fn prompt(input: &Value) -> Result<Option<(Value, Option<i64>)>> {
    let Some(state) = transcript_state(input) else { return Ok(None) };
    let cold_call = state.cold_call.unwrap_or(f64::NAN);
    if state.warm || !(cold_call >= setting("BLOCK_COLD_ABOVE", 2.0)) {
        return Ok(None);
    }
    let id = session_id(input);

    let claude_pid = env_pid("CLAUDE_PID");
    let text = js::str_of(input, "prompt");
    let key = match claude_pid {
        Some(pid) if !text.is_empty() => handoff_key(pid)?,
        _ => None,
    };
    if let Some(key) = key {
        leave_handoff(&key, &id, text);
        return Ok(Some((json!({
            "decision": "block",
            "reason": format!("sessionkit: the prompt cache of this session has expired. This message would write \
                {} tokens to the cache again: about {}. Closing this session; your message continues in a fresh \
                one with only what matters.", tokens(state.context), usd(cold_call)),
        }), claude_pid)));
    }

    let ack_dir = cache_dir().join("cold-ack");
    let ack = ack_dir.join(&id);
    let marker = js::number(state.last_call_time);
    if std::fs::read_to_string(&ack).is_ok_and(|text| text == marker) {
        return Ok(None);
    }
    std::fs::create_dir_all(&ack_dir).map_err(|e| e.to_string())?;
    std::fs::write(&ack, &marker).map_err(|e| e.to_string())?;
    Ok(Some((json!({
        "decision": "block",
        "reason": format!("sessionkit: the prompt cache of this session has expired. This message would write \
            {} tokens to the cache again: about {}, and every later message re-reads them ({} each). Send the \
            message again to go ahead anyway, or exit and run sessionkit start --session {} \"your prompt\" to \
            start fresh with only what matters.", tokens(state.context), usd(cold_call),
            usd(state.per_call.unwrap_or(f64::NAN)), js::head(&id, 8)),
    }), None)))
}

pub fn hook_main(argv: &[String]) -> Result<()> {
    let input = read_input();
    // A hook must never stop Claude Code because this check failed.
    let output = match argv.first().map(String::as_str) {
        Some("session-start") => session_start(&input).map(|value| (value, None)),
        Some("prompt") => prompt(&input).ok().flatten(),
        _ => None,
    };
    let Some((value, stop)) = output else { return Ok(()) };
    // Stop Claude Code only once it has the block: then the message never reaches the model.
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{}", js::stringify(&value));
    let _ = stdout.flush();
    if let Some(pid) = stop {
        terminate(pid);
    }
    Ok(())
}
