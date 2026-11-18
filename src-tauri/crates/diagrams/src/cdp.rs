use std::collections::HashSet;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

use crate::DiagramError;
use crate::assets::Assets;

const MAX_FRAME_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Command<'a> {
    id: u64,
    method: &'a str,
    params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Incoming {
    Reply {
        id: u64,
        #[serde(default)]
        result: Value,
        error: Option<ProtocolError>,
    },
    Event(Event),
}

#[derive(Deserialize)]
struct ProtocolError {
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    method: String,
    session_id: Option<String>,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleEvent {
    loader_id: String,
    name: String,
}

pub struct Cdp {
    reader: BufReader<ChildStdout>,
    writer: ChildStdin,
    assets: Assets,
    next_id: u64,
    loaded: HashSet<String>,
    interceptions: HashSet<u64>,
}

impl Cdp {
    pub(crate) fn new(reader: ChildStdout, writer: ChildStdin, assets: Assets) -> Self {
        Self {
            reader: BufReader::new(reader),
            writer,
            assets,
            next_id: 0,
            loaded: HashSet::new(),
            interceptions: HashSet::new(),
        }
    }

    pub(crate) async fn call<T: DeserializeOwned>(
        &mut self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<T, DiagramError> {
        let expected = self.send(session_id, method, params).await?;
        loop {
            if let Some((id, result)) = self.receive().await?
                && id == expected
            {
                return Ok(serde_json::from_value(result)?);
            }
        }
    }

    pub(crate) async fn wait_for_load(&mut self, loader_id: &str) -> Result<(), DiagramError> {
        while !self.loaded.remove(loader_id) {
            drop(self.receive().await?);
        }
        self.loaded.clear();
        Ok(())
    }

    async fn send(
        &mut self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<u64, DiagramError> {
        let id = self
            .next_id
            .checked_add(1)
            .ok_or(DiagramError::InvalidFrame)?;
        self.next_id = id;
        let mut frame = serde_json::to_vec(&Command {
            id,
            method,
            params,
            session_id,
        })?;
        frame.push(0);
        self.writer.write_all(&frame).await?;
        Ok(id)
    }

    async fn receive(&mut self) -> Result<Option<(u64, Value)>, DiagramError> {
        let mut frame = Vec::new();
        if (&mut self.reader)
            .take(MAX_FRAME_BYTES)
            .read_until(0, &mut frame)
            .await?
            == 0
        {
            return Err(DiagramError::Disconnected);
        }
        if frame.pop() != Some(0) {
            return Err(DiagramError::InvalidFrame);
        }
        match serde_json::from_slice(&frame)? {
            Incoming::Reply { id, result, error } => {
                let intercepted = self.interceptions.remove(&id);
                if let Some(error) = error {
                    // Chromium отзывает перехват, если фрейм уже отменил запрос.
                    if intercepted && error.message == "Invalid InterceptionId." {
                        return Ok(None);
                    }
                    return Err(DiagramError::Protocol(error.message));
                }
                Ok(Some((id, result)))
            }
            Incoming::Event(event) => {
                match event.method.as_str() {
                    "Fetch.requestPaused" => {
                        let (method, params) = self
                            .assets
                            .reply(serde_json::from_value(event.params)?)
                            .await;
                        let id = self
                            .send(event.session_id.as_deref(), method, params)
                            .await?;
                        self.interceptions.insert(id);
                    }
                    "Page.lifecycleEvent" => {
                        let lifecycle: LifecycleEvent = serde_json::from_value(event.params)?;
                        if lifecycle.name == "load" {
                            self.loaded.insert(lifecycle.loader_id);
                        }
                    }
                    _ => {}
                }
                Ok(None)
            }
        }
    }
}
