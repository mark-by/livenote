use std::collections::HashMap;

use reqwest::{Client, Response, StatusCode, header::HeaderValue};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use url::Url;

use super::{ConnectionError, Result, transport};

pub(super) struct Session {
    http: Client,
    endpoint: Url,
    token: String,
    version: Option<String>,
    session: Option<HeaderValue>,
    id: u32,
    tools: HashMap<String, Schema>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Initialize {
    protocol_version: String,
    capabilities: Capabilities,
}

#[derive(Deserialize)]
struct Capabilities {
    tools: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    tools: Vec<Tool>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    name: String,
    input_schema: Schema,
    #[serde(default)]
    annotations: Annotations,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Annotations {
    read_only_hint: Option<bool>,
    destructive_hint: Option<bool>,
}

#[derive(Deserialize)]
struct Schema {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    properties: HashMap<String, Value>,
    #[serde(default)]
    required: Vec<String>,
}

impl Schema {
    fn accepts(&self, args: &Value) -> bool {
        self.kind.as_deref() == Some("object")
            && args.as_object().is_some_and(|args| {
                self.required.iter().all(|name| args.contains_key(name))
                    && args.iter().all(|(name, value)| {
                        self.properties
                            .get(name)
                            .is_some_and(|schema| kind_matches(schema, value))
                    })
            })
    }
}

fn kind_matches(schema: &Value, value: &Value) -> bool {
    if let Some(options) = schema.get("anyOf").and_then(Value::as_array) {
        return options.iter().any(|option| kind_matches(option, value));
    }
    if schema
        .get("enum")
        .and_then(Value::as_array)
        .is_some_and(|options| !options.contains(value))
    {
        return false;
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => value.is_string(),
        Some("integer" | "number") => value.is_u64(),
        Some("boolean") => value.is_boolean(),
        _ => false,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CallResult {
    #[serde(default)]
    pub(super) is_error: bool,
    structured_content: Option<Value>,
    #[serde(default)]
    pub(super) content: Vec<Content>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum Content {
    Text {
        text: String,
    },
    Resource {
        resource: Resource,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
pub(super) struct Resource {
    pub(super) uri: String,
    pub(super) text: Option<String>,
}

impl CallResult {
    pub(super) fn decode<T: DeserializeOwned>(&self) -> Result<T> {
        if let Some(value) = &self.structured_content {
            return serde_json::from_value(value.clone()).map_err(|_| ConnectionError::Unsupported);
        }
        let [Content::Text { text }] = self.content.as_slice() else {
            return Err(ConnectionError::Unsupported);
        };
        serde_json::from_str(text).map_err(|_| ConnectionError::Unsupported)
    }
}

impl Session {
    pub(super) async fn open(
        http: Client,
        endpoint: Url,
        token: String,
        required: &[&str],
        optional: &[&str],
    ) -> Result<Self> {
        let mut client = Self {
            http,
            endpoint,
            token,
            version: None,
            session: None,
            id: 0,
            tools: HashMap::new(),
        };
        let response = client.post(&json!({
            "jsonrpc":"2.0", "id":0, "method":"initialize", "params":{
                "protocolVersion":"2025-11-25","clientInfo":{"name":"LiveNote","version":env!("CARGO_PKG_VERSION")},
                "capabilities":{}
            }
        })).await?;
        client.session = response.headers().get("Mcp-Session-Id").cloned();
        let initialized: Initialize = rpc_response(response, 0).await?;
        if !matches!(
            initialized.protocol_version.as_str(),
            "2025-11-25" | "2025-06-18" | "2025-03-26"
        ) || initialized.capabilities.tools.is_none()
        {
            return Err(ConnectionError::Unsupported);
        }
        client.version = Some(initialized.protocol_version);
        let accepted = client
            .post(&json!({"jsonrpc":"2.0", "method":"notifications/initialized"}))
            .await?;
        if !matches!(
            accepted.status(),
            StatusCode::ACCEPTED | StatusCode::NO_CONTENT
        ) {
            return Err(ConnectionError::Unsupported);
        }
        client.list_tools(required, optional).await?;
        Ok(client)
    }

    async fn list_tools(&mut self, required: &[&str], optional: &[&str]) -> Result<()> {
        let mut cursor = None;
        for _ in 0..12 {
            let params = cursor
                .take()
                .map_or_else(|| json!({}), |value| json!({"cursor": value}));
            let page: Catalog = self.request("tools/list", params).await?;
            for tool in page.tools {
                if required.contains(&tool.name.as_str()) || optional.contains(&tool.name.as_str()) {
                    if tool.annotations.read_only_hint == Some(false)
                        || tool.annotations.destructive_hint == Some(true)
                        || self.tools.insert(tool.name, tool.input_schema).is_some()
                    {
                        return Err(ConnectionError::Unsupported);
                    }
                }
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                return required
                    .iter()
                    .all(|name| self.tools.contains_key(*name))
                    .then_some(())
                    .ok_or(ConnectionError::Unsupported);
            }
        }
        Err(ConnectionError::Unsupported)
    }

    pub(super) fn supports(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    pub(super) async fn call(&mut self, name: &'static str, args: Value) -> Result<CallResult> {
        let result = self.call_raw(name, args).await?;
        if result.is_error {
            return Err(ConnectionError::Upstream);
        }
        Ok(result)
    }

    pub(super) async fn call_raw(&mut self, name: &'static str, args: Value) -> Result<CallResult> {
        if !self
            .tools
            .get(name)
            .is_some_and(|schema| schema.accepts(&args))
        {
            return Err(ConnectionError::Unsupported);
        }
        self.request("tools/call", json!({"name":name,"arguments":args}))
            .await
    }

    async fn request<T: DeserializeOwned>(&mut self, method: &str, params: Value) -> Result<T> {
        self.id = self.id.checked_add(1).ok_or(ConnectionError::Unsupported)?;
        let response = self
            .post(&json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params}))
            .await?;
        rpc_response(response, self.id).await
    }

    async fn post(&self, body: &Value) -> Result<Response> {
        let mut request = self
            .http
            .post(self.endpoint.clone())
            .header("Accept", "application/json, text/event-stream")
            .bearer_auth(&self.token)
            .json(body);
        if let Some(version) = &self.version {
            request = request.header("MCP-Protocol-Version", version);
        }
        if let Some(session) = &self.session {
            request = request.header("Mcp-Session-Id", session);
        }
        let response = request
            .send()
            .await
            .map_err(|_| ConnectionError::Upstream)?;
        transport::check_status(response.status())?;
        Ok(response)
    }
}

#[derive(Deserialize)]
struct Envelope {
    jsonrpc: String,
    id: Option<Value>,
    result: Option<Value>,
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcError {
    code: i32,
}

fn decode_envelope<T: DeserializeOwned>(frame: &[u8], id: u32) -> Result<Option<T>> {
    let message: Envelope =
        serde_json::from_slice(frame).map_err(|_| ConnectionError::Unsupported)?;
    if message.jsonrpc != "2.0"
        || message.id.as_ref().and_then(Value::as_u64) != Some(u64::from(id))
    {
        return Ok(None);
    }
    match (message.result, message.error) {
        (Some(value), None) => serde_json::from_value(value)
            .map(Some)
            .map_err(|_| ConnectionError::Unsupported),
        (None, Some(error)) if matches!(error.code, -32601 | -32602) => {
            Err(ConnectionError::Unsupported)
        }
        (Some(_), Some(_)) | (None, None) => Err(ConnectionError::Unsupported),
        (None, Some(_)) => Err(ConnectionError::Upstream),
    }
}

async fn rpc_response<T: DeserializeOwned>(response: Response, id: u32) -> Result<T> {
    let encoding = response
        .headers()
        .get("Content-Type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    match encoding {
        Some("application/json") => decode_envelope(&transport::body(response).await?, id)?
            .ok_or(ConnectionError::Unsupported),
        Some("text/event-stream") => sse(response, id).await,
        _ => Err(ConnectionError::Unsupported),
    }
}

async fn sse<T: DeserializeOwned>(mut response: Response, id: u32) -> Result<T> {
    let mut pending = Vec::new();
    let mut data = Vec::new();
    let mut total = 0usize;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ConnectionError::Upstream)?
    {
        total = total.saturating_add(chunk.len());
        if total > transport::MAX_BODY {
            break;
        }
        pending.extend_from_slice(&chunk);
        let mut consumed = 0usize;
        for raw in pending.split_inclusive(|byte| *byte == b'\n') {
            let Some(line) = raw.strip_suffix(b"\n") else {
                break;
            };
            consumed += raw.len();
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if let Some(value) = line.strip_prefix(b"data:") {
                data.extend_from_slice(value.strip_prefix(b" ").unwrap_or(value));
                data.push(b'\n');
            } else if line.is_empty() && !data.is_empty() {
                if let Some(value) = decode_envelope(&data, id)? {
                    return Ok(value);
                }
                data.clear();
            }
        }
        drop(pending.drain(..consumed));
    }
    Err(ConnectionError::Unsupported)
}
