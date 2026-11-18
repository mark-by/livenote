use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::fs;
use url::Url;

pub const ORIGIN: &str = "https://diagram-worker.invalid";
pub const ENTRY: &str = "/diagram-worker.html";

const CSP: &str = concat!(
    "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; ",
    "frame-ancestors 'self'; worker-src 'none'; ",
    "img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; "
);
const WORKER_CSP: &str = "script-src https://diagram-worker.invalid/assets/; frame-src https://diagram-worker.invalid/drawio/";
const DRAWIO_CSP: &str = concat!(
    "script-src https://diagram-worker.invalid/drawio/ 'unsafe-eval'; ",
    "connect-src https://diagram-worker.invalid/drawio/; frame-src 'none'"
);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PausedRequest {
    request_id: String,
    request: Request,
}

#[derive(Deserialize)]
struct Request {
    method: String,
    url: String,
}

pub struct Assets {
    root: PathBuf,
}

impl Assets {
    pub(crate) async fn open(root: &Path) -> std::io::Result<Self> {
        let root = fs::canonicalize(root).await?;
        for file in ["diagram-worker.html", "drawio/index.html"] {
            if !fs::metadata(root.join(file)).await?.is_file() {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, file));
            }
        }
        Ok(Self { root })
    }

    pub(crate) async fn reply(&self, event: PausedRequest) -> (&'static str, Value) {
        let PausedRequest {
            request_id,
            request,
        } = event;
        let content = if request.method == "GET" {
            self.asset(&request.url).await
        } else {
            None
        };
        let Some((body, mime, csp)) = content else {
            return (
                "Fetch.failRequest",
                json!({"requestId": request_id, "errorReason": "BlockedByClient"}),
            );
        };
        (
            "Fetch.fulfillRequest",
            json!({
                "requestId": request_id,
                "responseCode": 200,
                "responseHeaders": [
                    {"name": "Content-Type", "value": mime},
                    {"name": "Content-Security-Policy", "value": csp},
                    {"name": "X-Content-Type-Options", "value": "nosniff"}
                ],
                "body": STANDARD.encode(body)
            }),
        )
    }

    async fn asset(&self, address: &str) -> Option<(Vec<u8>, &'static str, String)> {
        let url = Url::parse(address).ok()?;
        if url.origin().ascii_serialization() != ORIGIN {
            return None;
        }
        let relative = url.path().strip_prefix('/')?;
        let path = Path::new(relative);
        if !(url.path() == ENTRY
            || relative.starts_with("assets/")
            || relative.starts_with("drawio/"))
            || !relative
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-/.".contains(&byte))
            || !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return None;
        }
        let file = fs::canonicalize(self.root.join(path)).await.ok()?;
        if !file.starts_with(&self.root) || !fs::metadata(&file).await.ok()?.is_file() {
            return None;
        }
        let body = fs::read(file).await.ok()?;
        let mime = mime_guess::from_path(path)
            .first_raw()
            .unwrap_or("application/octet-stream");
        let policy = if relative.starts_with("drawio/") {
            DRAWIO_CSP
        } else {
            WORKER_CSP
        };
        Some((body, mime, format!("{CSP}{policy}")))
    }
}
