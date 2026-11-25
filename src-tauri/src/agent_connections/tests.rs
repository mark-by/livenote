mod mcp;
mod oauth;

use super::{ConnectionUpdate, Connections, Profile, SecretChange, Slot, VaultId};
use axum::{Router, serve};
use tokio::net::TcpListener;
use url::Url;

const TOKEN: &str = "fixture-token";

fn state() -> (tempfile::TempDir, Connections, VaultId) {
    let temp = tempfile::tempdir().expect("Каталог настроек");
    let connections =
        Connections::fixture(temp.path().into(), 4317).expect("Настройки подключений");
    let vault = VaultId::new("vault-fixture").expect("Идентификатор vault");
    (temp, connections, vault)
}

fn model_profile(port: u16) -> Profile {
    Profile::Model {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        model: "local".into(),
    }
}

#[tokio::test]
async fn token_uses_private_file_and_does_not_follow_address_changes() {
    use super::{ConnectionError, ConnectionState};
    // Arrange: один vault получает токен модели, другой не получает.
    let (temp, connections, vault) = state();
    connections
        .put(
            &vault,
            Slot::Model,
            ConnectionUpdate {
                profile: model_profile(1234),
                secret: SecretChange::Token {
                    value: TOKEN.into(),
                },
            },
        )
        .await
        .expect("Исходный профиль");
    assert!(connections.model(&vault).await.is_ok());
    let auth = temp.path().join(".livenote").join("auth.json");
    assert!(
        std::fs::read_to_string(&auth)
            .expect("Файл учётных данных")
            .contains(TOKEN)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&auth)
            .expect("Метаданные учётных данных")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let other = VaultId::new("other-vault").expect("Второй vault");

    // Act: форма сохраняет новый адрес с keep.
    let changed = connections
        .put(
            &vault,
            Slot::Model,
            ConnectionUpdate {
                profile: model_profile(1235),
                secret: SecretChange::Keep,
            },
        )
        .await
        .expect("Новый адрес");

    // Assert: старый токен не переходит на новый адрес и не попадает в файл настроек.
    assert_eq!(changed.state, ConnectionState::Missing);
    assert!(matches!(
        connections.model(&vault).await,
        Err(ConnectionError::Missing)
    ));
    assert!(
        connections
            .list(&other)
            .await
            .expect("Настройки второго vault")
            .is_empty()
    );
    let path = super::settings::file(temp.path(), &vault);
    assert!(
        !std::fs::read_to_string(path)
            .expect("Файл настроек")
            .contains(TOKEN)
    );
}

#[tokio::test]
async fn clear_preserves_unrelated_credentials() {
    use super::ConnectionState;
    use serde_json::{Value, json};

    // Arrange: файл содержит запись подключения и постороннюю запись.
    let (temp, connections, vault) = state();
    connections
        .put(
            &vault,
            Slot::Model,
            ConnectionUpdate {
                profile: model_profile(1234),
                secret: SecretChange::Token {
                    value: TOKEN.into(),
                },
            },
        )
        .await
        .expect("Исходный профиль");
    let auth = temp.path().join(".livenote").join("auth.json");
    let mut credentials: Value = serde_json::from_str(
        &std::fs::read_to_string(&auth).expect("Файл учётных данных"),
    )
    .expect("JSON учётных данных");
    credentials
        .as_object_mut()
        .expect("Объект учётных данных")
        .insert(
            "unrelated".into(),
            json!({"Token":"unrelated-value"}),
        );
    std::fs::write(&auth, serde_json::to_vec(&credentials).expect("Запись фикстуры"))
        .expect("Посторонняя запись");

    // Act: пользователь очищает секрет только своего подключения.
    let cleared = connections
        .put(
            &vault,
            Slot::Model,
            ConnectionUpdate {
                profile: model_profile(1234),
                secret: SecretChange::Clear,
            },
        )
        .await
        .expect("Очистка секрета");

    // Assert: посторонняя запись сохранилась, удалённый токен исчез.
    assert_eq!(cleared.state, ConnectionState::Missing);
    let saved: Value = serde_json::from_str(
        &std::fs::read_to_string(auth).expect("Сохранённые учётные данные"),
    )
    .expect("JSON после очистки");
    assert_eq!(saved["unrelated"], json!({"Token":"unrelated-value"}));
    assert!(!saved.to_string().contains(TOKEN));
}

