use std::path::Path;

use axum::{
    Router,
    extract::{OriginalUri, Request},
    http::{
        HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    middleware::{self, Next},
    response::Response,
    routing::{any, get},
};
use tower_http::services::{ServeDir, ServeFile};

use super::security::reject;

pub(super) fn routes<S: Clone + Send + Sync + 'static>(
    router: Router<S>,
    web_root: &Path,
) -> Router<S> {
    let app = ServeDir::new(web_root).fallback(ServeFile::new(web_root.join("index.html")));
    let app = Router::new()
        .fallback_service(app)
        .layer(middleware::from_fn(no_store_html));
    let drawio = ServeDir::new(web_root.join("drawio")).not_found_service(any(not_found));
    router
        .route("/api", any(not_found))
        .route("/api/{*rest}", any(not_found))
        .route("/events/{*rest}", any(not_found))
        .route("/mcp/{*rest}", any(not_found))
        .route("/diagram-worker.html", get(not_found))
        .nest_service("/drawio", drawio)
        .merge(app)
}

async fn no_store_html(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if headers
        .get(CONTENT_TYPE)
        .is_some_and(|value| value.as_bytes() == b"text/html")
    {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

async fn not_found(OriginalUri(uri): OriginalUri) -> Response {
    reject(
        StatusCode::NOT_FOUND,
        "not_found",
        format!("Ресурс «{}» не найден", uri.path()),
    )
}

#[cfg(test)]
mod tests {
    use std::{fs, time::Duration};

    use axum::{
        Router,
        http::{StatusCode, header::CACHE_CONTROL},
    };
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn desktop_html_is_not_stored_in_the_http_cache() -> anyhow::Result<()> {
        let web = tempfile::tempdir()?;
        let html = "<!doctype html><title>LiveNote</title>";
        fs::write(web.path().join("index.html"), html)?;
        fs::write(web.path().join("app-abcd.js"), "export {};")?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let origin = format!("http://{}", listener.local_addr()?);
        let routes = super::routes(Router::new(), web.path());
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()?;
        let requests = async {
            for path in [
                "/",
                "/?vault_id=other",
                "/index.html",
                "/livenote-0.1.2.html",
                "/livenote-0.1.2.html?vault_id=other",
            ] {
                let response = client.get(format!("{origin}{path}")).send().await?;
                assert_eq!(response.status(), StatusCode::OK, "{path}");
                assert_eq!(
                    response.headers().get(CACHE_CONTROL),
                    Some(&axum::http::HeaderValue::from_static("no-store")),
                    "{path}"
                );
                assert_eq!(response.text().await?, html, "{path}");
            }
            let asset = client.get(format!("{origin}/app-abcd.js")).send().await?;
            assert_eq!(asset.status(), StatusCode::OK);
            assert!(!asset.headers().contains_key(CACHE_CONTROL));
            Ok(())
        };
        tokio::select! {
            result = requests => result,
            _ = axum::serve(listener, routes) => anyhow::bail!("Тестовый HTTP-сервер завершился до окончания запросов"),
        }
    }
}
