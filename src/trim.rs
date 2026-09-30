// sessionkit trim --measure — would cutting a large tool result down to the task, before it
// enters the context, keep what the assistant needs?
//
// A tool result stays in the context for every later call. The idea: split a large Bash output
// or Read into blocks of lines, keep the first and last blocks and, for Bash, blocks with an
// error line, and let Jev (TypeSafe) judge the rest in one Choice. This runs that selection over
// large results in earlier transcripts and compares it with what the assistant did next: a block
// counts as used when a later Edit changes text from it, a later Read reads its lines again, or
// a later call or text names a code name that first appeared in it.
//
// Measured on 2026-09-30: a Noul per block ranked used blocks below unused ones; one Choice over
// the blocks reached an AUC of 0.61 inside a result. Too weak to cut live, so there is no hook.

use crate::Result;
use crate::compact::{Message, goal, read_segments};
use crate::js;
use crate::start::{PRICE_PER_MILLION_TOKENS, ask_choice, session_files};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::LazyLock;

const USAGE: &str = "Usage: sessionkit trim --measure [results] [--verbose]

Measures whether cutting a large tool result down to the task would keep what the assistant
needs: Jev (TypeSafe) judges the blocks of lines of large Bash and Read results in earlier
transcripts, and the judgment is compared with what the assistant used afterwards.

  --measure   the number of results to judge (default 40; costs money)
  --verbose   with --measure: a line per judged block
  -h, --help  show this help";

const MIN_BASH_CHARS: usize = 10_000;
const MIN_READ_CHARS: usize = 20_000;
const BLOCK_LINES: usize = 40;
const BLOCK_CHARS: usize = 4000;
const CHOICE_CHARS: usize = 60_000; // all options together, inside one request
const AFTER_MESSAGES: usize = 30;
const PER_SESSION: usize = 3;

static ERROR_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(error|errors|failed|failure|panic|panicked|exception|traceback|fatal)\b").unwrap());
static LINE_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d+)\t").unwrap());
static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z_][A-Za-z0-9_./:-]*[A-Za-z0-9_]").unwrap());
// A name of code, a path or a key, not a word of prose: long enough, with a mark that words lack.
static CODE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[_./:0-9]|[a-z][A-Z]").unwrap());

fn code_names(text: &str) -> HashSet<&str> {
    NAME.find_iter(text).map(|m| m.as_str()).filter(|name| name.len() >= 8 && CODE_NAME.is_match(name)).collect()
}

pub struct Block {
    pub first: usize, // line in the result, from 1
    pub last: usize,
    pub text: String,
    pub always: bool,
}

/// The result in blocks of at most BLOCK_LINES lines and about BLOCK_CHARS characters.
pub fn blocks_of(text: &str, tool: &str) -> Vec<Block> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut blocks = Vec::new();
    let mut start = 0;
    while start < lines.len() {
        let mut end = start;
        let mut chars = 0;
        while end < lines.len() && end - start < BLOCK_LINES && (end == start || chars + js::len(lines[end]) <= BLOCK_CHARS) {
            chars += js::len(lines[end]) + 1;
            end += 1;
        }
        let text = lines[start..end].join("\n");
        let always = tool == "Bash" && ERROR_LINE.is_match(&text);
        blocks.push(Block { first: start + 1, last: end, text, always });
        start = end;
    }
    let count = blocks.len();
    if let Some(first) = blocks.first_mut() {
        first.always = true;
    }
    if count > 1 {
        blocks[count - 1].always = true;
    }
    blocks
}

pub fn threshold_of(tool: &str) -> Option<usize> {
    match tool {
        "Bash" => Some(MIN_BASH_CHARS),
        "Read" => Some(MIN_READ_CHARS),
        _ => None,
    }
}

fn input_line(tool: &str, input: &Value) -> String {
    let text = match tool {
        "Bash" => js::str_of(input, "command").to_string(),
        "Read" => js::str_of(input, "file_path").to_string(),
        _ => js::stringify(input),
    };
    js::clip(&text, 500)
}

