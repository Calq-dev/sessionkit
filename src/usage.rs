// sessionkit usage — where the tokens and the money go in your Claude Code sessions.
//
// Reads the transcripts under ~/.claude/projects, main sessions and their subagents, and adds up
// the usage that every API call records: uncached input, cache reads, cache writes (5 minutes and
// 1 hour) and output. Everything stays on this machine; no model is asked anything.
//
// Costs are API-equivalent: token counts times the published per-token prices. With a
// subscription you pay a flat fee instead, so read them as the value of what you used.
//
// Claude Code's own "cost-state" per session is not used: it counts per process, so a resumed
// session starts again, and totals from it came out both too low and too high.

use crate::Result;
use crate::js::{self, num, opt};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::BufRead;
use std::path::PathBuf;

const CACHE_TTL_MS: f64 = 5.0 * 60.0 * 1000.0;
const REBUILD_MIN_TOKENS: f64 = 20000.0; // a cache write this large after a pause rebuilds the context
const FRESH_CONTEXT_TOKENS: f64 = 15000.0; // about what sessionkit start hands a new session
const RESTART_MIN_CONTEXT: f64 = 150000.0;
const RESTART_RECENT_DAYS: f64 = 14.0;
const CONCURRENCY: usize = 8;

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

pub fn projects_dir() -> PathBuf {
    home().join(".claude").join("projects")
}

/// USD per million tokens, from the Claude API model table (cached 2026-06-24). Cache writes cost
/// 1.25x input for 5 minutes and 2x for 1 hour; cache reads 0.1x input unless a model sets its own.
/// Fast mode costs twice the standard price.
#[derive(Clone, Copy)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub read: Option<f64>,
}

const PRICES: &[(&str, Price)] = &[
    ("claude-fable-5-1", Price { input: 10.0, output: 50.0, read: Some(0.25) }),
    ("claude-mythos-5-1", Price { input: 10.0, output: 50.0, read: Some(0.25) }),
    ("claude-fable-5", Price { input: 10.0, output: 50.0, read: None }),
    ("claude-mythos-5", Price { input: 10.0, output: 50.0, read: None }),
    ("claude-opus-5-5", Price { input: 4.0, output: 20.0, read: Some(0.2) }),
    ("claude-opus-5", Price { input: 5.0, output: 25.0, read: None }),
    ("claude-opus-4-8", Price { input: 5.0, output: 25.0, read: None }),
    ("claude-opus-4-7", Price { input: 5.0, output: 25.0, read: None }),
    ("claude-opus-4-6", Price { input: 5.0, output: 25.0, read: None }),
    ("claude-sonnet-5", Price { input: 2.0, output: 10.0, read: None }),
    ("claude-sonnet-4-6", Price { input: 3.0, output: 15.0, read: None }),
    ("claude-haiku-4-5", Price { input: 1.0, output: 5.0, read: None }),
];

const USAGE: &str = "Usage: sessionkit usage [options]

Shows where the tokens and the money go in your Claude Code sessions: by kind of token, by
model, main sessions against subagents, by project, the largest sessions, cold cache rebuilds,
and sessions that are cheaper to restart than to continue. Local only.

Options:
  --days <n>        only API calls from the last n days (default: all)
  --project <text>  only projects whose folder contains this text
  --top <n>         rows per table (default 10)
  --json            print the numbers as JSON
  -h, --help        show this help";

struct Options {
    days: f64,
    project: String,
    top: usize,
    json: bool,
}

fn parse_arguments(argv: &[String]) -> Options {
    let mut options = Options { days: f64::NAN, project: String::new(), top: 10, json: false };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--days" => {
                i += 1;
                options.days = js::parse_number(argv.get(i).map(String::as_str));
            }
            "--project" => {
                i += 1;
                options.project = argv.get(i).cloned().unwrap_or_default().to_lowercase();
            }
            "--top" => {
                i += 1;
                let top = js::parse_number(argv.get(i).map(String::as_str));
                options.top = if js::truthy_number(top) { top.max(1.0) as usize } else { 10 };
            }
            "--json" => options.json = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => {
                eprintln!("sessionkit usage: unknown option {other}\n\n{USAGE}");
                std::process::exit(2);
            }
        }
        i += 1;
    }
    options
}

