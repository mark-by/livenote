use super::*;
use tokio::sync::Notify;

#[tokio::test]
async fn agent_reopens_legacy_chat_without_the_outcome_footer() {
    // Arrange: сохраняем разговор в формате, который записывала прежняя версия.
    let app = Desktop::new().await;
    let session = app.session().await;
    let path = app
        .data
        .path()
        .join("agent")
        .join(app.service.startup_id())
        .join("sessions.json");
    let mut saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let answer = "Схема добавлена.";
    let note_path = "local/test-mermaid-capacity.md";
    let cites = json!([{"kind":"vault","path":note_path,"line":1}]);
    let legacy = json!({"changed":[note_path],"cites":cites,"searchPhrases":[]});
    saved["sessions"][0]["turns"] = json!([{
        "id":Uuid::new_v4(),"at":saved["sessions"][0]["summary"]["updatedAt"],
        "text":"Добавь схему","status":"done",
        "answer":format!("{answer}\n\nLiveNote outcome for that request: {legacy}"),
        "changed":[note_path],"cites":cites
    }]);
    let before = serde_json::to_vec(&saved).unwrap();
    fs::write(&path, &before).unwrap();

    // Act: открываем историю через HTTP с новым экземпляром сервера.
    let runtime = runtime(app.data.path(), CancellationToken::new());
    let restart = desktop(app.service.clone(), runtime).await;
    let url = format!("{}{}/sessions/{session}", restart.origin, app.base());
    let conversation = json_response(
        app.client
            .get(url)
            .header("x-livenote-agent", "1")
            .bearer_auth(API_TOKEN),
        StatusCode::OK,
    )
    .await;

    // Assert: текст очищен, а поля результата и файл истории не меняются при чтении.
    let turn = &conversation["turns"][0];
    assert_eq!(turn["answer"], answer, "{turn}");
    assert_eq!(turn["changed"], json!([note_path]));
    assert_eq!(turn["cites"], cites);
    assert_eq!(fs::read(path).unwrap(), before);
}

#[tokio::test]
async fn agent_returns_not_found_for_both_removed_undo_routes() {
    // Arrange: открываем хранилище и используем авторизованный HTTP-клиент.
    let app = Desktop::new().await;
    let base = app.base();
    let list = app.request(Method::GET, &format!("{base}/undo"));
    let apply = app
        .request(Method::POST, &format!("{base}/undo/{}", Uuid::nil()))
        .json(&json!({"unexpected": true}));

    // Act: запрашиваем оба пути. Старый обработчик POST отклонял неизвестное поле.
    let (list, apply) = tokio::join!(list.send(), apply.send());

    // Assert: сервер сообщает об отсутствии обоих маршрутов, а не об ошибке тела.
    assert_eq!(
        [list.unwrap().status(), apply.unwrap().status()],
        [StatusCode::NOT_FOUND; 2]
    );
}

