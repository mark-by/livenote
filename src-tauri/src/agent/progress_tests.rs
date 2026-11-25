use super::*;
use tokio::sync::Notify;

#[derive(Clone, Default)]
struct Gate {
    reached: Arc<Notify>,
    release: Arc<Notify>,
}

impl Gate {
    async fn hold(&self) {
        self.reached.notify_one();
        self.release.notified().await;
    }

    async fn wait(&self) {
        timeout(DEADLINE, self.reached.notified())
            .await
            .expect("Операция началась");
    }

    fn open(&self) {
        self.release.notify_one();
    }
}

#[tokio::test]
async fn agent_progress_reports_started_model_and_external_search_over_http() {
    // Arrange: модель, проверка разрешения и внешний поиск ждут разрешения от теста.
    let app = Desktop::new().await;
    let planner = Gate::default();
    let answer = Gate::default();
    let provider = Gate::default();
    let search = Gate::default();
    let verify = Gate::default();
    let model_routes = Router::new().route(
        "/v1/chat/completions",
        post({
            let (planner, answer, verify) = (planner.clone(), answer.clone(), verify.clone());
            let calls = Arc::new(AtomicUsize::new(0));
            move |Json(input): Json<Value>| async move {
                let message = match calls.fetch_add(1, Ordering::SeqCst) {
                    0 => {
                        planner.hold().await;
                        call(0, "search", json!({"text":NEEDLE,"limit":5}))
                    }
                    1 => {
                        answer.hold().await;
                        call(1, "next_source", json!({}))
                    }
                    2 => call(2, "search", json!({"remoteIndex":0,"limit":5})),
                    3 => remote_policy(&input, NEEDLE, &[NEEDLE]),
                    4 => {
                        verify.hold().await;
                        final_with(&result(&input)["hits"][0]["ref"])
                    }
                    _ => panic!("Неожиданный запрос модели"),
                };
                Json(completion_fixture(message))
            }
        }),
    );
    let model = listen(model_routes).await;
    let tool_calls = Arc::new(AtomicUsize::new(0));
    let mcp_routes = Router::new().route(
        "/mcp",
        post({
            let (provider, search) = (provider.clone(), search.clone());
            move |headers: HeaderMap, Json(input): Json<Value>| async move {
                if input["method"] == "initialize" {
                    provider.hold().await;
                }
                if input["method"] == "tools/call" {
                    search.hold().await;
                }
                mcp(State(tool_calls), headers, Json(input)).await
            }
        }),
    );
    let mcp = listen(mcp_routes).await;
    app.connect(&model).await;
    connect_confluence(&app, &mcp).await;
    let session = app.session().await;
    let other_session = app.session().await;
    let id = Uuid::new_v4();

    // Act: запрашиваем снимки, пока каждая операция ещё ждёт.
    app.submit(
        session,
        submit(id, root(), false, NEEDLE),
        StatusCode::ACCEPTED,
    )
    .await;
    planner.wait().await;
    let planning = app.turn(session, id).await;
    planner.open();
    answer.wait().await;
    let answering = app.turn(session, id).await;
    answer.open();
    provider.wait().await;
    let connecting = app.turn(session, id).await;
    provider.open();
    search.wait().await;
    let searching = app.turn(session, id).await;
    app.json(
        Method::GET,
        &format!("/sessions/{other_session}/turns/{id}"),
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    let file = app
        .data
        .path()
        .join("agent")
        .join(app.service.startup_id())
        .join("sessions.json");
    let on_disk: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    search.open();
    verify.wait().await;
    let verifying = app.turn(session, id).await;
    verify.open();
    app.drain().await;
    let done = app.turn(session, id).await;
    let saved: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();

    // Assert: снимки показывают начатые действия без аргументов, путей и секретов.
    let model_event = json!({"kind":"model"});
    assert_eq!(planning["status"], "running");
    assert_eq!(planning["progress"]["stepsUsed"], 1);
    assert!(planning["progress"]["contextTokens"].as_u64().unwrap() > 0);
    assert_eq!(planning["progress"]["contextLimitTokens"], 65_536);
    assert_eq!(planning["progress"]["events"], json!([model_event]));
    assert_eq!(answering["status"], "running");
    assert_eq!(answering["progress"]["stepsUsed"], 2);
    assert_eq!(
        answering["progress"]["events"],
        json!([model_event, {"kind":"search","source":"vault"},
            {"kind":"search","source":"vault"}, model_event])
    );
    assert_eq!(searching["status"], "running");
    assert_eq!(connecting, searching);
    assert_eq!(searching["progress"]["stepsUsed"], 4);
    assert_eq!(
        searching["progress"]["events"],
        json!([
            model_event, {"kind":"search","source":"vault"}, {"kind":"search","source":"vault"},
            model_event, {"kind":"next_source","source":"confluence"}, model_event, model_event,
            {"kind":"search","source":"confluence"}
        ])
    );
    assert!(on_disk["sessions"][0]["turns"][0].get("progress").is_none());
    let mut events = searching["progress"]["events"].as_array().unwrap().clone();
    events.push(model_event);
    assert_eq!(verifying["status"], "running");
    assert_eq!(verifying["progress"]["stepsUsed"], 5);
    assert_eq!(verifying["progress"]["events"], json!(events));
    assert_eq!(done["status"], "done", "{done}");
    assert_eq!(done["progress"], verifying["progress"]);
    assert_eq!(
        saved["sessions"][0]["turns"][0]["progress"],
        done["progress"]
    );
}

#[tokio::test]
async fn agent_finishes_a_request_with_more_than_twenty_distinct_steps() {
    // Arrange: модель читает разные строки, затем готовит правку.
    let app = Desktop::new().await;
    fs::write(app.vault.path().join("notes.md"), "строка\n".repeat(22)).unwrap();
    let (model, _) = model(|index, input| match index {
        0..=21 => call(
            index,
            "read_vault",
            json!({"path":"notes.md","lines":{"first":index + 1,"last":index + 1}}),
        ),
        22 => call(
            index,
            "stage",
            json!({"kind":"create","path":"result.md","source":"# Итог\n"}),
        ),
        23 => write_policy(input, "Обнови заметку", "allow"),
        24 => json!({"content":"Готово."}),
        _ => panic!("Неожиданный вызов модели"),
    })
    .await;

    // Act: выполняем один запрос с серией разных чтений.
    let turn = run_turn(&app, &model).await;

    // Assert: агент публикует результат после 20-го шага.
    assert_eq!(turn["changed"], json!(["result.md"]), "{turn}");
    let events = turn["progress"]["events"].as_array().unwrap();
    let reads: Vec<_> = events
        .iter()
        .filter(|event| event["kind"] == "read_vault")
        .cloned()
        .collect();
    let expected: Vec<_> = (1..=22)
        .map(|line| json!({"kind":"read_vault","source":"vault","target":{"path":"notes.md","line":line}}))
        .collect();
    assert_eq!(reads, expected);
    let stage = events.iter().find(|event| event["kind"] == "stage");
    let expected = json!({"kind":"stage","source":"vault","target":{"path":"result.md","pendingPublish":true}});
    assert_eq!(stage, Some(&expected));
}

#[tokio::test]
async fn agent_stops_repeating_an_action_and_discards_staged_changes() {
    // Arrange: после stage модель зацикливается на чтении одной строки.
    let app = Desktop::new().await;
    let (model, calls) = model(|index, input| match index {
        0 => call(
            index,
            "stage",
            json!({"kind":"create","path":"draft.md","source":"# Черновик\n"}),
        ),
        1 => write_policy(input, "Обнови заметку", "allow"),
        _ => call(
            index,
            "read_vault",
            json!({"path":"draft.md","lines":{"first":1,"last":1}}),
        ),
    })
    .await;

    // Act: получаем результат запроса через HTTP.
    let turn = run_turn(&app, &model).await;

    // Assert: остановка не зависит от общего числа шагов. Файл не публикуется.
    assert_eq!(turn["status"], "failed", "{turn}");
    assert_eq!(turn["error"]["code"], "agent_repeated_action");
    assert_eq!(turn["progress"]["stepsUsed"], 6);
    assert_eq!(calls.load(Ordering::SeqCst), 6);
    let message = turn["error"]["message"].as_str().unwrap();
    assert!(message.contains("не сохранены"));
    assert!(!app.vault.path().join("draft.md").exists());
    let events = turn["progress"]["events"].as_array().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "read_vault")
            .count(),
        3
    );
    assert!(!events.iter().any(|event| event["kind"] == "commit"));
}

