use std::{
    collections::HashSet,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use rig::{
    OneOrMany,
    agent::AgentBuilder,
    completion::{
        AssistantContent, CompletionError, CompletionModel, CompletionRequest, CompletionResponse,
        Message, Prompt, PromptError, ToolDefinition,
    },
    streaming::StreamingCompletionResponse,
    tool::{ToolDyn, ToolError},
    wasm_compat::WasmBoxedFuture,
};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

use crate::agent_connections::ModelClient;

use super::{
    context::{Window, stop},
    model_loop::Loop,
    model_protocol::{finish_reason, invalid_final, model_error},
    progress::Event,
    tools,
    types::{Error, Result},
};

type Response = <ModelClient as CompletionModel>::Response;
type Stream = <ModelClient as CompletionModel>::StreamingResponse;

#[derive(Default)]
pub(super) struct RunState {
    seen: Mutex<HashSet<String>>,
    staged: AtomicBool,
}

impl RunState {
    pub async fn prompt(
        &self,
        model: &ModelClient,
        window: &Window<'_>,
        state: &mut Loop<'_>,
        request: NativePrompt<'_>,
    ) -> Result<String> {
        let (tx, mut rx) = mpsc::channel(1);
        let tools: Vec<Box<dyn ToolDyn>> = tools::definitions()
            .into_iter()
            .map(|definition| {
                let tool = LiveNoteTool {
                    definition,
                    tx: tx.clone(),
                };
                Box::new(tool) as Box<dyn ToolDyn>
            })
            .collect();
        let agent = AgentBuilder::new(WindowModel {
            model,
            window,
            state: self,
        })
        .preamble(request.instructions)
        .additional_params(json!({"stream":false,"parallel_tool_calls":false}))
        .tools(tools)
        .build();
        // Rig вызывает адаптер в отдельной задаче. Доступ к источникам и черновику
        // остаётся в запросе LiveNote и прекращается вместе с ним.
        // Каждый шаг с инструментом добавляет больше одного токена в историю.
        // Бюджет LiveNote остановит запрос раньше формального предела Rig.
        let run = agent
            .prompt(request.message)
            .max_turns(window.limit.get())
            .with_history(request.history);
        let serve = async {
            while let Some(Invocation {
                name,
                args,
                response,
            }) = rx.recv().await
            {
                let result = state.execute(&name, &args).await?;
                self.staged
                    .store(state.docs.has_staged_changes(), Ordering::Relaxed);
                response.send(result).map_err(|_| Error::model_reply())?;
            }
            Err(Error::model_reply())
        };
        tokio::select! {
            result = run => result.map_err(|error| match error {
                PromptError::CompletionError(CompletionError::RequestError(error)) => {
                    error.downcast::<Rejected>().map_or_else(
                        |error| model_error(CompletionError::RequestError(error)),
                        |rejected| rejected.0,
                    )
                }
                PromptError::CompletionError(error) => model_error(error),
                PromptError::MaxTurnsError { .. } => stop(
                    "agent_turn_limit",
                    "Агент достиг лимита шагов.".into(),
                    self.staged.load(Ordering::Relaxed),
                ),
                _ => Error::model_reply(),
            }),
            result = serve => result,
        }
    }
}

pub(super) struct NativePrompt<'a> {
    pub instructions: &'a str,
    pub message: Message,
    pub history: &'a mut Vec<Message>,
}

#[derive(Debug, thiserror::Error)]
#[error("LiveNote rejected the model step")]
struct Rejected(Error);

fn reject(error: Error) -> CompletionError {
    CompletionError::RequestError(Box::new(Rejected(error)))
}

#[derive(Clone)]
struct WindowModel<'a> {
    model: &'a ModelClient,
    window: &'a Window<'a>,
    state: &'a RunState,
}

impl CompletionModel for WindowModel<'_> {
    type Response = Response;
    type StreamingResponse = Stream;
    type Client = Self;

    fn make(client: &Self::Client, _: impl Into<String>) -> Self {
        client.clone()
    }

    async fn completion(
        &self,
        mut request: CompletionRequest,
    ) -> std::result::Result<CompletionResponse<Response>, CompletionError> {
        self.window
            .prepare(
                Event::Model,
                &mut request,
                self.state.staged.load(Ordering::Relaxed),
            )
            .map_err(reject)?;
        let names: HashSet<_> = request.tools.iter().map(|tool| tool.name.clone()).collect();
        let mut response = self.model.completion(request).await?;
        self.normalize_step(&mut response, &names).map_err(reject)?;
        Ok(response)
    }

    async fn stream(
        &self,
        _: CompletionRequest,
    ) -> std::result::Result<StreamingCompletionResponse<Stream>, CompletionError> {
        Err(reject(Error::model_reply()))
    }
}

impl WindowModel<'_> {
    fn normalize_step(
        &self,
        response: &mut CompletionResponse<Response>,
        names: &HashSet<String>,
    ) -> Result<()> {
        let reason = finish_reason(&response.raw_response).ok_or_else(Error::model_reply)?;
        let mut calls = response.choice.iter().filter_map(|item| match item {
            AssistantContent::ToolCall(call) => Some(call),
            _ => None,
        });
        let Some(call) = calls.next() else {
            return if reason == "stop" {
                Ok(())
            } else {
                Err(invalid_final())
            };
        };
        if calls.next().is_some()
            || reason != "tool_calls"
            || call.id.is_empty()
            || call.id.len() > 128
            || call.id.chars().any(char::is_control)
            || !names.contains(&call.function.name)
            || !self
                .state
                .seen
                .lock()
                .map_err(|_| Error::storage())?
                .insert(call.id.clone())
        {
            return Err(Error::model_reply());
        }
        // Rig передаёт шаг следующему запросу. Чат не показывает текст шага с инструментом.
        response.choice = OneOrMany::one(AssistantContent::ToolCall(call.clone()));
        Ok(())
    }
}

struct Invocation {
    name: String,
    args: String,
    response: oneshot::Sender<String>,
}

struct LiveNoteTool {
    definition: ToolDefinition,
    tx: mpsc::Sender<Invocation>,
}

impl ToolDyn for LiveNoteTool {
    fn name(&self) -> String {
        self.definition.name.clone()
    }

    fn definition(&self, _: String) -> WasmBoxedFuture<'_, ToolDefinition> {
        Box::pin(async { self.definition.clone() })
    }

    fn call(&self, args: String) -> WasmBoxedFuture<'_, std::result::Result<String, ToolError>> {
        Box::pin(async move {
            let (response, result) = oneshot::channel();
            self.tx
                .send(Invocation {
                    name: self.name(),
                    args,
                    response,
                })
                .await
                .map_err(|_| ToolError::ToolCallError(Box::new(Rejected(Error::model_reply()))))?;
            result
                .await
                .map_err(|error| ToolError::ToolCallError(Box::new(error)))
        })
    }
}
