use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;

use super::HttpState;

pub(super) async fn check(
    State(state): State<HttpState>,
    mut request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    let host = header_text(headers, header::HOST).unwrap_or_default();
    if !state.origins.host_allowed(host) {
        return reject(
            StatusCode::FORBIDDEN,
            "forbidden_host",
            "LiveNote доступен только по локальному адресу",
        );
    }
    let origin = header_text(headers, header::ORIGIN);
    if headers.contains_key(header::ORIGIN)
        && !origin.is_some_and(|origin| state.origins.origin_allowed(origin))
    {
        return reject(
            StatusCode::FORBIDDEN,
            "forbidden_origin",
            "Недопустимый Origin",
        );
    }
    let path = request.uri().path().trim_end_matches('/');
    let is_picker = path == "/api/vaults/open";
    let needs_auth = (path == "/mcp" && *request.method() == axum::http::Method::POST)
        || path == "/events"
        || (path.starts_with("/api/") && path != "/api/config");
    if needs_auth && let Some(token) = &state.token {
        let bearer = header_text(headers, header::AUTHORIZATION)
            .and_then(|value| value.strip_prefix("Bearer "));
        let query_token = (path != "/mcp" && !is_picker)
            .then(|| request.uri().query())
            .flatten()
            .and_then(query_token);
        if bearer != Some(token.as_ref()) && query_token.as_deref() != Some(token.as_ref()) {
            return reject(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Требуется корректный bearer-токен",
            );
        }
    }
    if is_picker {
        let site = headers.get("sec-fetch-site");
        let trusted_origin = origin.is_none_or(|origin| {
            origin
                .strip_prefix("http://")
                .is_some_and(|authority| authority.eq_ignore_ascii_case(host))
                || site.is_some_and(|value| value == "same-origin")
        });
        let trusted_site = site.is_none_or(|value| value == "same-origin" || value == "none");
        if !trusted_origin || !trusted_site {
            return reject(
                StatusCode::FORBIDDEN,
                "forbidden_origin",
                "Диалог доступен только из интерфейса LiveNote",
            );
        }
    }
    let drawio = path == "/drawio" || path.starts_with("/drawio/");
    // Служебный токен не должен попадать в обработчики методов и журналы.
    request.headers_mut().remove(header::AUTHORIZATION);
    let mut response = next.run(request).await;
    if drawio {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(concat!(
                "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; ",
                "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ",
                "font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; ",
                "worker-src 'self' blob:; object-src 'none'; base-uri 'self'"
            )),
        );
    }
    response
}

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn query_token(query: &str) -> Option<String> {
    let mut tokens =
        url::form_urlencoded::parse(query.as_bytes()).filter(|(key, _)| key == "token");
    let (_, token) = tokens.next()?;
    tokens.next().is_none().then(|| token.into_owned())
}

pub(super) fn reject(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> Response {
    let body = json!({ "error": { "code": code, "message": message.into() } });
    (status, Json(body)).into_response()
}

pub(super) struct LocalOrigins {
    hosts: [String; 3],
}

impl LocalOrigins {
    pub(super) fn new(port: u16) -> Self {
        Self {
            hosts: [
                format!("127.0.0.1:{port}"),
                format!("localhost:{port}"),
                format!("[::1]:{port}"),
            ],
        }
    }

    fn host_allowed(&self, host: &str) -> bool {
        self.hosts
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(host))
    }

    fn origin_allowed(&self, origin: &str) -> bool {
        let Some(authority) = origin.strip_prefix("http://") else {
            return false;
        };
        self.hosts[..2]
            .iter()
            .any(|host| host.eq_ignore_ascii_case(authority))
            || cfg!(debug_assertions)
                && (authority.eq_ignore_ascii_case("localhost:5173")
                    || authority.eq_ignore_ascii_case("127.0.0.1:5173"))
    }
}
