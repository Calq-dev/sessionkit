//! Provider wire adapters. Retry/concurrency policy stays with each caller.
//! Non-Jev protocols follow the local lmnl research and require live verification.
use crate::{Result, js};
use serde_json::{Map, Value, json};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Provider {
    Jev,
    OpenRouter,
    Decisions,
    Clef,
}

impl Provider {
    pub fn selected() -> Result<Self> {
        if let Ok(value) = std::env::var("SESSIONKIT_PRICE_PER_MILLION") {
            if !value
                .parse::<f64>()
                .ok()
                .is_some_and(|p| p.is_finite() && p >= 0.0)
            {
                return Err(
                    "SESSIONKIT_PRICE_PER_MILLION must be a finite nonnegative number.".into(),
                );
            }
        }
        let selected = match std::env::var("SESSIONKIT_PROVIDER") {
            Ok(value) => value,
            Err(_) => user_configuration()?["provider"].as_str().unwrap_or("jev").to_owned(),
        };
        match selected.as_str()
        {
            "jev" => Ok(Self::Jev),
            "openrouter" => Ok(Self::OpenRouter),
            "decisions" => Ok(Self::Decisions),
            "clef" => Ok(Self::Clef),
            _ => Err(
                "SESSIONKIT_PROVIDER must be jev, openrouter, decisions or clef; no fallback provider is used."
                    .into(),
            ),
        }
    }
    pub fn id(self) -> &'static str {
        match self { Self::Jev => "jev", Self::OpenRouter => "openrouter", Self::Decisions => "decisions", Self::Clef => "clef" }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Jev => "TypeSafe",
            Self::OpenRouter => "OpenRouter",
            Self::Decisions => "OpenAI Decisions",
            Self::Clef => "Cloudflare Clef",
        }
    }
    pub fn model(self) -> String {
        std::env::var("SESSIONKIT_MODEL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                if let Ok(config) = user_configuration() {
                    if config["provider"].as_str() == Some(self.id()) {
                        if let Some(model) = config["model"].as_str() { return model.to_owned(); }
                    }
                }
                match self {
                Self::Jev => std::env::var("JEV_START_MODEL")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "jev-latest".into()),
                Self::OpenRouter => "~typesafe/jev-latest".into(),
                Self::Decisions => "gpt-6-luna".into(),
                Self::Clef => "clef".into(),
                }
            })
    }
    pub fn endpoint(self, model: &str) -> Result<String> {
        #[cfg(feature = "test-api")]
        if let Ok(url) = std::env::var("SESSIONKIT_API") {
            return Ok(url);
        }
        Ok(match self {
            Self::Jev => "https://api.typesafe.ai/v1/systemone".into(),
            Self::OpenRouter => "https://openrouter.ai/api/v1/systemone".into(),
            Self::Decisions => "https://api.openai.com/v1/decisions".into(),
            Self::Clef => {
                let account = required_env("CLOUDFLARE_ACCOUNT_ID")?;
                if !account.chars().all(|c| c.is_ascii_alphanumeric())
                    || !model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                {
                    return Err("Invalid Cloudflare account id or model name.".into());
                }
                format!(
                    "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}"
                )
            }
        })
    }
    pub fn key(self) -> Result<String> {
        match self {
            Self::Jev => crate::auth::typesafe_key(),
            Self::OpenRouter => crate::auth::openrouter_key(),
            Self::Decisions => required_env("OPENAI_API_KEY"),
            Self::Clef => required_env("CLOUDFLARE_AUTH_TOKEN"),
        }
    }
    pub fn key_at_hand(self) -> bool {
        match self {
            Self::Jev => crate::auth::typesafe_key_at_hand(),
            Self::OpenRouter => crate::auth::openrouter_key_at_hand(),
            Self::Decisions => required_env("OPENAI_API_KEY").is_ok(),
            Self::Clef => {
                required_env("CLOUDFLARE_AUTH_TOKEN").is_ok()
                    && required_env("CLOUDFLARE_ACCOUNT_ID").is_ok()
            }
        }
    }
    pub fn body(self, body: &Value) -> Result<Value> {
        for q in body["questions"].as_object().ok_or("Missing questions")?.values() {
            if !matches!(q["type"].as_str(), Some("noul" | "choice")) {
                return Err(format!("{} adapter supports only Noul and Choice questions", self.name()));
            }
        }
        if self != Self::Decisions {
            return Ok(body.clone());
        }
        let mut questions = Vec::new();
        for (name, q) in body["questions"].as_object().ok_or("Missing questions")? {
            let kind = q["type"].as_str().ok_or("Missing question type")?;
            let mut instructions = match &q["instructions"] {
                Value::String(s) => s.clone(),
                v => js::stringify(v),
            };
            let mut mapped = json!({"name": name, "type": kind, "instructions": instructions});
            match kind {
                "noul" => {
                    mapped["type"] = "predicate".into();
                    if let Some(criteria) = q.get("criteria") {
                        instructions.push_str(&format!(
                            "\nPredicate criteria (true/false): {}",
                            js::stringify(criteria)
                        ));
                        mapped["instructions"] = instructions.into();
                    }
                }
                "choice" => {
                    let criteria = q["criteria"]
                        .as_object()
                        .ok_or("Choice requires criteria")?;
                    mapped["choices"] = criteria.iter().map(|(value, description)| {
                        // SessionKit permits label-only choices (null criteria); Decisions
                        // requires a string description, so retain the label as its meaning.
                        let description = description.as_str().map(str::to_owned)
                            .unwrap_or_else(|| if description.is_null() { value.clone() } else { js::stringify(description) });
                        json!({"value": value, "description": description})
                    }).collect::<Vec<_>>().into();
                }
                _ => {
                    return Err(format!(
                        "OpenAI Decisions adapter does not support question type {kind}"
                    ));
                }
            }
            questions.push(mapped);
        }
        Ok(
            json!({"model": body["model"], "input": [{"role": "user", "content": [{"type": "input_text", "text": js::stringify(&body["state"])}]}], "questions": questions}),
        )
    }
    pub fn normalize(self, data: Value, request: &Value) -> Result<Value> {
        // Preserve both envelope usage and result.usage (observed in live Clef calls).
        let envelope_usage = data.get("usage").cloned();
        let data = if self == Self::Clef {
            if data.get("success") == Some(&Value::Bool(false)) {
                return Err("Cloudflare reported an unsuccessful request".into());
            }
            data.get("result")
                .cloned()
                .ok_or("Cloudflare response missing result")?
        } else {
            data
        };
        let raw = data
            .get("answers")
            .ok_or("Provider response missing answers")?;
        let expected = request["questions"]
            .as_object()
            .ok_or("Missing questions")?;
        let count = raw
            .as_object()
            .map(Map::len)
            .or_else(|| raw.as_array().map(Vec::len));
        if count != Some(expected.len()) {
            return Err("Provider returned an unexpected answer count".into());
        }
        if let Some(list) = raw.as_array() {
            let names: std::collections::HashSet<_> =
                list.iter().filter_map(|a| a["name"].as_str()).collect();
            if names.len() != expected.len() {
                return Err("Missing or duplicate answer names".into());
            }
        }
        let mut answers = Map::new();
        for (name, q) in request["questions"]
            .as_object()
            .ok_or("Missing questions")?
        {
            let a = raw.get(name).or_else(|| {
                raw.as_array()?
                    .iter()
                    .find(|a| a["name"].as_str() == Some(name))
            });
            let a = a.ok_or_else(|| format!("Provider response missing answer {name}"))?;
            let normalized = match q["type"].as_str() {
                Some("noul") => {
                    let p = ["noul", "probability", "value"]
                        .iter()
                        .find_map(|k| a.get(k)?.as_f64())
                        .filter(|p| p.is_finite() && (0.0..=1.0).contains(p))
                        .ok_or_else(|| format!("Invalid probability for {name}"))?;
                    json!({"type": "noul", "noul": p})
                }
                Some("choice") => {
                    let mut probabilities = Map::new();
                    match &a["probabilities"] {
                        Value::Object(map) => probabilities = map.clone(),
                        Value::Array(list) => {
                            for item in list {
                                let value = item["value"].as_str().ok_or("Invalid choice value")?;
                                if probabilities
                                    .insert(value.into(), item["probability"].clone())
                                    .is_some()
                                {
                                    return Err("Duplicate choice probability".into());
                                }
                            }
                        }
                        _ => return Err(format!("Missing choice probabilities for {name}")),
                    }
                    let criteria = q["criteria"].as_object().ok_or("Missing choice criteria")?;
                    if probabilities.len() != criteria.len()
                        || !criteria.keys().all(|k| {
                            probabilities
                                .get(k)
                                .and_then(Value::as_f64)
                                .is_some_and(|p| p.is_finite() && (0.0..=1.0).contains(&p))
                        })
                    {
                        return Err(format!(
                            "Incomplete or invalid choice probabilities for {name}"
                        ));
                    }
                    let best = probabilities
                        .iter()
                        .max_by(|a, b| a.1.as_f64().unwrap().total_cmp(&b.1.as_f64().unwrap()))
                        .map(|(k, _)| k.clone());
                    let choice = a
                        .get("choice")
                        .and_then(Value::as_str)
                        .filter(|v| criteria.contains_key(*v))
                        .map(str::to_owned)
                        .or(best);
                    let mut normalized = a.clone();
                    normalized["type"] = "choice".into();
                    normalized["choice"] = json!(choice);
                    normalized["probabilities"] = probabilities.into();
                    normalized
                }
                _ => return Err("Unsupported decision question type".into()),
            };
            answers.insert(name.clone(), normalized);
        }
        Ok(
            json!({"model": data["model"], "answers": answers, "usage": data.get("usage").cloned().or(envelope_usage).unwrap_or(json!({}))}),
        )
    }
}
/// Local machine preference, never credentials or an arbitrary endpoint.
/// Environment selections override this file; other machines still default to Jev.
fn user_configuration() -> Result<Value> {
    let path = crate::usage::home().join(".config/sessionkit/decision.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let config: Value = serde_json::from_str(&text).map_err(|_| format!("Invalid decision provider config: {}", path.display()))?;
            if !config.is_object() || ["provider", "model"].iter().any(|k| config.get(k).is_some_and(|v| !v.as_str().is_some_and(|s| !s.trim().is_empty()))) {
                return Err(format!("Decision config provider/model must be nonempty strings: {}", path.display()));
            }
            Ok(config)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(_) => Err(format!("Cannot read decision provider config: {}", path.display())),
    }
}