// ---------------------------------------------------------------- prices

pub fn price_of(model: Option<&str>) -> Option<Price> {
    let model = model?;
    let find = |name: &str| PRICES.iter().find(|(key, _)| *key == name).map(|(_, price)| *price);
    find(model).or_else(|| {
        let bytes = model.as_bytes();
        let dated = bytes.len() > 9 && bytes[bytes.len() - 9] == b'-' && bytes[bytes.len() - 8..].iter().all(u8::is_ascii_digit);
        if dated { find(&model[..model.len() - 9]) } else { None }
    })
}

pub fn read_price(price: &Price) -> f64 {
    price.read.unwrap_or(price.input * 0.1)
}

#[derive(Clone)]
struct Call {
    time: f64,
    model: Option<String>,
    fast: bool,
    input: f64,
    read: f64,
    write5m: f64,
    write1h: f64,
    output: f64,
}

#[derive(Clone, Copy, Default)]
struct Parts {
    input: f64,
    read: f64,
    write: f64,
    output: f64,
}

impl Parts {
    /// Added in the order of KINDS: read, write, output, input.
    fn sum(&self) -> f64 {
        0.0 + self.read + self.write + self.output + self.input
    }

    fn json(&self) -> Value {
        json!({"input": num(self.input), "read": num(self.read), "write": num(self.write), "output": num(self.output)})
    }
}

/// The cost of one call in USD, split by kind of token; None when the model has no price.
fn cost_of(call: &Call) -> Option<Parts> {
    let price = price_of(call.model.as_deref())?;
    let factor = if call.fast { 2.0 } else { 1.0 };
    let part = |tokens: f64, per_million: f64| (tokens * per_million * factor) / 1e6;
    Some(Parts {
        input: part(call.input, price.input),
        read: part(call.read, read_price(&price)),
        write: part(call.write5m, price.input * 1.25) + part(call.write1h, price.input * 2.0),
        output: part(call.output, price.output),
    })
}

// ---------------------------------------------------------------- reading

/// The project a folder belongs to: its path under home, without a worktree suffix.
fn project_of(cwd: &str, folder: &str) -> String {
    if cwd.is_empty() {
        return folder.to_string();
    }
    let mut root = cwd;
    for marker in ["/.claude/worktrees/", "/.worktrees/"] {
        if let Some(at) = root.find(marker) {
            root = &root[..at];
        }
    }
    let home = home().to_string_lossy().into_owned();
    match root.strip_prefix(&format!("{home}/")) {
        Some(rest) => format!("~/{rest}"),
        None => root.to_string(),
    }
}

struct TranscriptFile {
    path: PathBuf,
    folder: String,
    session: String,
    subagent: bool,
}

/// Every transcript: main sessions, and the subagents stored beside them.
fn transcript_files() -> Result<Vec<TranscriptFile>> {
    let mut files = Vec::new();
    let projects = projects_dir();
    for folder in js::read_dir_names(&projects)? {
        let dir = projects.join(&folder);
        for entry in js::read_dir_sorted(&dir) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_file() && name.ends_with(".jsonl") {
                let session = name[..name.len() - 6].to_string();
                files.push(TranscriptFile { path: dir.join(&name), folder: folder.clone(), session, subagent: false });
            } else if kind.is_dir() {
                let subagents = dir.join(&name).join("subagents");
                if !subagents.exists() {
                    continue;
                }
                for sub in js::read_dir_names(&subagents).unwrap_or_default().into_iter().filter(|file| file.ends_with(".jsonl")) {
                    files.push(TranscriptFile { path: subagents.join(sub), folder: folder.clone(), session: name.clone(), subagent: true });
                }
            }
        }
    }
    Ok(files)
}

struct Transcript<'a> {
    file: &'a TranscriptFile,
    calls: Vec<Call>,
    title: String,
    cwd: String,
}

