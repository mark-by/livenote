use std::{
    fs,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use livenote_diagrams::DiagramEngine;
use livenote_vault_service::Service;
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{HttpState, router, security};
use crate::{agent::AgentRuntime, agent_connections as c};

#[path = "history_tests.rs"]
mod history_tests;
#[path = "progress_tests.rs"]
mod progress_tests;
#[path = "reply_tests.rs"]
mod reply_tests;
#[path = "retry_tests.rs"]
mod retry_tests;
#[path = "security_tests.rs"]
mod security_tests;

const DEADLINE: Duration = Duration::from_secs(10);
const API_TOKEN: &str = "fixture-desktop-token";
const PROVIDER_TOKEN: &str = "fixture-provider-token";
const NEEDLE: &str = "agent-needle";

struct Listener {
    origin: String,
    task: JoinHandle<()>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn listen(routes: Router) -> Listener {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Свободный локальный порт");
    let origin = format!("http://{}", listener.local_addr().expect("Адрес фикстуры"));
    let task = tokio::spawn(async move {
        axum::serve(listener, routes)
            .await
            .expect("Локальный HTTP-сервер");
    });
    Listener { origin, task }
}

type Script = dyn Fn(usize, &Value) -> Value + Send + Sync;

#[derive(Clone)]
struct ModelFixture {
    script: Arc<Script>,
    calls: Arc<AtomicUsize>,
}

async fn model(
    fixture: impl Fn(usize, &Value) -> Value + Send + Sync + 'static,
) -> (Listener, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let state = ModelFixture {
        script: Arc::new(fixture),
        calls: calls.clone(),
    };
    let router = Router::new()
        .route("/v1/chat/completions", post(openai))
        .with_state(state);
    (listen(router).await, calls)
}

async fn openai(
    State(state): State<ModelFixture>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Json<Value> {
    assert_eq!(
        headers[header::AUTHORIZATION],
        format!("Bearer {PROVIDER_TOKEN}")
    );
    assert_eq!(input["stream"], false);
    assert_eq!(input["model"], "fixture");
    assert!(!input.to_string().contains(PROVIDER_TOKEN));
    let index = state.calls.fetch_add(1, Ordering::SeqCst);
    Json(completion_fixture((state.script)(index, &input)))
}

fn completion_fixture(mut message: Value) -> Value {
    let finish = message
        .as_object_mut()
        .expect("Сообщение модели")
        .remove("fixture_finish_reason")
        .unwrap_or_else(|| {
            json!(if message["tool_calls"].is_array() {
                "tool_calls"
            } else {
                "stop"
            })
        });
    message["role"] = json!("assistant");
    json!({"id":"fixture-reply","object":"chat.completion","created":0,"model":"fixture",
        "choices":[{"index":0,"finish_reason":finish,"message":message}]})
}

fn policy_input(input: &Value, original: &str) {
    assert!(input.get("tools").is_none(), "{input}");
    let messages = input["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert_eq!(messages[0]["role"], "system");
    assert_eq!(messages[1], json!({"role":"user","content":original}));
}

fn write_policy(input: &Value, original: &str, decision: &str) -> Value {
    policy_input(input, original);
    content(json!({"write":decision}))
}

fn remote_policy(input: &Value, original: &str, queries: &[&str]) -> Value {
    policy_input(input, original);
    content(json!({"remoteQueries":queries}))
}

fn cite(index: usize, reference: &Value) -> Value {
    call(index, "cite", json!({"refs":[reference]}))
}

fn call(index: usize, name: &str, args: Value) -> Value {
    json!({"content":null,"tool_calls":[{
        "type":"function","id": format!("call-{index}"),
        "function":{"name":name,"arguments":args.to_string()}
    }]})
}

fn content(value: Value) -> Value {
    json!({"content": value.to_string()})
}

fn result(input: &Value) -> Value {
    let messages = input["messages"].as_array().expect("История запроса");
    let [.., assistant, item] = messages.as_slice() else {
        panic!("Нет вызова инструмента и результата");
    };
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(
        assistant["tool_calls"]
            .as_array()
            .expect("Вызовы инструментов")
            .len(),
        1
    );
    assert_eq!(item["role"], "tool");
    assert_eq!(item["tool_call_id"], assistant["tool_calls"][0]["id"]);
    serde_json::from_str(item["content"].as_str().expect("JSON результата"))
        .expect("Результат инструмента")
}

fn final_with(reference: &Value) -> Value {
    content(json!({"answer":"Источник найден.","cites":[reference]}))
}

struct Desktop {
    data: TempDir,
    vault: TempDir,
    service: Arc<Service>,
    runtime: AgentRuntime,
    shutdown: CancellationToken,
    server: Listener,
    client: reqwest::Client,
}

impl Desktop {
    async fn new() -> Self {
        Self::open(None).await
    }

    async fn open(engine: Option<DiagramEngine>) -> Self {
        let data = tempdir().expect("Локальные настройки");
        let vault = tempdir().expect("Папка vault");
        let service = match engine {
            Some(engine) => Arc::new(
                Service::open(vault.path(), engine, "default".into())
                    .await
                    .unwrap(),
            ),
            None => service(vault.path()).await,
        };
        let shutdown = CancellationToken::new();
        let runtime = runtime(data.path(), shutdown.clone());
        let server = desktop(service.clone(), runtime.clone()).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(DEADLINE)
            .build()
            .expect("HTTP-клиент");
        Self {
            data,
            vault,
            service,
            runtime,
            shutdown,
            server,
            client,
        }
    }

    fn base(&self) -> String {
        format!("/api/vaults/{}/agent", self.service.startup_id())
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.server.origin))
            .header("x-livenote-agent", "1")
            .bearer_auth(API_TOKEN)
    }

    async fn json(
        &self,
        method: Method,
        tail: &str,
        body: Option<Value>,
        status: StatusCode,
    ) -> Value {
        let path = format!("{}{tail}", self.base());
        let request = self.request(method, &path);
        let request = match body {
            Some(value) => request.json(&value),
            None => request,
        };
        json_response(request, status).await
    }

    async fn session(&self) -> Uuid {
        let id = Uuid::new_v4();
        self.json(
            Method::POST,
            "/sessions",
            Some(json!({"id":id})),
            StatusCode::OK,
        )
        .await;
        id
    }

    async fn connect(&self, model: &Listener) {
        let configured = self.json(Method::PUT, "/connections/model", Some(json!({
            "profile":{"kind":"model","baseUrl":format!("{}/v1",model.origin),"model":"fixture"},
            "secret":{"kind":"token","value":PROVIDER_TOKEN}
        })), StatusCode::OK).await;
        assert_eq!(configured["state"], "ready");
        assert!(!configured.to_string().contains(PROVIDER_TOKEN));
    }

    async fn submit(&self, session: Uuid, turn: Value, status: StatusCode) -> Value {
        self.json(
            Method::POST,
            &format!("/sessions/{session}/turns"),
            Some(turn),
            status,
        )
        .await
    }

    async fn turn(&self, session: Uuid, turn: Uuid) -> Value {
        self.json(
            Method::GET,
            &format!("/sessions/{session}/turns/{turn}"),
            None,
            StatusCode::OK,
        )
        .await
    }

    async fn drain(&self) {
        timeout(DEADLINE, self.runtime.drain())
            .await
            .expect("Исполнитель закончил сообщение");
    }
}

async fn service(path: &Path) -> Arc<Service> {
    let engine = DiagramEngine::new(path.join("no-browser"), path.join("no-worker"));
    Arc::new(
        Service::open(path, engine, "default".into())
            .await
            .expect("Сервис vault"),
    )
}

fn runtime(data: &Path, shutdown: CancellationToken) -> AgentRuntime {
    let connections =
        c::Connections::fixture(data.into(), 4317).expect("Тестовое хранилище секретов");
    AgentRuntime::new(data.into(), connections, shutdown)
}

async fn desktop(service: Arc<Service>, runtime: AgentRuntime) -> Listener {
    let socket = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Порт LiveNote");
    let address = socket.local_addr().expect("Сокет LiveNote");
    let state = HttpState {
        service,
        shutdown: CancellationToken::new(),
        app: None,
        access: security::Access::new(address.port(), Some(API_TOKEN.into())),
        theme: "default".into(),
        picker: tokio::sync::Semaphore::new(1).into(),
        agent: runtime,
    };
    let routes = router(state, Path::new("no-test-web"));
    let task =
        tokio::spawn(async move { axum::serve(socket, routes).await.expect("LiveNote HTTP") });
    Listener {
        origin: format!("http://{address}"),
        task,
    }
}

async fn json_response(request: reqwest::RequestBuilder, status: StatusCode) -> Value {
    let response = request.send().await.expect("HTTP-ответ");
    let actual = response.status();
    let value: Value = response.json().await.expect("Ответ JSON");
    assert_eq!(actual, status, "{value}");
    value
}

fn submit(id: Uuid, focus: Value, code_first: bool, text: &str) -> Value {
    let search = if code_first { "codeFirst" } else { "docsFirst" };
    json!({"id":id,"text":text,"search":search,"focus":focus})
}

fn root() -> Value {
    json!({"kind":"folder","folder":""})
}

#[tokio::test]
async fn agent_docs_first_stops_with_verified_cite() {
    // Arrange: ответ есть в vault, а MCP доступен.
    let app = Desktop::new().await;
    fs::write(
        app.vault.path().join("manual.md"),
        format!("# Инструкция\n\n{NEEDLE}\n"),
    )
    .expect("Документ проекта");
    let (mcp, mcp_calls) = confluence().await;
    connect_confluence(&app, &mcp).await;
    let (model, _) = model(|index, input| match index {
        0 => call(index, "search", json!({"text":NEEDLE,"limit":5})),
        1 => {
            let value = result(input);
            assert_eq!(value["source"], "vault");
            cite(index, &value["hits"][0]["ref"])
        }
        2 => {
            assert_eq!(result(input), json!({"cited":true}));
            json!({"content":"Источник найден."})
        }
        _ => panic!("Неожиданный запрос модели"),
    })
    .await;
    app.connect(&model).await;
    let session = app.session().await;
    let id = Uuid::new_v4();

    // Act: пользователь отправляет вопрос и забирает окончательный ответ.
    app.submit(
        session,
        submit(id, root(), false, NEEDLE),
        StatusCode::ACCEPTED,
    )
    .await;
    app.drain().await;
    let turn = app.turn(session, id).await;

    // Assert: сервер вернул точную ссылку vault и не открыл MCP.
    assert_eq!(
        turn["cites"],
        json!([{"kind":"vault","path":"manual.md","line":3}]),
        "{turn}"
    );
    assert_eq!(mcp_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn agent_uses_confluence_after_document_search_misses() {
    // Arrange: локальные документы пусты. MCP отдаёт страницу только по ID из поиска.
    let app = Desktop::new().await;
    let (mcp, calls) = confluence().await;
    connect_confluence(&app, &mcp).await;
    let (model, _) = model(|index, input| match index {
        0 => call(index, "search", json!({"text":NEEDLE,"limit":5})),
        1 => {
            assert_eq!(result(input)["hits"], json!([]));
            call(index, "next_source", json!({}))
        }
        2 => call(index, "search", json!({"remoteIndex":0,"limit":5})),
        3 => remote_policy(input, NEEDLE, &[NEEDLE]),
        4 => call(
            index,
            "read_source",
            json!({"ref":result(input)["hits"][0]["ref"],"lines":{"first":2,"last":2}}),
        ),
        5 => {
            let value = result(input);
            assert_eq!(value["text"], NEEDLE);
            final_with(&value["ref"])
        }
        _ => panic!("Неожиданный запрос модели"),
    })
    .await;
    app.connect(&model).await;
    let session = app.session().await;
    let id = Uuid::new_v4();

    // Act: агент ищет ответ через обычный HTTP-контракт.
    app.submit(
        session,
        submit(id, root(), false, NEEDLE),
        StatusCode::ACCEPTED,
    )
    .await;
    app.drain().await;

    // Assert: агент выполнил только поиск и чтение страницы на настроенном MCP.
    let turn = app.turn(session, id).await;
    let expected =
        json!([{"kind":"confluence","url":format!("{}/wiki/10",mcp.origin),"title":"Страница"}]);
    assert_eq!(turn["cites"], expected, "{turn}");
    assert_eq!(calls.load(Ordering::SeqCst), 5);
}

async fn connect_confluence(app: &Desktop, mcp: &Listener) {
    let host = mcp.origin.trim_start_matches("http://");
    app.json(Method::PUT, "/connections/confluence", Some(json!({
        "profile":{"kind":"confluence","endpoint":format!("{}/mcp",mcp.origin),"resourceHost":host},
        "secret":{"kind":"token","value":PROVIDER_TOKEN}
    })), StatusCode::OK).await;
}

async fn confluence() -> (Listener, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let routes = Router::new()
        .route("/mcp", post(mcp))
        .with_state(calls.clone());
    (listen(routes).await, calls)
}

async fn mcp(
    State(calls): State<Arc<AtomicUsize>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    calls.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        headers[header::AUTHORIZATION],
        format!("Bearer {PROVIDER_TOKEN}")
    );
    let result = match input["method"].as_str() {
        Some("initialize") => {
            json!({"protocolVersion":input["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
        }
        Some("notifications/initialized") => return StatusCode::ACCEPTED.into_response(),
        Some("tools/list") => json!({"tools":[
            {"name":"confluence_search","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}}}},
            {"name":"confluence_get_page","inputSchema":{"type":"object","properties":{
                "page_id":{"type":"string"},"include_metadata":{"type":"boolean"},"convert_to_markdown":{"type":"boolean"}
            }}},
            {"name":"confluence_update_page","inputSchema":{"type":"object"}}
        ]}),
        Some("tools/call") => {
            let args = &input["params"]["arguments"];
            let value = match input["params"]["name"].as_str() {
                Some("confluence_search") => {
                    assert_eq!(
                        args["query"],
                        format!("type = page AND text ~ \"{NEEDLE}\"")
                    );
                    json!([{"id":"10","title":"Страница","url":"/wiki/10","excerpt":NEEDLE}])
                }
                Some("confluence_get_page") => {
                    assert_eq!(args["page_id"], "10");
                    json!({"content":{"value":format!("Введение\n{NEEDLE}")}})
                }
                _ => panic!("MCP получил неразрешённый инструмент"),
            };
            json!({"content":[{"type":"text","text":value.to_string()}]})
        }
        _ => panic!("Неожиданный запрос MCP"),
    };
    Json(json!({"jsonrpc":"2.0","id":input["id"],"result":result})).into_response()
}

#[tokio::test]
async fn agent_code_first_prefers_bound_local_checkout() {
    // Arrange: совпадение есть в документах и в двух привязанных источниках кода.
    let app = Desktop::new().await;
    let code = tempdir().expect("Локальная копия");
    fs::write(code.path().join("config.rs"), format!("// {NEEDLE}\n")).expect("Исходный файл");
    fs::write(app.vault.path().join("manual.md"), NEEDLE).expect("Документ проекта");
    let (mcp, calls) = confluence().await;
    app.json(Method::PUT, "/connections/github", Some(json!({
        "profile":{"kind":"github","endpoint":format!("{}/mcp",mcp.origin),"resourceHost":mcp.origin.trim_start_matches("http://")},
        "secret":{"kind":"token","value":PROVIDER_TOKEN}
    })), StatusCode::OK).await;
    let binding = app.json(Method::PUT, "/binding", Some(json!({
        "folder":"","version":null,"value":{"repo":{"provider":"github","url":format!("{}/team/repo",mcp.origin)},
        "localDir":code.path()}
    })), StatusCode::OK).await;
    assert_eq!(
        app.json(Method::GET, "/binding?folder=", None, StatusCode::OK)
            .await,
        binding
    );
    let local_path = code.path().display().to_string();
    let (model, _) = model(move |index, input| {
        assert!(!input.to_string().contains(&local_path));
        match index {
            0 => call(index, "search", json!({"text":NEEDLE,"limit":5})),
            1 => {
                let value = result(input);
                assert_eq!(value["source"], "localCode");
                final_with(&value["hits"][0]["ref"])
            }
            _ => panic!("Неожиданный запрос модели"),
        }
    })
    .await;
    app.connect(&model).await;
    let session = app.session().await;
    let id = Uuid::new_v4();

    // Act: пользователь просит сначала проверить код.
    app.submit(
        session,
        submit(id, root(), true, NEEDLE),
        StatusCode::ACCEPTED,
    )
    .await;
    app.drain().await;

    // Assert: ответ указывает относительный путь. MCP-запроса не было.
    let turn = app.turn(session, id).await;
    assert_eq!(
        turn["cites"],
        json!([{"kind":"localCode","path":"config.rs","line":1}]),
        "{turn}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn agent_rejects_unknown_cite_before_publishing() {
    // Arrange: модель готовит файл, но ссылается на результат, которого не было.
    let app = Desktop::new().await;
    let false_reference = Uuid::new_v4();
    let (model, _) = model(move |index, input| match index {
        0 => call(
            index,
            "stage",
            json!({"kind":"create","path":"draft.md","source":"# Проект\n"}),
        ),
        1 => write_policy(input, "Создай заметку", "allow"),
        2 => {
            assert_eq!(result(input)["staged"], true);
            final_with(&json!(false_reference))
        }
        _ => panic!("Неожиданный запрос модели"),
    })
    .await;
    app.connect(&model).await;
    let session = app.session().await;
    let id = Uuid::new_v4();

    // Act: сервер принимает сообщение, затем проверяет ответ модели.
    app.submit(
        session,
        submit(id, root(), false, "Создай заметку"),
        StatusCode::ACCEPTED,
    )
    .await;
    app.drain().await;

    // Assert: неверная ссылка не попадает в историю, подготовленный файл не публикуется.
    let turn = app.turn(session, id).await;
    assert_eq!(turn["status"], "failed", "{turn}");
    assert_eq!(turn["error"]["code"], "invalid_model_final");
    assert!(!app.vault.path().join("draft.md").exists());
}

#[tokio::test]
async fn agent_does_not_publish_after_truncated_model_final() {
    // Arrange: модель возвращает полный JSON, но сообщает об обрыве ответа.
    let app = Desktop::new().await;
    let (model, _) = model(|index, input| match index {
        0 => call(
            index,
            "stage",
            json!({"kind":"create","path":"draft.md","source":"# Draft\n"}),
        ),
        1 => write_policy(input, "Create a note", "allow"),
        2 => {
            assert_eq!(result(input)["staged"], true);
            let mut response = json!({"content":"Draft ready"});
            response["fixture_finish_reason"] = json!("length");
            response
        }
        _ => panic!("Неожиданный запрос модели"),
    })
    .await;
    app.connect(&model).await;
    let session = app.session().await;
    let id = Uuid::new_v4();

    // Act: сервер получает конечный ответ модели.
    app.submit(
        session,
        submit(id, root(), false, "Create a note"),
        StatusCode::ACCEPTED,
    )
    .await;
    app.drain().await;

    // Assert: ответ по лимиту не разрешает публикацию правок.
    let turn = app.turn(session, id).await;
    assert_eq!(turn["status"], "failed", "{turn}");
    assert!(!app.vault.path().join("draft.md").exists());
}