fn required_env(name: &str) -> Result<String> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!("Set {name} for the selected decision provider; no fallback is used.")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Value {
        json!({"model":"test", "state":{"text":"evidence"}, "questions":{"q":{"type":"noul","instructions":"Is it true?","criteria":{"true":"yes","false":"no"}}}})
    }
    #[test]
    fn openrouter_uses_native_systemone_and_preserves_billing_usage() {
        let body = request();
        assert_eq!(Provider::OpenRouter.body(&body).unwrap(), body);
        let data = json!({"model":"typesafe/jev-1.13-20260917","answers":{"q":{"type":"noul","noul":0.97}},
            "usage":{"input_tokens":287,"output_tokens":20,"cost":0.000012054},"provider":"TypeSafe"});
        let response = Provider::OpenRouter.normalize(data, &body).unwrap();
        assert_eq!(response["answers"]["q"]["noul"], 0.97);
        assert_eq!(response["usage"]["cost"], 0.000012054);
        assert_eq!(Provider::OpenRouter.id(), "openrouter");
    }

    #[test]
    fn decisions_preserves_predicate_criteria_and_state() {
        let b = Provider::Decisions.body(&request()).unwrap();
        assert_eq!(b["questions"][0]["type"], "predicate");
        assert!(
            b["questions"][0]["instructions"]
                .as_str()
                .unwrap()
                .contains("yes")
        );
        assert!(
            b["input"][0]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("evidence")
        );
    }
    #[test]
    fn normalizes_provider_envelopes_and_rejects_missing_answers() {
        for (p, data) in [
            (Provider::Jev, json!({"answers":{"q":{"noul":0.8}}})),
            (
                Provider::Decisions,
                json!({"answers":[{"name":"q","probability":0.8}]}),
            ),
            (
                Provider::Clef,
                json!({"success":true,"result":{"answers":{"q":{"value":0.8}}}}),
            ),
        ] {
            assert_eq!(
                p.normalize(data, &request()).unwrap()["answers"]["q"]["noul"],
                0.8
            );
            assert!(p.normalize(json!({"answers":{}}), &request()).is_err());
        }
        assert!(
            Provider::Jev
                .normalize(json!({"answers":{"q":{"noul":1.1}}}), &request())
                .is_err()
        );
    }
    #[test]
    fn recorded_live_responses_preserve_answers_confidence_and_usage() {
        let fixture: Value = serde_json::from_str(include_str!("../eval/fixtures/decision-live-responses.json")).unwrap();
        for (provider, name, tokens) in [(Provider::Clef, "clef", 224), (Provider::Decisions, "decisions", 304)] {
            let result = provider.normalize(fixture[name].clone(), &fixture["request"]).unwrap();
            assert!(result["answers"]["retries"]["noul"].as_f64().unwrap() > 0.9);
            assert_eq!(result["answers"]["action"]["choice"], "retry");
            assert!(result["answers"]["action"]["confidence"].as_f64().unwrap() > 0.9);
            assert_eq!(result["usage"]["input_tokens"], tokens);
        }
    }

    #[test]
    fn decisions_label_only_choices_have_string_descriptions() {
        let r = json!({"model":"test","state":{},"questions":{"q":{"type":"choice",
            "instructions":"Pick one","criteria":{"retry":null,"delete":"Delete files"}}}});
        let body = Provider::Decisions.body(&r).unwrap();
        assert_eq!(body["questions"][0]["choices"][0]["description"], "retry");
        assert_eq!(body["questions"][0]["choices"][1]["description"], "Delete files");
    }

    #[test]
    fn clef_envelope_also_preserves_outer_usage() {
        let data = json!({"result":{"model":"clef", "answers":{"q":{"type":"noul","noul":0.9764}}},
            "usage":{"input_tokens":224,"output_tokens":0},"success":true,"errors":[],"messages":[]});
        let normalized = Provider::Clef.normalize(data, &request()).unwrap();
        assert_eq!(normalized["usage"]["input_tokens"], 224);
        assert_eq!(normalized["model"], "clef");
    }

    #[test]
    fn choice_array_is_normalized() {
        let r = json!({"questions":{"q":{"type":"choice","criteria":{"a":"A","b":"B"}}}});
        let d = json!({"answers":[{"name":"q","probabilities":[{"value":"a","probability":0.3},{"value":"b","probability":0.7}]}]});
        assert_eq!(
            Provider::Decisions.normalize(d, &r).unwrap()["answers"]["q"]["choice"],
            "b"
        );
    }
}
