use livenote_vault_service::agent_documents as d;
use rig::completion::ToolDefinition;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::types::{Error, Result};

#[derive(Deserialize)]
#[serde(
    tag = "name",
    content = "arguments",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(super) enum Tool {
    Search(SearchArgs),
    NextSource(NextSource),
    ReadVault(ReadVault),
    ReadSource(ReadSource),
    Cite(CiteArgs),
    Check(d::DiagramInput),
    Stage(d::Edit),
    StageDiagram(d::StageDiagram),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub(super) struct NextSource {
    #[serde(default)]
    pub code_relevant: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CiteArgs {
    pub refs: Vec<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SearchArgs {
    pub text: Option<String>,
    pub remote_index: Option<usize>,
    pub limit: usize,
}

impl SearchArgs {
    pub fn parse(self, external: bool) -> Result<(d::Query, Option<usize>)> {
        let text = self.text.unwrap_or_default();
        if self.limit == 0
            || self.limit > 10
            || text.len() > 1024
            || text.chars().any(char::is_control)
            || (!external && text.trim().is_empty())
            || (external && !text.is_empty())
        {
            return Err(Error::invalid(
                "Для проекта укажите текст поиска; для внешнего источника — remoteIndex. Лимит: 1–10",
            ));
        }
        Ok((
            d::Query {
                text,
                limit: self.limit,
            },
            self.remote_index,
        ))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReadVault {
    pub path: String,
    pub lines: d::Lines,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReadSource {
    #[serde(rename = "ref")]
    pub reference: Uuid,
    pub lines: d::Lines,
}

pub(super) fn parse(name: &str, arguments: Value) -> Result<Tool> {
    serde_json::from_value(json!({"name": name, "arguments": arguments}))
        .map_err(|_| Error::invalid("Неизвестный инструмент или неверные аргументы"))
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn tool(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: description.into(),
        parameters,
    }
}

pub(super) fn definitions() -> Vec<ToolDefinition> {
    let string = json!({"type":"string"});
    let number = json!({"type":"integer","minimum":0});
    let id = json!({"type":"string","format":"uuid"});
    let diagram_format = json!({"type":"string","enum":["mermaid","bpmn","drawio"]});
    let lines = object(
        json!({"first":{"type":"integer","minimum":1},"last":{"type":"integer","minimum":1}}),
        &["first", "last"],
    );
    let patch = object(
        json!({"from":number,"to":number,"old":string,"text":string}),
        &["from", "to", "old", "text"],
    );
    vec![
        tool(
            "search",
            "Search the current source. Use a short literal text for vault or local code. For an external source omit text and use remoteIndex (defaults to 0).",
            object(
                json!({
                    "text":string,"limit":{"type":"integer","minimum":1,"maximum":10},"remoteIndex": number
                }),
                &["limit"],
            ),
        ),
        tool(
            "next_source",
            "Advance after trying the current source without enough evidence. When leaving the vault in docs-first mode, set codeRelevant=true if the question concerns source code.",
            object(json!({"codeRelevant":{"type":"boolean"}}), &[]),
        ),
        tool(
            "read_vault",
            "Read lines of a vault document, diagram, or attachment. Returns readId and the UTF-16 offset.",
            object(
                json!({
                    "path":string, "lines":lines
                }),
                &["path", "lines"],
            ),
        ),
        tool(
            "read_source",
            "Read lines of local code or an MCP result using a ref returned by search.",
            object(
                json!({
                    "ref":id, "lines":lines
                }),
                &["ref", "lines"],
            ),
        ),
        tool(
            "cite",
            "Attach sources that support the final answer. Use only refs or readIds returned by current-turn tools. Call once with the complete list; a later successful call replaces it. Do not print refs or a separate sources block in Markdown.",
            object(
                json!({"refs":{"type":"array","items":id,"minItems":1,"maxItems":12}}),
                &["refs"],
            ),
        ),
        tool(
            "check",
            "Validate a diagram source.",
            object(
                json!({
                    "format":diagram_format, "source":string
                }),
                &["format", "source"],
            ),
        ),
        tool(
            "stage",
            "Stage a change only when the current user explicitly asked to write to LiveNote. Create needs path and source; patch needs readId, edits, and layout. Staging does not write to disk.",
            json!({
                "type":"object",
                "properties":{
                    "kind":{"type":"string","enum":["create","patch"]},
                    "path":string,"source":string,"readId":id,
                    "edits":{"type":"array","items":patch,"minItems":1,"maxItems":128},
                    "layout":{"type":"string","enum":["preserve","auto"]}
                },
                "required":["kind"],"additionalProperties":false
            }),
        ),
        tool(
            "stage_diagram",
            "Add a new diagram to a Markdown page. For a new page, first use stage to create plain Markdown, then pass its .md path as pagePath. Pass raw Mermaid text or BPMN/draw.io XML as source, not Markdown fences or a hand-authored attachment. New BPMN uses automatic layout. For an existing diagram use read_vault and stage patch instead. Success stages the change; it does not publish it.",
            object(
                json!({"pagePath":string,"format":diagram_format,"source":string,"title":string}),
                &["pagePath", "format", "source"],
            ),
        ),
    ]
}
