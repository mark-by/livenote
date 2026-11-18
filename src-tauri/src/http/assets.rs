use std::path::Path;

use axum::{
    Router,
    extract::OriginalUri,
    http::StatusCode,
    response::Response,
    routing::{any, get},
};
use tower_http::services::{ServeDir, ServeFile};

use super::{HttpState, security::reject};

pub(super) fn routes(router: Router<HttpState>, web_root: &Path) -> Router<HttpState> {
    let app = ServeDir::new(web_root).fallback(ServeFile::new(web_root.join("index.html")));
    let drawio = ServeDir::new(web_root.join("drawio")).not_found_service(any(not_found));
    router
        .route("/api", any(not_found))
        .route("/api/{*rest}", any(not_found))
        .route("/events/{*rest}", any(not_found))
        .route("/mcp/{*rest}", any(not_found))
        .route("/diagram-worker.html", get(not_found))
        .nest_service("/drawio", drawio)
        .fallback_service(app)
}

async fn not_found(OriginalUri(uri): OriginalUri) -> Response {
    reject(
        StatusCode::NOT_FOUND,
        "not_found",
        format!("Ресурс «{}» не найден", uri.path()),
    )
}
