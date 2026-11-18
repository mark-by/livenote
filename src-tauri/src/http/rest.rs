use std::collections::BTreeMap;

use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{MethodFilter, on},
};
use livenote_vault_service::{Output, Scope};
use serde_json::{Map, Value};

use super::{HttpState, api_error, bad_request, closing, security::reject};

#[derive(Clone, Copy)]
enum Envelope {
    Bare,
    Named(&'static str),
    Block,
    Png,
    Markdown,
    Zip,
}

#[derive(Clone, Copy)]
struct Endpoint {
    operation: &'static str,
    envelope: Envelope,
    body: bool,
}

pub(super) fn routes() -> Router<HttpState> {
    use Envelope::{Bare, Block, Markdown, Named, Png, Zip};
    use MethodFilter as Method;
    let routes = [
        ("/pages", Method::GET, "list_pages", Named("pages"), false),
        ("/pages", Method::POST, "add_page", Named("page"), true),
        ("/vault", Method::GET, "get_vault", Bare, false),
        (
            "/vault/folders",
            Method::POST,
            "create_folder",
            Named("snapshot"),
            true,
        ),
        (
            "/vault/folders",
            Method::DELETE,
            "delete_folder",
            Named("snapshot"),
            true,
        ),
        (
            "/vault/folders/move",
            Method::POST,
            "move_folder",
            Bare,
            true,
        ),
        ("/search", Method::GET, "search", Named("hits"), false),
        (
            "/pages/{page_id}",
            Method::GET,
            "get_page",
            Named("page"),
            false,
        ),
        (
            "/pages/{page_id}",
            Method::PATCH,
            "update_page",
            Named("page"),
            true,
        ),
        (
            "/pages/{page_id}",
            Method::DELETE,
            "delete_page",
            Bare,
            false,
        ),
        (
            "/pages/{page_id}/document",
            Method::GET,
            "get_document",
            Named("document"),
            false,
        ),
        (
            "/pages/{page_id}/document",
            Method::PUT,
            "write_document",
            Named("document"),
            true,
        ),
        (
            "/pages/{page_id}/metadata",
            Method::PATCH,
            "patch_metadata",
            Named("document"),
            true,
        ),
        (
            "/pages/{page_id}/move",
            Method::POST,
            "move_document",
            Bare,
            true,
        ),
        (
            "/pages/{page_id}/blocks",
            Method::POST,
            "write_block",
            Block,
            true,
        ),
        (
            "/pages/{page_id}/blocks/{block_id}",
            Method::PUT,
            "replace_block",
            Block,
            true,
        ),
        (
            "/pages/{page_id}/blocks/{block_id}",
            Method::DELETE,
            "delete_block",
            Named("page"),
            false,
        ),
        (
            "/pages/{page_id}/blocks/{block_id}/rendered",
            Method::POST,
            "set_rendered",
            Bare,
            true,
        ),
        (
            "/pages/{page_id}/blocks/{block_id}/png",
            Method::GET,
            "export_png",
            Png,
            false,
        ),
        (
            "/export/pages/{download}",
            Method::GET,
            "export_page",
            Markdown,
            false,
        ),
        ("/export/all.zip", Method::GET, "export_vault", Zip, false),
        ("/export/all.md", Method::GET, "export_vault", Zip, false),
        (
            "/import",
            Method::POST,
            "import_markdown",
            Named("page"),
            true,
        ),
    ];
    routes.into_iter().fold(
        Router::new(),
        |router, (path, method, operation, envelope, body)| {
            let endpoint = Endpoint {
                operation,
                envelope,
                body,
            };
            router.route(path, on(method, dispatch).layer(Extension(endpoint)))
        },
    )
}

async fn dispatch(
    State(state): State<HttpState>,
    Extension(endpoint): Extension<Endpoint>,
    params: Option<Path<BTreeMap<String, String>>>,
    uri: Uri,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    if state.shutdown.is_cancelled() {
        return closing();
    }
    let params = params.map(|Path(params)| params).unwrap_or_default();
    let Some(args) = arguments(endpoint, &params, &uri, &headers, &bytes) else {
        return bad_request("Некорректное тело или параметры запроса");
    };
    let scope = params
        .get("vault_id")
        .map_or(Scope::Default, |id| Scope::Vault(id));
    let operation = match endpoint.operation {
        "write_block" => match args.get("format").and_then(Value::as_str) {
            Some("markdown") => "write_markdown",
            Some("mermaid" | "bpmn" | "drawio") => "write_diagram",
            _ => return bad_request("Поле type должно задавать формат блока"),
        },
        operation => operation,
    };
    match state
        .service
        .call(operation, Value::Object(args), scope)
        .await
    {
        Ok(output) => reply(&state, endpoint.envelope, &params, output).await,
        Err(error) => api_error(error),
    }
}

fn arguments(
    endpoint: Endpoint,
    params: &BTreeMap<String, String>,
    uri: &Uri,
    headers: &HeaderMap,
    bytes: &Bytes,
) -> Option<Map<String, Value>> {
    let mut args = if bytes.is_empty() {
        if endpoint.body {
            return None;
        }
        Map::new()
    } else {
        let media_type = headers.get(header::CONTENT_TYPE)?.to_str().ok()?;
        if !media_type
            .split(';')
            .next()?
            .trim()
            .eq_ignore_ascii_case("application/json")
        {
            return None;
        }
        serde_json::from_slice::<Map<String, Value>>(bytes).ok()?
    };
    for (public, internal) in [
        ("expectedRevision", "expected_revision"),
        ("expectedVersion", "expected_version"),
        ("expectedTreeVersion", "expected_tree_version"),
        ("requestId", "request_id"),
        ("blockId", "block_id"),
        ("blockOrder", "block_order"),
        ("deleteBlockIds", "delete_block_ids"),
    ] {
        if let Some(value) = args.remove(public) {
            args.insert(internal.into(), value);
        }
    }
    if endpoint.operation == "write_block"
        && let Some(format) = args.remove("type")
    {
        args.insert("format".into(), format);
    }
    for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        let name = match (endpoint.operation, key.as_ref()) {
            ("search", name @ ("q" | "tag")) => name,
            ("export_png", "theme") => "theme",
            ("delete_page" | "delete_block", "expectedRevision") => "expected_revision",
            ("delete_page" | "delete_block", "expectedVersion") => "expected_version",
            _ => continue,
        };
        args.entry(name)
            .or_insert_with(|| Value::String(value.into_owned()));
    }
    if let Some(Value::String(revision)) = args.get_mut("expected_revision") {
        let revision: u64 = revision.trim().parse().ok()?;
        args.insert("expected_revision".into(), revision.into());
    }
    if let Some(id) = params.get("page_id") {
        let name = match endpoint.operation {
            "get_document" | "write_document" | "patch_metadata" => "path",
            "move_document" => "from",
            _ => "page_id",
        };
        if endpoint.operation == "move_document"
            && let Some(destination) = args.remove("path")
        {
            args.insert("to".into(), destination);
        }
        args.insert(name.into(), Value::String(id.clone()));
    }
    if let Some(id) = params.get("block_id") {
        args.insert("block_id".into(), Value::String(id.clone()));
    }
    if let Some(download) = params.get("download") {
        let id = download.strip_suffix(".md")?;
        args.insert("page_id".into(), Value::String(id.into()));
    }
    Some(args)
}

