use axum::body::to_bytes;
use livenote_diagrams::DiagramEngine;
use livenote_vault_service::Service;
use serde_json::json;

use super::{ApiError, BlockResult, Output, Scope, StatusCode, Value, reply_block};

const PAGE: &str = "Note.md";
const FIRST: &str = "First edit";
const SECOND: &str = "Second edit";

async fn fixture() -> (tempfile::TempDir, Service, Value) {
    let root = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
    std::fs::write(root.path().join(PAGE), "Original").unwrap_or_else(|error| panic!("{error}"));
    let engine = DiagramEngine::new(root.path().join("no-browser"), root.path().join("no-web"));
    let service = Service::open(root.path(), engine, "default".into())
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let page = read_page(&service).await;
    (root, service, page)
}

async fn read_page(service: &Service) -> Value {
    let Output::Json(page) = service
        .call("get_page", json!({"page_id": PAGE}), Scope::Default)
        .await
        .unwrap_or_else(|error| panic!("{error}"))
    else {
        panic!("Ожидается страница в формате JSON");
    };
    page
}

async fn replace(service: &Service, page: &Value, source: &str) -> Result<BlockResult, ApiError> {
    let args = json!({
        "page_id": PAGE, "block_id": page["blocks"][0]["id"],
        "expected_revision": page["revision"], "source": source,
    });
    service
        .call_block("replace_block", args, Scope::Default)
        .await
}

async fn block_reply(output: Result<BlockResult, ApiError>, status: StatusCode) -> Value {
    let response = reply_block(output);
    assert_eq!(response.status(), status);
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    serde_json::from_slice(&bytes).unwrap_or_else(|error| panic!("{error}"))
}

#[tokio::test]
async fn block_reply_keeps_first_write_revision_after_second_edit() {
    // Arrange: получаем результат первой записи, но ещё не формируем ответ.
    let (_root, service, original) = fixture().await;
    let output = replace(&service, &original, FIRST).await;
    let first_page = read_page(&service).await;
    let second = replace(&service, &first_page, SECOND).await;
    let latest = block_reply(second, StatusCode::OK).await;
    assert_eq!(latest["page"]["blocks"][0]["source"], SECOND);
    assert_ne!(latest["page"]["revision"], first_page["revision"]);

    // Act: формируем ответ на первую запись после второй записи.
    let first = block_reply(output, StatusCode::OK).await;

    // Assert: первая версия содержит первую правку и не содержит второй.
    println!(
        "R5 write: first commit={}, second commit={}, first REST reply={}",
        first_page["revision"], latest["page"]["revision"], first["page"]["revision"]
    );
    assert_eq!(first, json!({"page": first_page}));
    assert_eq!(first_page["blocks"][0]["source"], FIRST);
}

#[tokio::test]
async fn block_reply_keeps_checked_page_after_validation_rejection_and_edit() {
    // Arrange: без Chromium сервис не сохраняет диаграмму.
    let (_root, service, original) = fixture().await;
    let args = json!({
        "page_id": PAGE, "format": "mermaid", "source": "flowchart LR\n A --> B",
        "expected_revision": original["revision"],
    });
    let rejected = service
        .call_block("write_diagram", args, Scope::Default)
        .await;
    let second = replace(&service, &original, SECOND).await;
    let latest = block_reply(second, StatusCode::OK).await;
    assert_eq!(latest["page"]["blocks"][0]["source"], SECOND);
    assert_ne!(latest["page"]["revision"], original["revision"]);

    // Act: формируем ответ с результатом проверки после последующей записи.
    let reply = block_reply(rejected, StatusCode::OK).await;

    // Assert: ответ содержит исходную страницу и результат проверки.
    println!(
        "R5 validation: checked={}, second commit={}, first REST reply={}, syntax={}",
        original["revision"],
        latest["page"]["revision"],
        reply["page"]["revision"],
        reply["validation"]["syntax"]
    );
    assert_eq!(
        reply,
        json!({
            "page": original, "validation": {"syntax":"not_checked", "renderer":"unavailable"}
        })
    );
}

#[tokio::test]
async fn stale_block_receipt_keeps_mcp_summary_without_a_mixed_rest_reply() {
    // Arrange: сохраняем квитанцию записи блока и меняем страницу ещё раз.
    let (_root, service, original) = fixture().await;
    let args = json!({
        "page_id": PAGE, "block_id": original["blocks"][0]["id"],
        "expected_revision": original["revision"], "source": FIRST,
        "request_id": "r5-replace",
    });
    let first = block_reply(
        service
            .call_block("replace_block", args.clone(), Scope::Default)
            .await,
        StatusCode::OK,
    )
    .await;
    let current = block_reply(
        replace(&service, &first["page"], SECOND).await,
        StatusCode::OK,
    )
    .await;

    // Act: повторяем запрос REST и запрашиваем ту же квитанцию из MCP.
    let replay = service
        .call_block("replace_block", args.clone(), Scope::Default)
        .await;
    let rest = block_reply(replay, StatusCode::CONFLICT).await;
    let Output::Json(mcp) = service
        .call("replace_block", args, Scope::Mcp)
        .await
        .unwrap_or_else(|error| panic!("{error}"))
    else {
        panic!("Ожидается квитанция MCP в формате JSON");
    };

    // Assert: REST сообщает о конфликте, а MCP возвращает исходную квитанцию без страницы.
    assert_eq!(rest["error"]["code"], "conflict");
    assert_eq!(
        rest["error"]["details"]["currentRevision"],
        current["page"]["revision"]
    );
    assert_eq!(
        mcp,
        json!({
            "pageId": PAGE, "blockId": first["page"]["blocks"][0]["id"],
            "revision": first["page"]["revision"],
        })
    );
}