#[tokio::test]
async fn agent_progress_distinguishes_context_limit_before_another_model_call() {
    // Arrange: одно чтение допустимо, но его результат превышает выбранный лимит.
    let app = Desktop::new().await;
    fs::write(app.vault.path().join("large.md"), "я".repeat(30 * 1024)).unwrap();
    let (model, calls) = model(|index, _| match index {
        0 => call(
            index,
            "read_vault",
            json!({"path":"large.md","lines":{"first":1,"last":1}}),
        ),
        _ => panic!("Модель не должна получать ещё один запрос"),
    })
    .await;

    // Act: получаем результат запроса через HTTP.
    app.connect(&model).await;
    let session = app.session().await;
    let id = Uuid::new_v4();
    let mut input = submit(id, root(), false, "Обнови заметку");
    input["contextLimitTokens"] = json!(8192);
    app.submit(session, input, StatusCode::ACCEPTED).await;
    app.drain().await;
    let turn = app.turn(session, id).await;

    // Assert: в ошибке тот же размер, что в снимке; лишнего вызова модели нет.
    assert_eq!(turn["status"], "failed", "{turn}");
    assert_eq!(turn["error"]["code"], "agent_context_too_large");
    let progress = &turn["progress"];
    let tokens = progress["contextTokens"].as_u64().unwrap();
    assert_eq!(progress["contextLimitTokens"], 8192);
    assert!(tokens > 8192);
    assert_eq!(progress["stepsUsed"], 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        progress["events"].as_array().unwrap().last().unwrap(),
        &json!({"kind":"read_vault","source":"vault","target":{"path":"large.md","line":1}})
    );
}

