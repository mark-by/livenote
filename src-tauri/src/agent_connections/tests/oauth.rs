use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    Form, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use super::{fixture, state};
use crate::agent_connections as c;

const CALLBACK_HOST: &str = "127.0.0.1:4317";
const CLIENT_ID: &str = "fixture-app";
const CODE: &str = "fixture-code";

#[derive(Default)]
struct Issuer {
    challenges: Mutex<HashMap<String, String>>,
    grants: Mutex<Vec<String>>,
}

impl Issuer {
    fn register(&self, url: &Url) -> String {
        let params = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["client_id"], CLIENT_ID);
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(
            params["redirect_uri"],
            format!("http://{CALLBACK_HOST}{}", c::OAUTH_CALLBACK_PATH)
        );
        assert!(!params.contains_key("code_verifier"));
        self.challenges
            .lock()
            .expect("Ожидаемые PKCE challenge")
            .insert(CODE.into(), params["code_challenge"].clone());
        params["state"].clone()
    }
}

async fn mcp(headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    let host = headers["host"].to_str().expect("Host тестового MCP");
    if headers
        .get("authorization")
        .is_none_or(|value| value != "Bearer access-renewed")
    {
        return (
            StatusCode::UNAUTHORIZED,
            [(
                "WWW-Authenticate",
                format!("Bearer scope=\"read\", resource_metadata=\"http://{host}/metadata\""),
            )],
        )
            .into_response();
    }
    let result = match body["method"].as_str() {
        Some("initialize") => json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}}}),
        Some("notifications/initialized") => return StatusCode::ACCEPTED.into_response(),
        Some("tools/list") => json!({"tools":[
            {"name":"confluence_search","inputSchema":{"type":"object"}},
            {"name":"confluence_get_page","inputSchema":{"type":"object"}}
        ]}),
        _ => panic!("Неожиданный метод MCP"),
    };
    Json(json!({"jsonrpc":"2.0","id":body["id"],"result":result})).into_response()
}

async fn resource(headers: HeaderMap) -> Json<Value> {
    let host = headers["host"].to_str().expect("Host метаданных ресурса");
    Json(
        json!({"resource":format!("http://{host}/mcp"), "authorization_servers":[format!("http://{host}/")]}),
    )
}

async fn issuer(headers: HeaderMap) -> Json<Value> {
    let host = headers["host"].to_str().expect("Host OAuth");
    let base = format!("http://{host}");
    Json(json!({
        "issuer":format!("{base}/"),"authorization_endpoint":format!("{base}/authorize"),
        "token_endpoint":format!("{base}/token"),"response_types_supported":["code"],
        "code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],
    }))
}

async fn token(
    State(issuer): State<Arc<Issuer>>,
    Form(form): Form<HashMap<String, String>>,
) -> Json<Value> {
    assert_eq!(form["client_id"], CLIENT_ID);
    assert!(!form.contains_key("client_secret"));
    assert!(form["resource"].ends_with("/mcp"));
    issuer
        .grants
        .lock()
        .expect("Запросы обмена")
        .push(form["grant_type"].clone());
    match form["grant_type"].as_str() {
        "authorization_code" => {
            assert_eq!(
                form["redirect_uri"],
                format!("http://{CALLBACK_HOST}{}", c::OAUTH_CALLBACK_PATH)
            );
            let challenge = issuer
                .challenges
                .lock()
                .expect("Ожидаемый PKCE challenge")
                .remove(&form["code"])
                .expect("Одноразовый код");
            assert_eq!(
                URL_SAFE_NO_PAD.encode(Sha256::digest(form["code_verifier"].as_bytes())),
                challenge
            );
            Json(
                json!({"token_type":"Bearer","access_token":"access-first","refresh_token":"refresh-first","expires_in":0}),
            )
        }
        "refresh_token" => {
            assert_eq!(form["refresh_token"], "refresh-first");
            Json(json!({"token_type":"Bearer","access_token":"access-renewed","expires_in":3600}))
        }
        _ => panic!("Неожиданный способ обмена"),
    }
}

fn callback<'a>(host: &'a str, state: &'a str) -> c::OAuthCallback<'a> {
    c::OAuthCallback {
        host,
        state,
        code: CODE,
    }
}

#[tokio::test]
async fn oauth_pkce_binds_state_to_loopback_and_refreshes_without_browser() {
    // Arrange: локальный OAuth-сервер выдаёт сразу истёкший токен.
    let oauth = Arc::new(Issuer::default());
    let upstream = fixture(
        Router::new()
            .route("/mcp", post(mcp))
            .route("/metadata", get(resource))
            .route("/.well-known/oauth-authorization-server", get(issuer))
            .route("/token", post(token))
            .with_state(oauth.clone()),
    )
    .await;
    let (_temp, connections, vault) = state();
    let slot = c::Slot::Confluence;
    let profile = c::Profile::Confluence {
        endpoint: upstream.join("/mcp").expect("Путь MCP").to_string(),
        resource_host: "conf.example.com".into(),
    };
    connections
        .put(
            &vault,
            slot,
            c::ConnectionUpdate {
                profile: profile.clone(),
                secret: c::SecretChange::Oauth {
                    client_id: CLIENT_ID.into(),
                },
            },
        )
        .await
        .expect("Регистрация публичного клиента");
    let url = connections
        .begin_oauth(&vault, slot)
        .await
        .expect("URL авторизации");
    let login_state = oauth.register(&url);

    // Act: вход подтверждают на loopback, затем открывают MCP.
    assert_eq!(
        connections
            .finish_oauth(callback("example.org:4317", &login_state))
            .await,
        Err(c::ConnectionError::OAuthState)
    );
    connections
        .finish_oauth(callback(CALLBACK_HOST, &login_state))
        .await
        .expect("Обмен кода");
    assert_eq!(
        connections
            .finish_oauth(callback(CALLBACK_HOST, &login_state))
            .await,
        Err(c::ConnectionError::OAuthState)
    );
    assert!(
        connections
            .mcp(&vault, c::Provider::Confluence)
            .await
            .is_ok()
    );

    // Assert: вход одноразовый, MCP получил только обновлённый токен.
    assert_eq!(
        *oauth.grants.lock().expect("Запросы обмена"),
        ["authorization_code", "refresh_token"]
    );
    assert_eq!(
        connections.list(&vault).await.expect("Статус")[0].state,
        c::ConnectionState::Ready
    );

    let pending = connections
        .begin_oauth(&vault, slot)
        .await
        .expect("Второй вход");
    let stale = oauth.register(&pending);
    connections
        .put(
            &vault,
            slot,
            c::ConnectionUpdate {
                profile,
                secret: c::SecretChange::Keep,
            },
        )
        .await
        .expect("Сохранение версии профиля");
    assert_eq!(
        connections
            .finish_oauth(callback(CALLBACK_HOST, &stale))
            .await,
        Err(c::ConnectionError::OAuthState)
    );
}
