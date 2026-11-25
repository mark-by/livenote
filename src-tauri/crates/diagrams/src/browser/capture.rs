use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::timeout;

use super::{Browser, Page};
use crate::DiagramError;

const PNG_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PNG_EDGE: f64 = 8192.0;
const MAX_PNG_PIXELS: f64 = 16_000_000.0;

#[derive(Deserialize, Serialize)]
pub struct Clip {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

#[derive(Deserialize)]
struct Screenshot {
    data: String,
}

impl Browser {
    pub(crate) async fn screenshot(
        &mut self,
        page: &Page,
        clip: Clip,
    ) -> Result<Option<String>, DiagramError> {
        if !(0.0 < clip.width
            && clip.width <= MAX_PNG_EDGE
            && 0.0 < clip.height
            && clip.height <= MAX_PNG_EDGE
            && clip.width * clip.height <= MAX_PNG_PIXELS)
        {
            return Ok(None);
        }
        let session = Some(page.session_id.as_str());
        let capture = timeout(PNG_TIMEOUT, async {
            self.cdp
                .call::<Value>(
                    session,
                    "Emulation.setDefaultBackgroundColorOverride",
                    json!({
                        "color": { "r": 0, "g": 0, "b": 0, "a": 0 }
                    }),
                )
                .await?;
            let screenshot: Screenshot = self
                .cdp
                .call(
                    session,
                    "Page.captureScreenshot",
                    json!({
                        "format": "png", "clip": clip, "captureBeyondViewport": true
                    }),
                )
                .await?;
            Ok(Some(screenshot.data))
        })
        .await;
        match capture {
            Ok(result) => result,
            Err(_) => {
                // Таймаут мог оборвать кадр CDP. Канал больше нельзя использовать.
                self.cdp_usable = false;
                Err(DiagramError::Timeout)
            }
        }
    }
}