/// The API calls in one transcript with their ids, before calls seen elsewhere are dropped.
fn read_calls<'a>(file: &'a TranscriptFile) -> Result<(Transcript<'a>, Vec<String>)> {
    let handle = std::fs::File::open(&file.path).map_err(|error| format!("{error}, open '{}'", file.path.display()))?;
    let mut calls = Vec::new();
    let mut ids = Vec::new();
    let (mut title, mut cwd) = (String::new(), String::new());
    for line in std::io::BufReader::new(handle).split(b'\n') {
        let Ok(line) = line else { break };
        let line = String::from_utf8_lossy(&line);
        let line = line.strip_suffix('\r').unwrap_or(&line);
        if !line.contains("\"usage\"") && !line.contains("\"ai-title\"") {
            continue;
        }
        let Some(entry) = js::parse(line) else { continue };
        let kind = js::str_of(&entry, "type");
        if kind == "ai-title" && js::truthy(entry.get("aiTitle")) {
            title = js::str_of(&entry, "aiTitle").to_string();
        }
        if kind != "assistant" {
            continue;
        }
        if js::truthy(entry.get("cwd")) && cwd.is_empty() {
            cwd = js::str_of(&entry, "cwd").to_string();
        }
        let empty = json!({});
        let message = entry.get("message").filter(|m| !m.is_null()).unwrap_or(&empty);
        let usage = message.get("usage").filter(|u| js::truthy(Some(u)));
        let id = message.get("id").filter(|v| !v.is_null()).or_else(|| entry.get("requestId")).filter(|v| js::truthy(Some(v)));
        let model = message.get("model").and_then(Value::as_str);
        // Claude Code writes "<synthetic>" messages itself; they are not API calls.
        let (Some(usage), Some(id)) = (usage, id) else { continue };
        if model == Some("<synthetic>") {
            continue;
        }
        let write = js::num_of(usage, "cache_creation_input_tokens");
        let split = usage.get("cache_creation").cloned().unwrap_or(json!({}));
        let write1h = js::num_of(&split, "ephemeral_1h_input_tokens");
        ids.push(id.as_str().map_or_else(|| id.to_string(), str::to_string));
        calls.push(Call {
            time: js::parse_date(js::str_of(&entry, "timestamp")),
            model: model.map(str::to_string),
            fast: usage.get("speed").and_then(Value::as_str) == Some("fast"),
            input: js::num_of(usage, "input_tokens"),
            read: js::num_of(usage, "cache_read_input_tokens"),
            write5m: split.get("ephemeral_5m_input_tokens").and_then(Value::as_f64).unwrap_or(write - write1h),
            write1h,
            output: js::num_of(usage, "output_tokens"),
        });
    }
    Ok((Transcript { file, calls, title, cwd }, ids))
}

// ---------------------------------------------------------------- adding up

#[derive(Clone, Default)]
struct Totals {
    calls: usize,
    tokens: Parts,
    cost: Parts,
    unpriced: f64,
}

impl Totals {
    fn add(&mut self, call: &Call) {
        self.calls += 1;
        self.tokens.input += call.input;
        self.tokens.read += call.read;
        self.tokens.write += call.write5m + call.write1h;
        self.tokens.output += call.output;
        let Some(cost) = cost_of(call) else {
            self.unpriced += call.input + call.read + call.write5m + call.write1h + call.output;
            return;
        };
        self.cost.read += cost.read;
        self.cost.write += cost.write;
        self.cost.output += cost.output;
        self.cost.input += cost.input;
    }

    fn fields(&self) -> serde_json::Map<String, Value> {
        let Value::Object(map) = json!({
            "calls": self.calls, "tokens": self.tokens.json(), "cost": self.cost.json(), "unpriced": num(self.unpriced),
        }) else { unreachable!() };
        map
    }

    fn json(&self) -> Value {
        Value::Object(self.fields())
    }

    fn json_with(&self, key: &str, name: &str) -> Value {
        let mut map = serde_json::Map::new();
        map.insert(key.into(), name.into());
        map.extend(self.fields());
        Value::Object(map)
    }
}

fn context_of(call: &Call) -> f64 {
    call.input + call.read + call.write5m + call.write1h
}

struct Rebuild {
    gap: f64,
    tokens: f64,
    cost: f64,
}

/// Cold cache rebuilds in a main session: a call after a pause longer than the cache lifetime
/// that writes a large context and reads less than it writes. A heuristic: a changed prompt
/// prefix also rewrites the cache without a pause.
fn rebuilds_of(calls: &[Call]) -> Vec<Rebuild> {
    let mut rebuilds = Vec::new();
    for pair in calls.windows(2) {
        let call = &pair[1];
        let gap = call.time - pair[0].time;
        let write = call.write5m + call.write1h;
        if gap > CACHE_TTL_MS && write >= REBUILD_MIN_TOKENS && write > call.read {
            rebuilds.push(Rebuild { gap, tokens: write, cost: cost_of(call).map_or(0.0, |cost| cost.write) });
        }
    }
    rebuilds
}