async fn reply(
    state: &HttpState,
    envelope: Envelope,
    params: &BTreeMap<String, String>,
    output: Output,
) -> Response {
    use serde_json::json;
    match output {
        Output::Empty => StatusCode::NO_CONTENT.into_response(),
        Output::Bytes(bytes) => match envelope {
            Envelope::Png => download(
                "image/png",
                params
                    .get("block_id")
                    .map(String::as_str)
                    .unwrap_or("diagram"),
                "png",
                bytes,
            ),
            Envelope::Markdown => {
                let id = params
                    .get("download")
                    .and_then(|name| name.strip_suffix(".md"))
                    .unwrap_or("page");
                let name = id.rsplit('/').next().unwrap_or(id);
                let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
                download("text/markdown; charset=utf-8", stem, "md", bytes)
            }
            Envelope::Zip => download("application/zip", "livenote", "zip", bytes),
            Envelope::Bare | Envelope::Named(_) | Envelope::Block => internal(),
        },
        Output::Json(value) => match envelope {
            Envelope::Bare => Json(value).into_response(),
            Envelope::Named(key) => Json(json!({ (key): value })).into_response(),
            Envelope::Block => {
                let Some(id) = params.get("page_id") else {
                    return internal();
                };
                let scope = params
                    .get("vault_id")
                    .map_or(Scope::Default, |id| Scope::Vault(id));
                match state
                    .service
                    .call("get_page", json!({ "page_id": id }), scope)
                    .await
                {
                    Ok(Output::Json(page)) => {
                        let mut body = json!({ "page": page });
                        if let Some(validation) = value.get("validation") {
                            body["validation"] = validation.clone();
                        }
                        Json(body).into_response()
                    }
                    Ok(Output::Bytes(_) | Output::Empty) => internal(),
                    Err(error) => api_error(error),
                }
            }
            Envelope::Png | Envelope::Markdown | Envelope::Zip => internal(),
        },
    }
}

fn download(content_type: &'static str, name: &str, extension: &str, bytes: Vec<u8>) -> Response {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect();
    let value = format!(
        "attachment; filename=\"{ascii}.{extension}\"; filename*=UTF-8''{}.{extension}",
        encoded.replace('+', "%20"),
    );
    let Ok(disposition) = HeaderValue::from_str(&value) else {
        return internal();
    };
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        bytes,
    )
        .into_response()
}

fn internal() -> Response {
    reject(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "Не удалось подготовить ответ LiveNote",
    )
}