#[tokio::test]
async fn agent_progress_omits_commit_when_staged_patch_restores_original() {
    // Arrange: модель меняет текст и возвращает его к исходному.
    let app = Desktop::new().await;
    let path = "note.md";
    let original = "🏗\r\nabc\n";
    fs::write(app.vault.path().join(path), original).unwrap();
    let (model, _) = model(move |index, input| match index {
        0 | 3 => call(
            index,
            "read_vault",
            json!({"path":path,"lines":{"first":1,"last":2}}),
        ),
        1 | 4 => {
            let (old, text) = if index == 1 { ("a", "z") } else { ("z", "a") };
            call(
                index,
                "stage",
                json!({
                    "kind":"patch","readId":result(input)["readId"],"layout":"preserve",
                    "edits":[{"from":4,"to":5,"old":old,"text":text}]
                }),
            )
        }
        2 => write_policy(input, "Обнови заметку", "allow"),
        5 => json!({"content":"Исходный текст восстановлен."}),
        _ => panic!("Неожиданный запрос модели"),
    })
    .await;

    // Act: запускаем один ход и ждём итог.
    let turn = run_turn(&app, &model).await;

    // Assert: оба stage начались, но публикация не началась.
    assert_eq!(turn["status"], "done", "{turn}");
    assert_eq!(turn["changed"], json!([]));
    let events = turn["progress"]["events"].as_array().unwrap();
    let stages: Vec<_> = events
        .iter()
        .filter(|event| event["kind"] == "stage")
        .collect();
    let expected = json!({"kind":"stage","source":"vault","target":{"path":path,"line":2}});
    assert_eq!(stages, [&expected, &expected]);
    assert!(!events.iter().any(|event| event["kind"] == "commit"));
    assert_eq!(
        fs::read_to_string(app.vault.path().join(path)).unwrap(),
        original
    );
}

async fn run_turn(app: &Desktop, model: &Listener) -> Value {
    app.connect(model).await;
    let session = app.session().await;
    let id = Uuid::new_v4();
    app.submit(
        session,
        submit(id, root(), false, "Обнови заметку"),
        StatusCode::ACCEPTED,
    )
    .await;
    app.drain().await;
    app.turn(session, id).await
}