#[tokio::test]
async fn agent_keeps_ten_sessions_per_open_vault() {
    // Arrange: открыты два vault, в первом создано одиннадцать разговоров.
    let app = Desktop::new().await;
    let other_vault = tempdir().expect("Второй vault");
    let other = app
        .service
        .open_selected(other_vault.path().into())
        .await
        .expect("Открыть второй vault");
    let other_id = other["id"].as_str().expect("Идентификатор второго vault");
    let oldest = app.session().await;
    let mut retained = Vec::new();
    for _ in 0..10 {
        retained.push(app.session().await);
    }

    // Act: запрашиваем разговоры в обоих vault.
    let first = app
        .json(Method::GET, "/sessions", None, StatusCode::OK)
        .await;
    let other_sessions = format!("/api/vaults/{other_id}/agent/sessions");
    let second = json_response(app.request(Method::GET, &other_sessions), StatusCode::OK).await;

    // Assert: первый vault отдаёт новые разговоры, второй не видит их идентификаторы.
    let ids: Vec<_> = first
        .as_array()
        .expect("Список разговоров")
        .iter()
        .map(|row| &row["id"])
        .collect();
    let expected: Vec<_> = retained.into_iter().rev().map(|id| json!(id)).collect();
    assert_eq!(ids, expected.iter().collect::<Vec<_>>());
    assert_eq!(second, json!([]));
    app.json(
        Method::GET,
        &format!("/sessions/{oldest}"),
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    json_response(
        app.request(
            Method::GET,
            &format!("{other_sessions}/{}", expected[0].as_str().expect("UUID")),
        ),
        StatusCode::NOT_FOUND,
    )
    .await;
}

#[tokio::test]
async fn agent_publishes_a_group_and_records_changed_paths_in_history() {
    // Arrange: модель готовит правки двух файлов в одном сообщении.
    let app = Desktop::new().await;
    let created = ["first.md", "second.md"];
    let (model, _) = model(move |index, input| match index {
        0 | 2 => call(
            index,
            "stage",
            json!({"kind":"create","path":created[index / 2],"source":"# Заметка\n"}),
        ),
        1 => write_policy(input, "Создай две заметки", "allow"),
        3 => {
            assert_eq!(result(input)["staged"], true);
            json!({"content":"Заметки готовы."})
        }
        _ => panic!("Неожиданный вызов модели"),
    })
    .await;
    app.connect(&model).await;
    let session = app.session().await;
    let id = Uuid::new_v4();
    app.submit(
        session,
        submit(id, root(), false, "Создай две заметки"),
        StatusCode::ACCEPTED,
    )
    .await;
    app.drain().await;
    let terminal = app.turn(session, id).await;
    assert_eq!(terminal["changed"], json!(created), "{terminal}");
    assert_eq!(terminal["answer"], "Заметки готовы.");
    assert_eq!(
        terminal["progress"]["events"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        &json!({"kind":"commit","source":"vault"})
    );
    let history = app
        .json(
            Method::GET,
            &format!("/sessions/{session}"),
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(history["turns"][0], terminal);
    for path in created {
        assert_eq!(
            fs::read_to_string(app.vault.path().join(path)).expect("Опубликованный файл"),
            "# Заметка\n"
        );
    }
}

#[tokio::test]
async fn agent_deduplicates_busy_turn_and_recovers_running_turn_after_restart() {
    // Arrange: модель не завершает первое сообщение, пока приложение открыто.
    let app = Desktop::new().await;
    let reached = Arc::new(Notify::new());
    let model = listen(Router::new().route(
        "/v1/chat/completions",
        post({
            let reached = reached.clone();
            move || async move {
                reached.notify_one();
                std::future::pending::<Json<Value>>().await
            }
        }),
    ))
    .await;
    app.connect(&model).await;
    let session = app.session().await;
    let other = app.session().await;
    let id = Uuid::new_v4();
    let input = submit(id, root(), false, "Проверь проект");
    let accepted = app
        .submit(session, input.clone(), StatusCode::ACCEPTED)
        .await;
    timeout(DEADLINE, reached.notified())
        .await
        .expect("Модель получила сообщение");

    // Act: повторяем запрос и сохраняем копию данных, как после внезапного выхода.
    let replay = app
        .submit(session, input.clone(), StatusCode::ACCEPTED)
        .await;
    let collision = app.submit(other, input.clone(), StatusCode::CONFLICT).await;
    let busy = app
        .submit(
            other,
            submit(Uuid::new_v4(), root(), false, "Другой вопрос"),
            StatusCode::CONFLICT,
        )
        .await;
    let recovered = tempdir().expect("Данные после перезапуска");
    let relative = Path::new("agent")
        .join(app.service.startup_id())
        .join("sessions.json");
    fs::create_dir_all(
        recovered
            .path()
            .join(relative.parent().expect("Каталог истории")),
    )
    .expect("Каталог данных");
    fs::copy(
        app.data.path().join(&relative),
        recovered.path().join(&relative),
    )
    .expect("Снимок истории");
    app.shutdown.cancel();
    app.drain().await;
    let restart = desktop(
        app.service.clone(),
        runtime(recovered.path(), CancellationToken::new()),
    )
    .await;
    let url = format!(
        "{}{}/sessions/{session}/turns/{id}",
        restart.origin,
        app.base()
    );
    let interrupted = json_response(
        app.client
            .get(url)
            .header("x-livenote-agent", "1")
            .bearer_auth(API_TOKEN),
        StatusCode::OK,
    )
    .await;

    // Assert: дубль не запускает модель, новая операция занята, снимок не переигрывается.
    assert_eq!(replay, accepted);
    assert_eq!(replay["status"], "running");
    assert_eq!(collision["error"]["code"], "id_reused");
    assert_eq!(busy["error"]["code"], "busy");
    assert_eq!(interrupted["status"], "interrupted");
    assert!(interrupted.get("progress").is_none());
    let retry_url = format!("{}{}/sessions/{session}/turns", restart.origin, app.base());
    let retried = json_response(
        app.client
            .post(retry_url)
            .header("x-livenote-agent", "1")
            .bearer_auth(API_TOKEN)
            .json(&input),
        StatusCode::ACCEPTED,
    )
    .await;
    assert_eq!(retried, interrupted);
}