struct SessionTotals {
    id: String,
    project: String,
    title: String,
    main: Totals,
    subagents: Totals,
    calls: Vec<Call>,
}

struct SessionRow {
    id: String,
    project: String,
    title: String,
    cost: f64,
    subagent_cost: f64,
    calls: usize,
    average_context: f64,
    last_context: f64,
    last_active: f64,
    rebuilds: usize,
    rebuild_cost: f64,
    per_call_now: Option<f64>,
    per_call_fresh: Option<f64>,
    cold_resume: Option<f64>,
}

impl SessionRow {
    fn json(&self) -> Value {
        json!({
            "id": self.id, "project": self.project, "title": self.title, "cost": num(self.cost),
            "subagentCost": num(self.subagent_cost), "calls": self.calls, "averageContext": num(self.average_context),
            "lastContext": num(self.last_context), "lastActive": num(self.last_active), "rebuilds": self.rebuilds,
            "rebuildCost": num(self.rebuild_cost), "perCallNow": opt(self.per_call_now),
            "perCallFresh": opt(self.per_call_fresh), "coldResume": opt(self.cold_resume),
        })
    }
}

struct Report {
    window: String,
    transcripts: usize,
    total: Totals,
    by_model: Vec<(String, Totals)>,
    by_kind: [Totals; 2],
    by_project: Vec<(String, Totals)>,
    sessions: Vec<SessionRow>,
    rebuilds: (usize, f64, f64, usize),
    restart_candidates: Vec<usize>,
    unpriced_models: Vec<String>,
}

fn by_cost_desc(a: &Totals, b: &Totals) -> std::cmp::Ordering {
    b.cost.sum().partial_cmp(&a.cost.sum()).unwrap_or(std::cmp::Ordering::Equal)
}