#[tokio::test]
async fn missing_legacy_credential_is_tolerated() {
    use super::ConnectionState;

    // Arrange: профиль ссылается на запись, которой нет в новом файле.
    let (temp, connections, vault) = state();
    connections
        .put(
            &vault,
            Slot::Model,
            ConnectionUpdate {
                profile: model_profile(1234),
                secret: SecretChange::Token {
                    value: TOKEN.into(),
                },
            },
        )
        .await
        .expect("Исходный профиль");
    let auth = temp.path().join(".livenote").join("auth.json");
    std::fs::write(auth, "{}").expect("Файл без старой записи");

    // Act: пользователь открывает список и повторно сохраняет профиль с keep.
    let listed = connections.list(&vault).await.expect("Список подключений");
    let kept = connections
        .put(
            &vault,
            Slot::Model,
            ConnectionUpdate {
                profile: model_profile(1234),
                secret: SecretChange::Keep,
            },
        )
        .await
        .expect("Отсутствующая старая запись не является ошибкой хранилища");

    // Assert: обе операции сообщают об отсутствии секрета без ошибки.
    assert_eq!(listed[0].state, ConnectionState::Missing);
    assert_eq!(kept.state, ConnectionState::Missing);
}

#[tokio::test]
async fn simultaneous_writers_preserve_both_credentials() {
    use serde_json::Value;

    // Arrange: два экземпляра приложения пишут в разные vault одного дома.
    let temp = tempfile::tempdir().expect("Временный дом");
    let first = Connections::fixture(temp.path().into(), 4317).expect("Первый экземпляр");
    let second = Connections::fixture(temp.path().into(), 4317).expect("Второй экземпляр");
    let first_vault = VaultId::new("first-vault").expect("Первый vault");
    let second_vault = VaultId::new("second-vault").expect("Второй vault");

    // Act: оба экземпляра одновременно сохраняют свои токены.
    let (first_result, second_result) = tokio::join!(
        first.put(
            &first_vault,
            Slot::Model,
            ConnectionUpdate {
                profile: model_profile(1234),
                secret: SecretChange::Token {
                    value: "first-fixture-token".into(),
                },
            },
        ),
        second.put(
            &second_vault,
            Slot::Model,
            ConnectionUpdate {
                profile: model_profile(1235),
                secret: SecretChange::Token {
                    value: "second-fixture-token".into(),
                },
            },
        )
    );
    first_result.expect("Первая запись");
    second_result.expect("Вторая запись");

    // Assert: read-modify-write сериализован и обе записи доступны.
    assert!(first.model(&first_vault).await.is_ok());
    assert!(second.model(&second_vault).await.is_ok());
    let auth = temp.path().join(".livenote").join("auth.json");
    let credentials: Value = serde_json::from_str(
        &std::fs::read_to_string(auth).expect("Файл учётных данных"),
    )
    .expect("JSON после одновременной записи");
    assert_eq!(
        credentials
            .as_object()
            .expect("Объект учётных данных")
            .len(),
        2
    );
}

#[cfg(unix)]
#[tokio::test]
async fn auth_symlink_is_rejected_without_touching_target() {
    use super::ConnectionError;

    // Arrange: auth.json заменён ссылкой на файл вне каталога LiveNote.
    let temp = tempfile::tempdir().expect("Временный дом");
    let directory = temp.path().join(".livenote");
    std::fs::create_dir(&directory).expect("Каталог LiveNote");
    let outside = temp.path().join("outside.json");
    std::fs::write(&outside, "fixture-outside").expect("Внешний файл");
    std::os::unix::fs::symlink(&outside, directory.join("auth.json")).expect("Ссылка auth.json");
    let connections = Connections::fixture(temp.path().into(), 4317).expect("Подключения");
    let vault = VaultId::new("vault-fixture").expect("Vault");

    // Act: пользователь пытается сохранить токен.
    let result = connections
        .put(
            &vault,
            Slot::Model,
            ConnectionUpdate {
                profile: model_profile(1234),
                secret: SecretChange::Token {
                    value: TOKEN.into(),
                },
            },
        )
        .await;

    // Assert: операция отклонена, содержимое назначения ссылки не изменилось.
    assert!(matches!(result, Err(ConnectionError::Storage)));
    assert_eq!(
        std::fs::read_to_string(outside).expect("Внешний файл"),
        "fixture-outside"
    );
}

