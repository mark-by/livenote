//! Проверки контракта POST без HTTP-сервера.

use std::future::ready;
use std::sync::atomic::{AtomicUsize, Ordering};

use livenote_mcp::{Config, Response, StorageMode, Tool, ToolCall, ToolError, handle};
use serde_json::{Value, json};

fn field<'a>(body: &'a Value, path: &str) -> &'a Value {
    body.pointer(path).expect("Поле ответа")
}

const VAULTS: Config<'_> = Config {
    server_version: "1.2.3",
    storage: StorageMode::Vaults,
    protocol_version: None,
};

fn envelope(method: &str, params: &Value) -> Value {
    json!({"jsonrpc": "2.0", "id": "client-1", "method": method, "params": params})
}

fn unexpected(_: ToolCall) -> std::future::Ready<Result<Value, ToolError>> {
    ready(Err(ToolError::Other("Неожиданный вызов сервиса".into())))
}

fn json_body(response: Response, expected_status: u16) -> Value {
    let Response::Json { status, body } = response else {
        panic!("Ожидался ответ JSON");
    };
    assert_eq!(status, expected_status);
    body
}

#[tokio::test]
async fn negotiates_version_without_using_the_initialize_header() {
    let config = Config {
        protocol_version: Some("ignored"),
        ..VAULTS
    };
    for (requested, expected) in [("2024-11-05", "2024-11-05"), ("future", "2025-11-25")] {
        let request = envelope(
            "initialize",
            &json!({
                "protocolVersion": requested, "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}
            }),
        );
        let body = json_body(handle(request, config, unexpected).await, 200);
        assert_eq!(
            body,
            json!({"jsonrpc":"2.0","id":"client-1","result":{
                "protocolVersion":expected,"capabilities":{"tools":{"listChanged":true}},
                "serverInfo":{"name":"livenote","version":"1.2.3"}
            }})
        );
    }
}

