use super::*;
use axum::body::{Body, Bytes};
use tokio::{sync::mpsc, time::Instant};

const QUESTION: &str = "Создай заметку";
const PATH: &str = "retry.md";
const NOTE: &str = "# Заметка\n";
const ANSWER: &str = "Заметка готова.";
const PRIVATE_BODY: &str = "fixture-private-provider-body";

struct Observation {
    body: Bytes,
    at: Instant,
}

async fn staged_model(
    reply: impl Fn(usize) -> Response + Clone + Send + Sync + 'static,
) -> (Listener, mpsc::UnboundedReceiver<Observation>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let routes = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap, body: Bytes| async move {
            assert_eq!(
                headers[header::AUTHORIZATION],
                format!("Bearer {PROVIDER_TOKEN}")
            );
            let input = serde_json::from_slice(&body).unwrap();
            let index = calls.fetch_add(1, Ordering::SeqCst);
            tx.send(Observation {
                body,
                at: Instant::now(),
            })
            .unwrap();
            match index {
                0 => Json(completion_fixture(call(
                    index,
                    "stage",
                    json!({"kind":"create","path":PATH,"source":NOTE}),
                )))
                .into_response(),
                1 => Json(completion_fixture(write_policy(&input, QUESTION, "allow")))
                    .into_response(),
                _ => {
                    assert_eq!(result(&input), json!({"staged":true}));
                    reply(index - 2)
                }
            }
        }),
    );
    (listen(routes).await, rx)
}

async fn start_turn(app: &Desktop, model: &Listener) -> (Uuid, Uuid) {
    app.connect(model).await;
    let session = app.session().await;
    let id = Uuid::new_v4();
    let accepted = app
        .submit(
            session,
            submit(id, root(), false, QUESTION),
            StatusCode::ACCEPTED,
        )
        .await;
    assert_eq!(accepted["status"], "running");
    (session, id)
}

fn requests(rx: &mut mpsc::UnboundedReceiver<Observation>) -> Vec<Observation> {
    std::iter::from_fn(|| rx.try_recv().ok()).collect()
}

fn events(turn: &Value, kind: &str) -> usize {
    turn["progress"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == kind)
        .count()
}

fn no_publication(app: &Desktop, turn: &Value) {
    assert_eq!(events(turn, "stage"), 1);
    assert_eq!(events(turn, "commit"), 0);
    assert!(turn.get("changed").is_none(), "{turn}");
    assert!(!app.vault.path().join(PATH).exists());
}

fn provider_error(status: StatusCode, retry_after: Option<&str>) -> Response {
    match retry_after {
        Some(value) => (status, [(header::RETRY_AFTER, value)], PRIVATE_BODY).into_response(),
        None => (status, PRIVATE_BODY).into_response(),
    }
}

#[tokio::test]
async fn agent_retries_same_model_request_after_stage_and_publishes_once() {
    // Arrange: после stage модель отвечает сначала 503, затем 429.
    let app = Desktop::new().await;
    let (model, mut received) = staged_model(|attempt| match attempt {
        0 => provider_error(
            StatusCode::SERVICE_UNAVAILABLE,
            Some("Sun, 06 Nov 1994 08:49:37 GMT"),
        ),
        1 => provider_error(StatusCode::TOO_MANY_REQUESTS, Some("1")),
        _ => Json(completion_fixture(json!({"content":ANSWER}))).into_response(),
    })
    .await;

    // Act: нативный роутер принимает запрос и возвращает итог.
    let (session, id) = start_turn(&app, &model).await;
    app.drain().await;
    let turn = app.turn(session, id).await;

    // Assert: повторы не добавляют шаги Rig и не вызывают stage повторно.
    let sent = requests(&mut received);
    assert_eq!(
        turn["status"],
        "done",
        "отправлено {} запросов; итог: {turn}",
        sent.len()
    );
    assert_eq!(turn["answer"], ANSWER);
    assert_eq!(turn["changed"], json!([PATH]));
    // Включает отдельную проверку разрешения записи.
    assert_eq!(turn["progress"]["stepsUsed"], 3);
    assert_eq!(events(&turn, "stage"), 1);
    assert_eq!(events(&turn, "commit"), 1);
    assert_eq!(
        fs::read_to_string(app.vault.path().join(PATH)).unwrap(),
        NOTE
    );
    let [_, _, first, second, third] = sent.as_slice() else {
        panic!("Ожидалось пять запросов, получено {}", sent.len());
    };
    assert!(
        first.body == second.body && second.body == third.body,
        "Тела запросов различаются"
    );
    assert!(
        third.at - second.at >= Duration::from_secs(1),
        "Повтор начался раньше Retry-After"
    );
}

