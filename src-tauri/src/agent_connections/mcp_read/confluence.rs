use serde::Deserialize;
use serde_json::json;
use url::Url;

use super::{Cite, ConnectionError, Location, Result, Session};
use crate::agent_connections::transport;

#[derive(Deserialize)]
struct PageHit {
    id: String,
    title: String,
    url: String,
    #[serde(default)]
    excerpt: Option<String>,
    content: Option<PageContent>,
}

#[derive(Deserialize)]
struct Page {
    content: PageContent,
}

#[derive(Deserialize)]
struct PageContent {
    value: String,
}

pub(super) async fn search(
    session: &mut Session,
    site: &Url,
    text: &str,
    limit: usize,
) -> Result<Vec<(Location, Cite, String)>> {
    let text = text.replace('\\', "\\\\").replace('"', "\\\"");
    let query = format!("type = page AND text ~ \"{text}\"");
    let pages: Vec<PageHit> = session
        .call("confluence_search", json!({"query":query,"limit":limit}))
        .await?
        .decode()?;
    Ok(pages
        .into_iter()
        .filter_map(|page| {
            if page.id.is_empty() || !page.id.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let url = site.join(&page.url).ok()?;
            let url = transport::endpoint(url.as_str()).ok()?;
            if url.origin() != site.origin() {
                return None;
            }
            let excerpt = page
                .excerpt
                .or_else(|| page.content.map(|content| content.value))
                .unwrap_or_else(|| page.title.clone())
                .chars()
                .take(800)
                .collect();
            let cite = Cite::Confluence {
                url: url.to_string(),
                title: page.title,
            };
            Some((Location::Page(page.id), cite, excerpt))
        })
        .take(limit)
        .collect())
}

pub(super) async fn read(session: &mut Session, id: &str) -> Result<String> {
    let page: Page = session
        .call(
            "confluence_get_page",
            json!({
                "page_id": id, "include_metadata": false, "convert_to_markdown": true
            }),
        )
        .await?
        .decode()
        .map_err(|_| ConnectionError::Unsupported)?;
    Ok(page.content.value)
}
