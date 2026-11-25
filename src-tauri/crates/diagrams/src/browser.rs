mod capture;

use std::path::Path;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::process::Child;

use crate::assets::{Assets, ENTRY, ORIGIN};
use crate::cdp::Cdp;
use crate::{DiagramError, launch};

pub use capture::Clip;

pub struct Browser {
    cdp: Cdp,
    cdp_usable: bool,
    _child: Child,
    _profile: TempDir,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserContext {
    browser_context_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    target_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Navigation {
    loader_id: Option<String>,
    error_text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evaluation<T> {
    result: T,
    exception_details: Option<Exception>,
}

#[derive(Deserialize)]
struct Exception {
    text: String,
    exception: Option<ExceptionObject>,
}

#[derive(Deserialize)]
struct ExceptionObject {
    description: Option<String>,
}

impl<T> Evaluation<T> {
    fn result(self) -> Result<T, DiagramError> {
        if let Some(exception) = self.exception_details {
            let reason = exception
                .exception
                .and_then(|value| value.description)
                .unwrap_or(exception.text);
            return Err(DiagramError::Worker(reason));
        }
        Ok(self.result)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerFunction {
    object_id: Option<String>,
}

#[derive(Deserialize)]
struct Returned {
    value: Option<Value>,
}

pub struct Page {
    context: BrowserContext,
    session_id: String,
    function_id: String,
}

impl Browser {
    pub(crate) async fn launch(chromium: &Path, web_root: &Path) -> Result<Self, DiagramError> {
        let assets = Assets::open(web_root).await?;
        let chromium = tokio::fs::canonicalize(chromium).await?;
        let launch::Launched {
            input,
            output,
            child,
            profile,
        } = launch::launch(&chromium)?;
        Ok(Self {
            cdp: Cdp::new(output, input, assets),
            cdp_usable: true,
            _child: child,
            _profile: profile,
        })
    }

    pub(crate) async fn page(&mut self) -> Result<Page, DiagramError> {
        let context: BrowserContext = self
            .cdp
            .call(
                None,
                "Target.createBrowserContext",
                json!({
                    "disposeOnDetach": true
                }),
            )
            .await?;
        let target: Target = self
            .cdp
            .call(
                None,
                "Target.createTarget",
                json!({
                    "url": "about:blank", "browserContextId": context.browser_context_id
                }),
            )
            .await?;
        let attachment: Attachment = self
            .cdp
            .call(
                None,
                "Target.attachToTarget",
                json!({
                    "targetId": target.target_id, "flatten": true
                }),
            )
            .await?;
        let session_id = attachment.session_id;
        let session = Some(session_id.as_str());
        self.cdp
            .call::<Value>(session, "Fetch.enable", json!({}))
            .await?;
        self.cdp
            .call::<Value>(session, "Page.enable", json!({}))
            .await?;
        self.cdp
            .call::<Value>(
                session,
                "Page.setLifecycleEventsEnabled",
                json!({"enabled": true}),
            )
            .await?;
        self.cdp
            .call::<Value>(
                session,
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": 1024, "height": 768, "deviceScaleFactor": 1, "mobile": false
                }),
            )
            .await?;
        let navigation: Navigation = self
            .cdp
            .call(
                session,
                "Page.navigate",
                json!({
                    "url": format!("{ORIGIN}{ENTRY}")
                }),
            )
            .await?;
        if let Some(error) = navigation.error_text {
            return Err(DiagramError::Worker(error));
        }
        let loader_id = navigation
            .loader_id
            .ok_or_else(|| DiagramError::Worker("нет документа".into()))?;
        self.cdp.wait_for_load(&loader_id).await?;

        let evaluation: Evaluation<WorkerFunction> = self
            .cdp
            .call(
                session,
                "Runtime.evaluate",
                json!({
                    "expression": "globalThis.livenoteDiagramWorker"
                }),
            )
            .await?;
        let function_id = evaluation
            .result()?
            .object_id
            .ok_or_else(|| DiagramError::Worker("модуль не запустился".into()))?;
        Ok(Page {
            context,
            session_id,
            function_id,
        })
    }

    pub(crate) async fn run<T: DeserializeOwned>(
        &mut self,
        page: &Page,
        request: &(impl Serialize + Sync),
    ) -> Result<T, DiagramError> {
        let evaluation: Evaluation<Returned> = self
            .cdp
            .call(
                Some(&page.session_id),
                "Runtime.callFunctionOn",
                json!({
                    "objectId": page.function_id,
                    "functionDeclaration": "function (request) { return this(request); }",
                    "arguments": [{ "value": request }],
                    "awaitPromise": true,
                    "returnByValue": true
                }),
            )
            .await?;
        let value = evaluation
            .result()?
            .value
            .ok_or_else(|| DiagramError::Worker("нет результата".into()))?;
        Ok(serde_json::from_value(value)?)
    }

    pub(crate) async fn close(&mut self, page: Page) -> Result<(), DiagramError> {
        if !self.cdp_usable {
            return Err(DiagramError::Timeout);
        }
        self.cdp
            .call::<Value>(
                None,
                "Target.disposeBrowserContext",
                json!({
                    "browserContextId": page.context.browser_context_id
                }),
            )
            .await?;
        Ok(())
    }
}