async fn assert_failed(
    reply: impl Fn(usize) -> Response + Clone + Send + Sync + 'static,
    attempts: usize,
    (code, status): (&str, Option<StatusCode>),
) {
    let app = Desktop::new().await;
    let (model, mut received) = staged_model(reply).await;
    let (session, id) = start_turn(&app, &model).await;
    app.drain().await;
    let turn = app.turn(session, id).await;
    assert_eq!(turn["status"], "failed", "{turn}");
    assert_eq!(turn["error"]["code"], code, "{turn}");
    let message = turn["error"]["message"].as_str().unwrap();
    if let Some(status) = status {
        assert!(
            message.contains(&format!("HTTP {}", status.as_u16())),
            "{turn}"
        );
    }
    assert!(!message.contains(PRIVATE_BODY));
    assert!(!message.contains(PROVIDER_TOKEN));
    assert!(!message.contains(&model.origin));
    no_publication(&app, &turn);
    let sent = requests(&mut received);
    assert_eq!(sent.len(), 2 + attempts, "{turn}");
    assert!(
        sent[2..]
            .windows(2)
            .all(|pair| pair[0].body == pair[1].body)
    );
}

#[tokio::test]
async fn agent_bounds_persistent_model_failure_without_publishing() {
    // Arrange / Act / Assert: проверяем предел попыток после stage и ошибку HTTP 503 в API.
    let status = StatusCode::SERVICE_UNAVAILABLE;
    assert_failed(
        move |_| provider_error(status, None),
        3,
        ("model_http_error", Some(status)),
    )
    .await;
}

#[tokio::test]
async fn agent_does_not_retry_permanent_model_status() {
    // Arrange / Act / Assert: проверяем отдельные случаи постоянных ошибок после stage.
    for (status, code) in [
        (StatusCode::BAD_REQUEST, "model_request_rejected"),
        (StatusCode::UNAUTHORIZED, "model_auth"),
        (StatusCode::FORBIDDEN, "model_auth"),
        (StatusCode::NOT_IMPLEMENTED, "model_http_error"),
    ] {
        assert_failed(
            move |_| provider_error(status, None),
            1,
            (code, Some(status)),
        )
        .await;
    }
}

#[tokio::test]
async fn agent_does_not_retry_invalid_model_response() {
    // Arrange / Act / Assert: полностью полученный ответ HTTP 200 не предписывает повтор.
    for (body, code) in [
        (
            format!("{{\"message\":\"{PRIVATE_BODY}\""),
            "invalid_model_response",
        ),
        (
            json!({"error":{"message":PRIVATE_BODY}}).to_string(),
            "invalid_model_response",
        ),
        (PRIVATE_BODY.repeat(100_000), "model_response_too_large"),
    ] {
        assert_failed(move |_| body.clone().into_response(), 1, (code, None)).await;
    }
}

#[tokio::test]
async fn agent_does_not_retry_before_long_retry_after() {
    // Arrange / Act / Assert: поставщик просит подождать дольше допустимого в двух форматах.
    let status = StatusCode::TOO_MANY_REQUESTS;
    let tomorrow =
        httpdate::fmt_http_date(std::time::SystemTime::now() + Duration::from_secs(86_400));
    for value in ["15".to_owned(), tomorrow] {
        assert_failed(
            move |_| provider_error(status, Some(&value)),
            1,
            ("model_rate_limited", Some(status)),
        )
        .await;
    }
}

#[tokio::test]
async fn agent_retries_interrupted_model_response_as_transport_error() {
    // Arrange / Act / Assert: HTTP 200 начался, но поток тела завершился сетевой ошибкой.
    assert_failed(
        |_| {
            Body::from_stream(async_stream::stream! {
                yield Ok::<_, std::io::Error>(Bytes::from_static(b"{"));
                tokio::task::yield_now().await;
                yield Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
            })
            .into_response()
        },
        3,
        ("model_response_interrupted", None),
    )
    .await;
}

#[tokio::test]
async fn agent_shutdown_cancels_pending_model_retry_without_publishing() {
    // Arrange: после stage модель требует отложить повтор.
    let app = Desktop::new().await;
    let (model, mut received) = staged_model(|attempt| match attempt {
        0 => provider_error(StatusCode::TOO_MANY_REQUESTS, Some("1")),
        _ => Json(completion_fixture(json!({"content":ANSWER}))).into_response(),
    })
    .await;

    // Act: завершаем работу после HTTP 429, пока повтор ещё не начался.
    let (session, id) = start_turn(&app, &model).await;
    let last = timeout(DEADLINE, async {
        received.recv().await.unwrap();
        received.recv().await.unwrap();
        received.recv().await.unwrap()
    })
    .await
    .unwrap();
    let scheduled_retry = last.at + Duration::from_secs(1);
    assert!(
        timeout(Duration::from_millis(250), received.recv())
            .await
            .is_err()
    );
    assert_eq!(app.turn(session, id).await["status"], "running");
    app.shutdown.cancel();
    app.drain().await;

    // Assert: после срока повтора запросов нет, файл остался неопубликованным.
    let turn = app.turn(session, id).await;
    assert_eq!(turn["status"], "interrupted", "{turn}");
    assert_eq!(turn["error"]["code"], "interrupted", "{turn}");
    no_publication(&app, &turn);
    let observe_until = scheduled_retry + Duration::from_millis(250);
    assert!(
        tokio::time::timeout_at(observe_until, received.recv())
            .await
            .is_err()
    );
}