pub struct Context<'a> {
    pub tool: &'a str,
    pub input: &'a Value,
    pub task: &'a str,
    pub before: &'a str,
    /// The last steps before the call: what was said and which tools ran, oldest first.
    pub recent: &'a [Value],
}

/// Jev's probability per block that the task is about it, from one Choice over the blocks, so
/// they add up to 1; None for a block that always stays. Measured: a Noul per block, asked whether
/// the assistant needs it or whether the task is about it, ranked used blocks below unused ones.
/// One Choice over all judged blocks: which part is the task about. Each block gets its probability.
fn judge_choice(state: &Value, blocks: &[Block], asked: &[usize]) -> Result<(Vec<f64>, f64)> {
    let per_block = (CHOICE_CHARS / asked.len().max(1)).clamp(200, 1500);
    let mut criteria = serde_json::Map::new();
    for &i in asked {
        criteria.insert(format!("lines_{}_{}", blocks[i].first, blocks[i].last), js::clip(&blocks[i].text, per_block).into());
    }
    let question = json!({
        "instructions": "The assistant ran `tool` with `input` while it worked on `task`. Its output comes in parts. \
            Which part shows the code, data, setting or message that the task is about?",
        "criteria": criteria,
    });
    let (answer, used) = ask_choice(state, question)?;
    let probabilities = answer.as_ref().and_then(|a| a.get("probabilities")).cloned().unwrap_or(Value::Null);
    Ok((asked.iter().map(|&i| probabilities.get(format!("lines_{}_{}", blocks[i].first, blocks[i].last)).and_then(Value::as_f64).unwrap_or(0.0)).collect(), used))
}

pub fn judge(context: &Context, blocks: &[Block]) -> Result<(Vec<Option<f64>>, f64)> {
    let asked: Vec<usize> = (0..blocks.len()).filter(|&i| !blocks[i].always).collect();
    let mut result = vec![None; blocks.len()];
    if asked.is_empty() {
        return Ok((result, 0.0));
    }
    let state = json!({
        "task": js::clip(context.task, 1500),
        "before": js::clip(context.before, 1500),
        "tool": context.tool,
        "input": input_line(context.tool, context.input),
        "recent_steps": context.recent,
    });
    let (probabilities, used) = judge_choice(&state, blocks, &asked)?;
    for (&i, p) in asked.iter().zip(probabilities) {
        result[i] = Some(p);
    }
    Ok((result, used))
}

/// Per block, the probability of the blocks ranked above it; a block stays while that is below the mass.
pub fn mass_before(fits: &[Option<f64>]) -> Vec<Option<f64>> {
    let mut order: Vec<usize> = (0..fits.len()).filter(|&i| fits[i].is_some()).collect();
    order.sort_by(|&a, &b| fits[b].unwrap().total_cmp(&fits[a].unwrap()));
    let mut result = vec![None; fits.len()];
    let mut sum = 0.0;
    for i in order {
        result[i] = Some(sum);
        sum += fits[i].unwrap();
    }
    result
}

/// The first line number a Read shows in a block, as its own numbering (cat -n) gives it.
fn file_line(block: &Block) -> Option<usize> {
    block.text.split('\n').find_map(|line| LINE_NUMBER.captures(line)?.get(1)?.as_str().parse().ok())
}

// ---------------------------------------------------------------- measuring

#[derive(Clone, Copy, PartialEq, Debug)]
enum Use {
    Edited,
    Reread,
    Named,
    Unused,
}

fn without_numbers(text: &str) -> String {
    text.split('\n').map(|line| LINE_NUMBER.replace(line, "").into_owned()).collect::<Vec<_>>().join("\n")
}

/// The lines of text a later Edit replaced, long enough to point at one place.
fn edited_lines(message: &Message) -> Vec<String> {
    let mut lines = Vec::new();
    for tool in message.uses.iter().filter(|u| ["Edit", "MultiEdit"].contains(&u.tool.as_str())) {
        let edits = tool.input.get("edits").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![tool.input.clone()]);
        for edit in edits {
            lines.extend(js::str_of(&edit, "old_string").split('\n').map(js::trim).filter(|l| js::len(l) >= 20).map(str::to_string));
        }
    }
    lines
}