async fn fixture(app: Router) -> Url {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Порт тестового сервера");
    let address = listener.local_addr().expect("Адрес тестового сервера");
    tokio::spawn(async move { serve(listener, app).await.expect("Тестовый сервер") });
    Url::parse(&format!("http://{address}")).expect("URL тестового сервера")
}

#[tokio::test]
async fn model_does_not_follow_redirects_to_another_origin() {
    use super::{ModelError, model, model_http};
    use axum::{response::Redirect, routing::post};
    use rig::completion::CompletionModel;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    // Arrange: endpoint модели перенаправляет POST на другой адрес.
    let redirected = Arc::new(AtomicBool::new(false));
    let seen = redirected.clone();
    let other = fixture(Router::new().route(
        "/receive",
        post(move || async move {
            seen.store(true, Ordering::SeqCst);
        }),
    ))
    .await;
    let target = other
        .join("/receive")
        .expect("Адрес перенаправления")
        .to_string();
    let base = fixture(Router::new().route(
        "/chat/completions",
        post(move || async move { Redirect::temporary(&target) }),
    ))
    .await;
    let client = model::connect(
        model_http::client().expect("HTTP-клиент"),
        base,
        "local".into(),
        TOKEN.into(),
    )
    .expect("Клиент Rig");

    // Act: клиент получает ответ 307.
    let request = client.completion_request("Ping").build();
    let result = client
        .completion(request)
        .await
        .map_err(model::completion_error);

    // Assert: другой сервер не получил POST.
    assert!(matches!(
        result,
        Err(ModelError::Http(axum::http::StatusCode::TEMPORARY_REDIRECT))
    ));
    assert!(!redirected.load(Ordering::SeqCst));
}

#[tokio::test]
async fn model_sends_non_streaming_request_and_parses_function_call() {
    use super::{model, model_http};
    use axum::{Json, http::HeaderMap, routing::post};
    use rig::completion::{AssistantContent, CompletionModel, ToolDefinition};
    use serde_json::{Value, json};

    // Arrange: локальный сервер проверяет протокол Chat Completions.
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers["authorization"], "Bearer fixture-model");
            assert_eq!(body["model"], "local");
            assert_eq!(body["stream"], false);
            assert_eq!(body["parallel_tool_calls"], false);
            assert_eq!(
                body["messages"][0],
                json!({"role": "user", "content": "Где документ?"})
            );
            assert_eq!(body["tools"][0]["function"]["name"], "search");
            Json(
                json!({"id":"call-response","object":"chat.completion","created":0,"model":"local",
                "choices": [{"index":0,"finish_reason":"tool_calls","message": {"role": "assistant", "content": null,
                "tool_calls":[{"type":"function","id":"call_1","function":{
                    "name":"search","arguments":"{\"text\":\"документ\"}"}}]}}]}),
            )
        }),
    );
    let base = fixture(app).await.join("/v1/").expect("Путь API");
    let model = model::connect(
        model_http::client().expect("HTTP-клиент"),
        base,
        "local".into(),
        "fixture-model".into(),
    )
    .expect("Клиент Rig");

    // Act: клиент отправляет вопрос и описание доступного инструмента.
    let request = model
        .completion_request("Где документ?")
        .additional_params(json!({"stream":false,"parallel_tool_calls":false}))
        .tool(ToolDefinition {
            name: "search".into(),
            description: "Search".into(),
            parameters: json!({"type":"object"}),
        })
        .build();
    let reply = model.completion(request).await.expect("Ответ модели");

    // Assert: исполнитель получает имя инструмента и его аргументы.
    assert_eq!(reply.choice.len(), 1);
    let AssistantContent::ToolCall(call) = reply.choice.first() else {
        panic!("Ожидался нативный вызов инструмента");
    };
    assert_eq!(call.id, "call_1");
    assert_eq!(call.function.name, "search");
    assert_eq!(call.function.arguments, json!({"text":"документ"}));
}