#[tokio::test]
async fn notification_does_not_dispatch_a_tool_or_reply() {
    let calls = AtomicUsize::new(0);
    let notification = json!({"jsonrpc":"2.0","method":"tools/call","params":{
        "name":"delete_page","arguments":{"page_id":"Note.md","expected_revision":3}
    }});
    let response = handle(notification, VAULTS, |call| {
        calls.fetch_add(1, Ordering::Relaxed);
        unexpected(call)
    })
    .await;
    assert_eq!(response, Response::Accepted);
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn batch_correlates_errors_and_ignores_notifications() {
    let batch = json!([
        {"jsonrpc":"2.0","id":0,"method":"ping"},
        {"jsonrpc":"2.0","method":"notifications/initialized"},
        {"jsonrpc":"2.0","id":"other","method":"unknown"}
    ]);
    let body = json_body(handle(batch, VAULTS, unexpected).await, 200);
    assert_eq!(
        body,
        json!([
            {"jsonrpc":"2.0","id":0,"result":{}},
            {"jsonrpc":"2.0","id":"other","error":{"code":-32601,"message":"Method not found"}}
        ])
    );
}

#[tokio::test]
async fn rejects_unsupported_post_version() {
    let config = Config {
        protocol_version: Some("future"),
        ..VAULTS
    };
    let body = json_body(
        handle(envelope("ping", &json!({})), config, unexpected).await,
        400,
    );
    assert_eq!(field(&body, "/error/code"), -32000);
    assert!(field(&body, "/id").is_null());
}

#[tokio::test]
async fn rejects_malformed_member_before_processing_batch() {
    let batch = json!([
        {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_pages"}},
        {"jsonrpc":"2.0","id":null,"method":"ping"}
    ]);
    let calls = AtomicUsize::new(0);
    let response = handle(batch, VAULTS, |call| {
        calls.fetch_add(1, Ordering::Relaxed);
        unexpected(call)
    })
    .await;
    assert_eq!(
        json_body(response, 400),
        json!({"jsonrpc":"2.0","id":null,"error":{
            "code":-32700,"message":"Parse error: Invalid JSON-RPC message"
        }})
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn publishes_vault_selection_only_for_vault_storage_tools() {
    for storage in [StorageMode::Sqlite, StorageMode::Vaults] {
        let config = Config { storage, ..VAULTS };
        let body = json_body(
            handle(envelope("tools/list", &json!({})), config, unexpected).await,
            200,
        );
        let tools = field(&body, "/result/tools")
            .as_array()
            .expect("Список инструментов");
        let visible = tools
            .iter()
            .find(|tool| field(tool, "/name") == "list_vaults");
        let read = tools
            .iter()
            .find(|tool| field(tool, "/name") == "list_pages")
            .expect("list_pages");
        let schema = &read["inputSchema"];
        match storage {
            StorageMode::Sqlite => {
                assert!(visible.is_none());
                assert_eq!(schema, &json!({"type":"object","properties":{}}));
            }
            StorageMode::Vaults => {
                let tool = visible.expect("list_vaults");
                assert_eq!(field(tool, "/inputSchema/properties"), &json!({}));
                assert_eq!(field(tool, "/outputSchema/required"), &json!(["vaults"]));
                assert_eq!(field(schema, "/properties/vault_id/type"), "string");
                assert!(schema.get("required").is_none());
            }
        }
    }
}

#[tokio::test]
async fn normalizes_diagram_arguments_before_service_dispatch() {
    let inputs = [
        (json!({"layout":"auto"}), json!({"format":"mermaid"})),
        (
            json!({"format":"bpmn","layout":"auto"}),
            json!({"format":"bpmn","layout":"auto"}),
        ),
        (
            json!({"format":"drawio","layout":"auto"}),
            json!({"format":"drawio"}),
        ),
    ];
    for (input, expected) in inputs {
        let mut args = json!({"vault_id":"team","page_id":"Note.md","source":"diagram","expected_revision":2.0,
            "request_id":"retry-key","ignored":true});
        args.as_object_mut()
            .expect("Аргументы")
            .extend(input.as_object().expect("Поля формата").clone());
        let request = envelope(
            "tools/call",
            &json!({"name":"write_diagram","arguments":args}),
        );
        let result = handle(request, VAULTS, |operation| {
            assert_eq!(operation.tool, Tool::WriteDiagram);
            assert_eq!(operation.vault_id.as_ref().map(livenote_mcp::VaultId::as_str), Some("team"));
            let mut args = json!({"page_id":"Note.md","source":"diagram","expected_revision":2,"request_id":"retry-key"});
            args.as_object_mut().expect("Аргументы").extend(expected.as_object().expect("Поля формата").clone());
            assert_eq!(Value::Object(operation.arguments), args);
            ready(Ok(json!({"revision":3})))
        }).await;
        assert_eq!(
            field(&json_body(result, 200), "/result/content/0/text"),
            r#"{"revision":3}"#
        );
    }
}

#[tokio::test]
async fn missing_nullable_asset_version_does_not_dispatch() {
    let args = json!({"path":"Note.md","source":"new source","expected_revision":3,"expected_version":"v3",
        "assets":[{"path":"diagram.drawio","source":"<mxfile/>"}]});
    let request = envelope(
        "tools/call",
        &json!({"name":"write_document","arguments":args}),
    );
    let body = json_body(handle(request, VAULTS, unexpected).await, 200);
    assert_eq!(
        field(&body, "/result"),
        &json!({"isError":true,"content":[{"type":"text","text":
            "MCP error -32602: Input validation error: Invalid arguments for tool write_document: Required at assets[0].expected_version"
        }]})
    );
}

#[tokio::test]
async fn check_diagram_keeps_validation_metadata_and_omits_render() {
    let request = envelope(
        "tools/call",
        &json!({"name":"check_diagram","arguments":{
            "page_id":"Note.md","block_id":"diagram"
        }}),
    );
    let result = handle(request, VAULTS, |operation| {
        assert_eq!(operation.arguments.get("mode"), Some(&json!("syntax")));
        ready(Ok(
            json!({"validation":{"syntax":"ok"},"stale":false,"render":{"base64":"image"}}),
        ))
    })
    .await;
    assert_eq!(
        field(&json_body(result, 200), "/result"),
        &json!({"content":[{"type":"text",
            "text":r#"{"validation":{"syntax":"ok"},"stale":false}"#
        }]})
    );
}

#[tokio::test]
async fn list_vaults_returns_same_projection_as_text_and_structured_content() {
    let request = envelope("tools/call", &json!({"name":"list_vaults"}));
    let result = handle(request, VAULTS, |_| {
        ready(Ok(json!({"vaults":[
            {"id":"team","name":"Team","private":true}
        ]})))
    })
    .await;
    assert_eq!(
        field(&json_body(result, 200), "/result"),
        &json!({
            "content":[{"type":"text","text":r#"{"vaults":[{"id":"team","name":"Team"}]}"#}],
            "structuredContent":{"vaults":[{"id":"team","name":"Team"}]}
        })
    );
}

#[tokio::test]
async fn passes_omitted_read_arguments_to_service_and_keeps_application_details() {
    let request = envelope("tools/call", &json!({"name":"list_pages"}));
    let result = handle(request, VAULTS, |operation| {
        assert_eq!(operation.tool, Tool::ListPages);
        assert_eq!(operation.vault_id, None);
        assert!(operation.arguments.is_empty());
        ready(Err(ToolError::Application {
            code: "vault_required".into(),
            message: "Выберите хранилище".into(),
            details: Some(json!({"open":2})),
        }))
    })
    .await;
    assert_eq!(
        field(&json_body(result, 200), "/result"),
        &json!({"isError":true,"content":[{"type":"text",
            "text":r#"Ошибка [vault_required]: Выберите хранилище Данные: {"open":2}"#
        }]})
    );
}