/// What the assistant did with each judged block in the messages after the result.
fn uses(tool: &str, input: &Value, blocks: &[Block], before: &str, after: &[Message]) -> Vec<Use> {
    let file = js::str_of(input, "file_path");
    let edits: Vec<String> = after.iter().flat_map(edited_lines).collect();
    let rereads: Vec<(usize, usize)> = after.iter().flat_map(|m| &m.uses)
        .filter(|u| tool == "Read" && u.tool == "Read" && js::str_of(&u.input, "file_path") == file)
        .filter_map(|u| {
            let offset = u.input.get("offset").and_then(Value::as_u64)? as usize;
            Some((offset, offset + u.input.get("limit").and_then(Value::as_u64).unwrap_or(2000) as usize))
        }).collect();
    let later: String = after.iter().flat_map(|m| std::iter::once(m.text.clone()).chain(m.uses.iter().map(|u| js::stringify(&u.input))))
        .collect::<Vec<_>>().join("\n");
    // A name counts for one block only: one that appears in several says nothing about which.
    let names: Vec<HashSet<&str>> = blocks.iter().map(|b| code_names(&b.text)).collect();
    let mut seen_in: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for set in &names {
        for name in set {
            *seen_in.entry(name).or_default() += 1;
        }
    }
    blocks.iter().zip(&names).map(|(block, names)| {
        let plain = without_numbers(&block.text);
        if edits.iter().any(|line| plain.contains(line.as_str())) {
            return Use::Edited;
        }
        if let (Some(from), Some(to)) = (file_line(block), block.text.split('\n').rev().find_map(|l| LINE_NUMBER.captures(l)?.get(1)?.as_str().parse::<usize>().ok())) {
            if rereads.iter().any(|&(start, end)| start <= to && from < end) {
                return Use::Reread;
            }
        }
        let named = names.iter().any(|name| seen_in.get(name) == Some(&1) && !before.contains(name) && later.contains(name));
        if named { Use::Named } else { Use::Unused }
    }).collect()
}

struct Sample {
    tool: String,
    input: Value,
    task: String,
    before: String,
    recent: Vec<Value>,
    blocks: Vec<Block>,
    uses: Vec<Use>,
}

const RECENT_STEPS: usize = 12;

/// The last steps before message `at`: texts and tool calls, without their results.
pub fn recent_steps(messages: &[Message], at: usize) -> Vec<Value> {
    let mut steps: Vec<Value> = messages[..at].iter().rev().flat_map(|m| {
        let mut parts: Vec<Value> = m.uses.iter().rev().map(|u| json!({"tool": u.tool, "input": js::clip(&input_line(&u.tool, &u.input), 300)})).collect();
        if !js::trim(&m.text).is_empty() && m.results.is_empty() {
            parts.push(json!({m.role.clone(): js::clip(&m.text, 600)}));
        }
        parts
    }).take(RECENT_STEPS).collect();
    steps.reverse();
    steps
}

/// Large results of Bash and Read in a stretch of conversation, with what came after them.
fn samples_of(messages: &[Message], per_session: usize) -> Vec<Sample> {
    let mut samples = Vec::new();
    for (i, message) in messages.iter().enumerate() {
        for result in &message.results {
            if samples.len() >= per_session || result.is_error {
                continue;
            }
            let Some(call) = messages[..i].iter().rev().flat_map(|m| &m.uses).find(|u| u.id == result.id) else { continue };
            if threshold_of(&call.tool).is_none_or(|min| js::len(&result.text) < min) || i + 3 >= messages.len() {
                continue;
            }
            // What the assistant knew before: a name from there says nothing about this result.
            let mut before_text: String = messages[..i].iter()
                .flat_map(|m| std::iter::once(m.text.as_str()).chain(m.results.iter().map(|r| r.text.as_str())))
                .collect::<Vec<_>>().join("\n");
            before_text.push_str(&js::stringify(&call.input));
            let said = messages[..i].iter().rev().find(|m| m.role == "assistant" && !js::trim(&m.text).is_empty()).map_or("", |m| &m.text);
            let blocks = blocks_of(&result.text, &call.tool);
            let after = &messages[i + 1..(i + 1 + AFTER_MESSAGES).min(messages.len())];
            let uses = uses(&call.tool, &call.input, &blocks, &before_text, after);
            samples.push(Sample { tool: call.tool.clone(), input: call.input.clone(), task: goal(&messages[..i]), before: said.to_string(),
                recent: recent_steps(messages, i), blocks, uses });
        }
    }
    samples
}

