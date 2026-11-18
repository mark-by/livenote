use serde_json::{Map, Value, json};

use super::schema::kind;

mod initialize;

pub(super) struct Request {
    pub(super) id: Value,
    pub(super) method: Method,
}

impl Request {
    pub(super) const fn initializes(&self) -> bool {
        matches!(self.method, Method::Initialize(_))
    }
}

pub(super) enum Method {
    Initialize(String),
    Ping,
    List,
    Call {
        name: String,
        arguments: Option<Map<String, Value>>,
    },
    InvalidParams(String),
    Unknown,
}

#[derive(Debug)]
pub(super) struct InvalidMessage;

fn valid_id(id: &Value) -> bool {
    id.is_string()
        || id.as_f64().is_some_and(|value| {
            const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
            value.abs() <= MAX_SAFE_INTEGER && value.fract() == 0.0
        })
}

fn valid_meta(params: &Map<String, Value>) -> bool {
    params.get("_meta").is_none_or(|meta| {
        meta.as_object().is_some_and(|meta| {
            meta.get("progressToken").is_none_or(valid_id)
                && meta
                    .get("io.modelcontextprotocol/related-task")
                    .is_none_or(|related| related.get("taskId").is_some_and(Value::is_string))
        })
    })
}

pub(super) fn parse(input: Value) -> Result<Option<Request>, InvalidMessage> {
    let Value::Object(mut fields) = input else {
        return Err(InvalidMessage);
    };
    if fields
        .swap_remove("jsonrpc")
        .as_ref()
        .and_then(Value::as_str)
        != Some("2.0")
    {
        return Err(InvalidMessage);
    }
    let id = fields.swap_remove("id");
    if id.as_ref().is_some_and(|id| !valid_id(id)) {
        return Err(InvalidMessage);
    }
    if let Some(method) = fields.swap_remove("method") {
        let Value::String(method) = method else {
            return Err(InvalidMessage);
        };
        let params = match fields.swap_remove("params") {
            Some(Value::Object(params)) if valid_meta(&params) => Some(params),
            None => None,
            Some(_) => return Err(InvalidMessage),
        };
        if !fields.is_empty() {
            return Err(InvalidMessage);
        }
        return Ok(id.map(|id| Request {
            id,
            method: parse_method(&method, params),
        }));
    }
    let valid = match (fields.swap_remove("result"), fields.swap_remove("error")) {
        (Some(Value::Object(result)), None) => id.is_some() && valid_meta(&result),
        (None, Some(Value::Object(error))) => {
            error
                .get("code")
                .is_some_and(|code| code.is_number() && valid_id(code))
                && error.get("message").is_some_and(Value::is_string)
        }
        _ => false,
    };
    if valid && fields.is_empty() {
        Ok(None)
    } else {
        Err(InvalidMessage)
    }
}

fn parse_method(method: &str, params: Option<Map<String, Value>>) -> Method {
    if !matches!(method, "initialize" | "ping" | "tools/list" | "tools/call") {
        return Method::Unknown;
    }
    if let Some(task) = params.as_ref().and_then(|params| params.get("task"))
        && task.is_object()
        && task.get("ttl").is_none_or(Value::is_number)
    {
        return Method::InvalidParams(format!(
            "Server does not support task creation (required for {method})"
        ));
    }
    let mut issues = Vec::new();
    let parsed = match method {
        "ping" => Method::Ping,
        "tools/list" => {
            if let Some(cursor) = params.as_ref().and_then(|params| params.get("cursor")) {
                expect_kind(&mut issues, (&["params", "cursor"], "string"), Some(cursor));
            }
            Method::List
        }
        "initialize" | "tools/call" => {
            let Some(mut params) = params else {
                expect_kind(&mut issues, (&["params"], "object"), None);
                return invalid_params(&issues);
            };
            if method == "initialize" {
                initialize::parse(&mut params, &mut issues)
            } else {
                if let Some(task) = params.get("task") {
                    expect_kind(&mut issues, (&["params", "task"], "object"), Some(task));
                    if let Some(ttl) = task.get("ttl") {
                        expect_kind(
                            &mut issues,
                            (&["params", "task", "ttl"], "number"),
                            Some(ttl),
                        );
                    }
                }
                let name = params.swap_remove("name");
                let arguments = params.swap_remove("arguments");
                expect_kind(&mut issues, (&["params", "name"], "string"), name.as_ref());
                if let Some(arguments) = &arguments {
                    expect_kind(
                        &mut issues,
                        (&["params", "arguments"], "record"),
                        Some(arguments),
                    );
                }
                match name {
                    Some(Value::String(name)) => Method::Call {
                        name,
                        arguments: match arguments {
                            Some(Value::Object(arguments)) => Some(arguments),
                            _ => None,
                        },
                    },
                    _ => return invalid_params(&issues),
                }
            }
        }
        _ => return Method::Unknown,
    };
    if issues.is_empty() {
        parsed
    } else {
        invalid_params(&issues)
    }
}

fn expect_kind(issues: &mut Vec<Value>, field: (&[&str], &str), value: Option<&Value>) {
    let (path, expected) = field;
    let actual = kind(value);
    if actual != expected && !(actual == "object" && expected == "record") {
        issues.push(json!({
            "expected": expected,
            "code": "invalid_type",
            "path": path,
            "message": format!("Invalid input: expected {expected}, received {actual}")
        }));
    }
}

fn invalid_params(issues: &[Value]) -> Method {
    let message = serde_json::to_string_pretty(issues).unwrap_or_else(|error| error.to_string());
    Method::InvalidParams(message)
}

pub(super) fn error(id: &Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

pub(super) fn success(id: Value, result: Value) -> Value {
    Value::Object(Map::from_iter([
        ("jsonrpc".into(), Value::String("2.0".into())),
        ("id".into(), id),
        ("result".into(), result),
    ]))
}