fn summarize(transcripts: &[Transcript], options: &Options) -> Report {
    let days = options.days;
    let since = if js::truthy_number(days) { js::now() - days * 86400000.0 } else { 0.0 };
    let mut total = Totals::default();
    let mut by_model: IndexMap<String, Totals> = IndexMap::new();
    let mut by_kind = [Totals::default(), Totals::default()];
    let mut by_project: IndexMap<String, Totals> = IndexMap::new();
    let mut sessions: IndexMap<String, SessionTotals> = IndexMap::new();
    let mut unpriced_models: IndexSet<String> = IndexSet::new();

    for transcript in transcripts {
        let file = transcript.file;
        let project = project_of(&transcript.cwd, &file.folder);
        if !options.project.is_empty() && !format!("{project} {}", file.folder).to_lowercase().contains(&options.project) {
            continue;
        }
        let mut calls: Vec<Call> = transcript.calls.iter().filter(|call| call.time >= since).cloned().collect();
        calls.sort_by(|a, b| (a.time - b.time).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
        if calls.is_empty() {
            continue;
        }
        let session = sessions.entry(file.session.clone()).or_insert_with(|| SessionTotals {
            id: file.session.clone(), project: project.clone(), title: String::new(),
            main: Totals::default(), subagents: Totals::default(), calls: Vec::new(),
        });
        if !file.subagent {
            if !transcript.title.is_empty() {
                session.title = transcript.title.clone();
            }
            session.project = project.clone();
            session.calls = calls.clone();
        }
        let project_totals = by_project.entry(project).or_default();

        for call in &calls {
            total.add(call);
            by_kind[usize::from(file.subagent)].add(call);
            project_totals.add(call);
            if file.subagent { session.subagents.add(call) } else { session.main.add(call) }
            let model = call.model.clone().unwrap_or_else(|| "unknown".into());
            by_model.entry(model.clone()).or_default().add(call);
            if price_of(call.model.as_deref()).is_none() {
                unpriced_models.insert(model);
            }
        }
    }

    let recent = js::now() - RESTART_RECENT_DAYS * 86400000.0;
    let mut rows: Vec<SessionRow> = sessions.values().map(|session| {
        let calls = &session.calls;
        let rebuilds = rebuilds_of(calls);
        let last = calls.last();
        let price = last.and_then(|call| price_of(call.model.as_deref()));
        let last_context = last.map_or(0.0, context_of);
        SessionRow {
            id: session.id.clone(),
            project: session.project.clone(),
            title: session.title.clone(),
            cost: session.main.cost.sum() + session.subagents.cost.sum(),
            subagent_cost: session.subagents.cost.sum(),
            calls: session.main.calls + session.subagents.calls,
            average_context: if calls.is_empty() { 0.0 } else { calls.iter().fold(0.0, |s, call| s + context_of(call)) / calls.len() as f64 },
            last_context,
            last_active: last.map_or(0.0, |call| call.time),
            rebuilds: rebuilds.len(),
            rebuild_cost: rebuilds.iter().fold(0.0, |s, r| s + r.cost),
            // What one more call costs in cache reads now, against a fresh start of about 15k tokens.
            per_call_now: price.map(|p| (last_context * read_price(&p)) / 1e6),
            per_call_fresh: price.map(|p| (FRESH_CONTEXT_TOKENS * read_price(&p)) / 1e6),
            // What a cold --resume writes once, at the 1-hour cache price Claude Code uses.
            cold_resume: price.map(|p| (last_context * p.input * 2.0) / 1e6),
        }
    }).collect();

    let all_rebuilds: Vec<Rebuild> = sessions.values().flat_map(|session| rebuilds_of(&session.calls)).collect();
    rows.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
    let mut restart_candidates: Vec<usize> = (0..rows.len())
        .filter(|&i| rows[i].last_active >= recent && rows[i].last_context >= RESTART_MIN_CONTEXT && rows[i].per_call_now.is_some())
        .collect();
    restart_candidates.sort_by(|&a, &b| rows[b].per_call_now.partial_cmp(&rows[a].per_call_now).unwrap_or(std::cmp::Ordering::Equal));

    let mut by_model: Vec<(String, Totals)> = by_model.into_iter().collect();
    by_model.sort_by(|a, b| by_cost_desc(&a.1, &b.1));
    let mut by_project: Vec<(String, Totals)> = by_project.into_iter().collect();
    by_project.sort_by(|a, b| by_cost_desc(&a.1, &b.1));
    Report {
        window: if js::truthy_number(days) { format!("last {} days", js::number(days)) } else { "all time".into() },
        transcripts: transcripts.len(),
        total,
        by_model,
        by_kind,
        by_project,
        sessions: rows,
        rebuilds: (
            all_rebuilds.len(),
            all_rebuilds.iter().fold(0.0, |s, r| s + r.tokens),
            all_rebuilds.iter().fold(0.0, |s, r| s + r.cost),
            all_rebuilds.iter().filter(|r| r.gap > 3600000.0).count(),
        ),
        restart_candidates,
        unpriced_models: unpriced_models.into_iter().collect(),
    }
}

fn report_json(report: &Report) -> Value {
    let rows = |list: &[(String, Totals)], key: &str| Value::Array(list.iter().map(|(name, totals)| totals.json_with(key, name)).collect());
    json!({
        "window": report.window,
        "transcripts": report.transcripts,
        "total": report.total.json(),
        "byModel": rows(&report.by_model, "model"),
        "byKind": {"main": report.by_kind[0].json(), "subagent": report.by_kind[1].json()},
        "byProject": rows(&report.by_project, "project"),
        "sessions": report.sessions.iter().map(SessionRow::json).collect::<Vec<_>>(),
        "rebuilds": {
            "count": report.rebuilds.0, "tokens": num(report.rebuilds.1), "cost": num(report.rebuilds.2), "afterAnHour": report.rebuilds.3,
        },
        "restartCandidates": report.restart_candidates.iter().map(|&i| report.sessions[i].json()).collect::<Vec<_>>(),
        "unpricedModels": report.unpriced_models,
    })
}

// ---------------------------------------------------------------- printing

fn usd(value: f64) -> String {
    if value >= 100.0 { format!("${}", js::grouped(js::round(value))) } else { format!("${}", js::fixed(value, 2)) }
}

pub fn tokens(value: f64) -> String {
    if value >= 1e9 {
        format!("{}B", js::fixed(value / 1e9, 2))
    } else if value >= 1e6 {
        format!("{}M", js::fixed(value / 1e6, 1))
    } else if value >= 1e3 {
        format!("{}K", js::number(js::round(value / 1e3)))
    } else {
        js::number(value)
    }
}

fn share(part: f64, whole: f64) -> String {
    if js::truthy_number(whole) { format!("{}%", js::number(js::round((100.0 * part) / whole))) } else { "-".into() }
}

fn day(time: f64) -> String {
    if js::truthy_number(time) { js::iso(time)[..10].to_string() } else { String::new() }
}

use js::{lpad, pad};

fn table(title: &str, header: String, rows: Vec<String>) -> String {
    let rule = "-".repeat(js::len(&header));
    let mut lines = vec![String::new(), title.to_string(), String::new(), header, rule];
    lines.extend(rows);
    lines.join("\n")
}

fn render(report: &Report, options: &Options) -> String {
    let total_cost = report.total.cost.sum();
    let top = options.top;
    let mut out: Vec<String> = Vec::new();
    out.push(format!("sessionkit usage — {}: {} transcripts, {} API calls, {} API-equivalent", report.window,
        js::grouped(report.transcripts as f64), js::grouped(report.total.calls as f64), usd(total_cost)));
    out.push("Prices are the published per-token prices. With a subscription you pay a flat fee instead.".into());
    if !report.unpriced_models.is_empty() {
        out.push(format!("No price known for {}: {} tokens left out of the costs.",
            report.unpriced_models.join(", "), tokens(report.total.unpriced)));
    }

    let kinds: [(&str, f64, f64); 4] = [
        ("cache reads", report.total.tokens.read, report.total.cost.read),
        ("cache writes", report.total.tokens.write, report.total.cost.write),
        ("output", report.total.tokens.output, report.total.cost.output),
        ("uncached input", report.total.tokens.input, report.total.cost.input),
    ];
    out.push(table("Where it goes", format!("{}{}{}{}", pad("kind", 16), lpad("tokens", 10), lpad("cost", 11), lpad("share", 7)),
        kinds.iter().map(|(name, count, cost)| format!("{}{}{}{}", pad(name, 16), lpad(&tokens(*count), 10),
            lpad(&usd(*cost), 11), lpad(&share(*cost, total_cost), 7))).collect()));

    out.push(table("By model", format!("{}{}{}{}", pad("model", 26), lpad("calls", 9), lpad("cost", 11), lpad("share", 7)),
        report.by_model.iter().take(top).map(|(model, row)| format!("{}{}{}{}", pad(model, 26), lpad(&js::grouped(row.calls as f64), 9),
            lpad(&if price_of(Some(model)).is_some() { usd(row.cost.sum()) } else { "no price".into() }, 11),
            lpad(&share(row.cost.sum(), total_cost), 7))).collect()));

    out.push(table("Main sessions and subagents",
        format!("{}{}{}{}{}", pad("", 14), lpad("calls", 9), lpad("tokens", 10), lpad("cost", 11), lpad("share", 7)),
        [("main sessions", &report.by_kind[0]), ("subagents", &report.by_kind[1])].iter().map(|(name, row)| {
            let all = row.tokens.input + row.tokens.read + row.tokens.write + row.tokens.output;
            format!("{}{}{}{}{}", pad(name, 14), lpad(&js::grouped(row.calls as f64), 9), lpad(&tokens(all), 10),
                lpad(&usd(row.cost.sum()), 11), lpad(&share(row.cost.sum(), total_cost), 7))
        }).collect()));

    out.push(table("By project", format!("{}{}{}{}", pad("project", 44), lpad("calls", 9), lpad("cost", 11), lpad("share", 7)),
        report.by_project.iter().take(top).map(|(project, row)| format!("{}{}{}{}", pad(project, 44),
            lpad(&js::grouped(row.calls as f64), 9), lpad(&usd(row.cost.sum()), 11), lpad(&share(row.cost.sum(), total_cost), 7))).collect()));

    let label = |row: &SessionRow| if row.title.is_empty() { row.project.clone() } else { row.title.clone() };
    out.push(table("Largest sessions (cost includes their subagents)",
        format!("{}{}{}{}{}  {}{}id", lpad("cost", 9), lpad("subagents", 10), lpad("calls", 8), lpad("avg ctx", 9), lpad("cold", 6),
            pad("last", 11), pad("title", 38)),
        report.sessions.iter().take(top).map(|row| format!("{}{}{}{}{}  {}{} {}", lpad(&usd(row.cost), 9),
            lpad(&share(row.subagent_cost, row.cost), 10), lpad(&js::grouped(row.calls as f64), 8), lpad(&tokens(row.average_context), 9),
            lpad(&row.rebuilds.to_string(), 6), pad(&day(row.last_active), 11), pad(&label(row), 37), js::head(&row.id, 8))).collect()));

    let (count, rebuild_tokens, rebuild_cost, after_an_hour) = report.rebuilds;
    out.push(String::new());
    out.push("Cold cache rebuilds".into());
    out.push(String::new());
    out.push(format!("{count} calls wrote the context again after a pause of more than 5 minutes: {} tokens, {} ({} of the total). \
        {after_an_hour} came after more than an hour.", tokens(rebuild_tokens), usd(rebuild_cost), share(rebuild_cost, total_cost)));
    out.push("A heuristic: a large cache write after a pause, larger than the cache read in the same call.".into());

    if !report.restart_candidates.is_empty() {
        out.push(table(&format!("Cheaper to restart: active in the last {} days, last context above {}",
                js::number(RESTART_RECENT_DAYS), tokens(RESTART_MIN_CONTEXT)),
            format!("{}{}{}{}  {}command", lpad("context", 9), lpad("per call", 10), lpad("fresh", 8), lpad("cold resume", 13), pad("title", 38)),
            report.restart_candidates.iter().take(top).map(|&i| {
                let row = &report.sessions[i];
                format!("{}{}{}{}  {} sessionkit start --session {} \"…\"", lpad(&tokens(row.last_context), 9),
                    lpad(&format!("${}", js::fixed(row.per_call_now.unwrap_or(f64::NAN), 3)), 10),
                    lpad(&format!("${}", js::fixed(row.per_call_fresh.unwrap_or(f64::NAN), 3)), 8),
                    lpad(&usd(row.cold_resume.unwrap_or(f64::NAN)), 13), pad(&label(row), 37), js::head(&row.id, 8))
            }).collect()));
        out.push(String::new());
        out.push("Per call: the cache reads of one more call at the current context. Fresh: the same after a".into());
        out.push(format!("start with about {} of context. Cold resume: the one-time cache write of a --resume after a pause.",
            tokens(FRESH_CONTEXT_TOKENS)));
    }
    out.join("\n")
}

/// Read the transcripts in parallel; then keep every call once, by its message id, across all
/// files. A response with several content blocks is written as several lines with the same usage,
/// and a forked session copies earlier calls into its own file. Main sessions come first, so a
/// call copied into a subagent file keeps its main-session owner. Within each group the order of
/// the files decides; the JavaScript version let whichever file it read first win.
fn read_all(files: &[TranscriptFile]) -> Result<Vec<Transcript<'_>>> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut transcripts = Vec::with_capacity(files.len());
    for subagent in [false, true] {
        let batch: Vec<&TranscriptFile> = files.iter().filter(|file| file.subagent == subagent).collect();
        for result in js::pool(&batch, CONCURRENCY, |file, _| read_calls(file)) {
            let (mut transcript, ids) = result?;
            let calls = std::mem::take(&mut transcript.calls);
            transcript.calls = calls.into_iter().zip(ids).filter_map(|(call, id)| seen.insert(id).then_some(call)).collect();
            transcripts.push(transcript);
        }
    }
    Ok(transcripts)
}

pub fn usage_main(argv: &[String]) -> Result<()> {
    let options = parse_arguments(argv);
    let files = transcript_files()?;
    if files.is_empty() {
        return Err(format!("No transcripts found in {}.", projects_dir().display()));
    }
    let transcripts = read_all(&files)?;
    let report = summarize(&transcripts, &options);
    if report.total.calls == 0 {
        return Err("No API calls found for these options.".into());
    }
    println!("{}", if options.json { js::stringify_pretty(&report_json(&report)) } else { render(&report, &options) });
    Ok(())
}