fn auc(used: &[f64], unused: &[f64]) -> Option<f64> {
    if used.is_empty() || unused.is_empty() {
        return None;
    }
    let wins: f64 = used.iter().map(|u| unused.iter().map(|n| if u > n { 1.0 } else if u == n { 0.5 } else { 0.0 }).sum::<f64>()).sum();
    Some(wins / (used.len() * unused.len()) as f64)
}

fn measure(max: usize, verbose: bool) -> Result<()> {
    let paths = session_files(true, usize::MAX)?;
    let found = js::pool(&paths, 8, |path, _| {
        read_segments(path).unwrap_or_default().iter().flat_map(|segment| samples_of(segment, PER_SESSION)).take(PER_SESSION).collect::<Vec<_>>()
    });
    // Spread over sessions: newest first, a few per session.
    let samples: Vec<Sample> = found.into_iter().flatten().filter(|s| s.uses.iter().zip(&s.blocks).any(|(u, b)| !b.always && *u != Use::Unused)).take(max).collect();
    if samples.is_empty() {
        return Err("No large Bash or Read results with a used block found.".into());
    }
    let judged = js::pool(&samples, 4, |sample, _| {
        judge(&Context { tool: &sample.tool, input: &sample.input, task: &sample.task, before: &sample.before, recent: &sample.recent }, &sample.blocks)
    });
    let (mut used, mut unused, mut tokens) = (Vec::new(), Vec::new(), 0.0);
    let mut within = Vec::new(); // the AUC inside each result that has both kinds of block
    let (mut total_chars, mut judged_chars) = (0usize, Vec::new());
    for (sample, result) in samples.iter().zip(judged) {
        let (fits, spent) = result?;
        tokens += spent;
        let before = mass_before(&fits);
        let judged: Vec<(f64, bool)> = fits.iter().zip(&sample.uses).filter_map(|(p, how)| Some(((*p)?, *how != Use::Unused))).collect();
        let (yes, no): (Vec<&(f64, bool)>, Vec<&(f64, bool)>) = judged.iter().partition(|b| b.1);
        if let Some(a) = auc(&yes.iter().map(|b| b.0).collect::<Vec<_>>(), &no.iter().map(|b| b.0).collect::<Vec<_>>()) {
            within.push(a);
        }
        for (((block, fit), how), above) in sample.blocks.iter().zip(&fits).zip(&sample.uses).zip(&before) {
            total_chars += js::len(&block.text) + 1;
            let (Some(p), Some(above)) = (fit, above) else { continue };
            judged_chars.push((*above, js::len(&block.text) + 1, *how));
            if *how == Use::Unused { unused.push(-above) } else { used.push(-above) }
            if verbose {
                eprintln!("  {} {}  {:<7} {:<5} lines {}-{}  {}", js::fixed(*p, 2), js::fixed(*above, 2), format!("{how:?}"), sample.tool, block.first, block.last,
                    js::clip(&js::collapse_space(&input_line(&sample.tool, &sample.input)), 60));
            }
        }
    }
    let count = |how: Use| judged_chars.iter().filter(|b| b.2 == how).count();
    println!("{} large results ({} Bash, {} Read), {} blocks judged: {} edited, {} read again, {} named, {} unused",
        samples.len(), samples.iter().filter(|s| s.tool == "Bash").count(), samples.iter().filter(|s| s.tool == "Read").count(),
        judged_chars.len(), count(Use::Edited), count(Use::Reread), count(Use::Named), count(Use::Unused));
    // A lower mass above a block ranks it higher; negate it so that higher means likelier kept.
    let of = |how: Use| judged_chars.iter().filter(|b| b.2 == how).map(|b| -b.0).collect::<Vec<_>>();
    let show = |value: Option<f64>| value.map_or("—".into(), |a| js::fixed(a, 2));
    println!("AUC inside a result, averaged over {}: {}", within.len(), show((!within.is_empty()).then(|| within.iter().sum::<f64>() / within.len() as f64)));
    println!("AUC used against unused: {} (edited {}, read again {}, named {})", show(auc(&used, &unused)),
        show(auc(&of(Use::Edited), &unused)), show(auc(&of(Use::Reread), &unused)), show(auc(&of(Use::Named), &unused)));
    println!();
    println!("   mass  used kept  unused cut  output cut");
    for mass in [0.5, 0.7, 0.8, 0.9, 0.95, 0.98] {
        let kept_used = used.iter().filter(|p| -**p < mass).count();
        let cut_unused = unused.iter().filter(|p| -**p >= mass).count();
        let cut_chars: usize = judged_chars.iter().filter(|b| b.0 >= mass).map(|b| b.1).sum();
        println!("{:>7}  {:>9}  {:>10}  {:>10}", js::fixed(mass, 2),
            format!("{}%", js::round(100.0 * kept_used as f64 / used.len().max(1) as f64)),
            format!("{}%", js::round(100.0 * cut_unused as f64 / unused.len().max(1) as f64)),
            format!("{}%", js::round(100.0 * cut_chars as f64 / total_chars.max(1) as f64)));
    }
    println!();
    println!("mass: blocks stay from the likeliest down until their probabilities add up to this.");
    println!("used kept: blocks the assistant used afterwards that stay. output cut: of all characters of these results.");
    println!("Jev: ${}", js::fixed(tokens / 1e6 * PRICE_PER_MILLION_TOKENS, 4));
    Ok(())
}

