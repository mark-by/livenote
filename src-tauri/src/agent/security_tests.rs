use super::*;

#[tokio::test]
async fn agent_http_requires_explicit_local_authorization() {
    // Arrange: HTTP-сервер требует bearer-токен и заголовок агента.
    let app = Desktop::new().await;
    let url = format!("{}{}/sessions", app.server.origin, app.base());
    let get = || app.client.get(&url);
    let scoped = || get().header("x-livenote-agent", "1");

    // Act / Assert: сервер отклоняет запросы без заголовка, с токеном в URL и с чужим адресом.
    json_response(get().bearer_auth(API_TOKEN), StatusCode::FORBIDDEN).await;
    json_response(scoped(), StatusCode::UNAUTHORIZED).await;
    let query_token = app
        .client
        .get(format!("{url}?token={API_TOKEN}"))
        .header("x-livenote-agent", "1");
    json_response(query_token, StatusCode::BAD_REQUEST).await;
    json_response(
        scoped()
            .bearer_auth(API_TOKEN)
            .header(header::ORIGIN, "http://localhost:5173"),
        StatusCode::FORBIDDEN,
    )
    .await;
    json_response(
        scoped()
            .bearer_auth(API_TOKEN)
            .header(header::HOST, "other.invalid"),
        StatusCode::FORBIDDEN,
    )
    .await;
}

#[tokio::test]
async fn agent_http_requires_an_open_vault_and_strict_json() {
    let app = Desktop::new().await;
    json_response(
        app.request(Method::GET, "/api/vaults/unknown/agent/sessions"),
        StatusCode::NOT_FOUND,
    )
    .await;
    app.json(
        Method::POST,
        "/sessions",
        Some(json!({"id":Uuid::new_v4(),"extra":true})),
        StatusCode::BAD_REQUEST,
    )
    .await;
    json_response(
        app.request(Method::POST, &format!("{}/sessions", app.base()))
            .body("{}"),
        StatusCode::BAD_REQUEST,
    )
    .await;
}

#[tokio::test]
async fn agent_oauth_callback_checks_state_without_requiring_bearer() {
    // Arrange: браузер возвращается с неизвестным state и без заголовков агента.
    let app = Desktop::new().await;
    let request = app.client.get(format!(
        "{}{}?code=fixture-code&state=unknown",
        app.server.origin,
        c::OAUTH_CALLBACK_PATH
    ));

    // Act: браузер выполняет переход.
    let response = request.send().await.expect("Ответ OAuth");

    // Assert: callback проверяет state, а не bearer. Браузер не сохраняет ответ в кэше.
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response.json::<Value>().await.expect("Ошибка callback")["error"]["code"],
        "oauth_state"
    );
}