pub fn trim_main(argv: &[String]) -> Result<()> {
    match argv.first().map(String::as_str) {
        Some("--measure") => {
            let max = argv.get(1).and_then(|n| n.parse().ok()).unwrap_or(40);
            measure(max, argv.iter().any(|a| a == "--verbose"))
        }
        _ => {
            println!("{USAGE}");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbered(lines: usize) -> String {
        (1..=lines).map(|n| format!("{n:>6}\tline {n}")).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn the_first_and_last_blocks_and_error_blocks_always_stay() {
        let mut lines: Vec<String> = (1..=200).map(|n| format!("step {n} ok")).collect();
        lines[100] = "error: could not compile".into();
        let blocks = blocks_of(&lines.join("\n"), "Bash");
        assert_eq!(blocks.len(), 5);
        assert_eq!(blocks.iter().map(|b| b.always).collect::<Vec<_>>(), [true, false, true, false, true]);
        assert_eq!((blocks[2].first, blocks[2].last), (81, 120));
    }

    #[test]
    fn only_names_of_code_count_not_words() {
        let names = code_names("the existing controller calls ownerUserId in app/Http/Kernel.php with LIBXML_NONET, explicitly.");
        assert_eq!(names, HashSet::from(["ownerUserId", "app/Http/Kernel.php", "LIBXML_NONET"]));
    }

    #[test]
    fn blocks_stay_from_the_likeliest_down_until_the_mass() {
        let before = mass_before(&[None, Some(0.125), Some(0.5), Some(0.375)]);
        assert_eq!(before, [None, Some(0.875), Some(0.0), Some(0.5)]);
    }

    #[test]
    fn a_block_is_used_when_a_later_edit_changes_its_text() {
        let text = numbered(120);
        let blocks = blocks_of(&text, "Read");
        let edit = Message { role: "assistant".into(), text: String::new(), results: Vec::new(), uses: vec![crate::compact::ToolUse {
            id: "e".into(), tool: "Edit".into(), input: json!({"old_string": "line 57 is long enough"}), text: None, is_error: false }] };
        let blocks = blocks.into_iter().map(|b| if b.first == 41 { Block { text: b.text.replace("line 57", "line 57 is long enough"), ..b } } else { b }).collect::<Vec<_>>();
        let found = uses("Read", &json!({"file_path": "/p/a.rs"}), &blocks, "", &[edit]);
        assert_eq!(found, [Use::Unused, Use::Edited, Use::Unused]);
    }
}
