use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use livenote_vault_service::Service;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    agent::{
        AgentRuntime,
        types::{Conversation, Error, Result, SessionId, Submit, Summary, Turn, TurnId},
    },
    agent_bindings as b, agent_connections as c,
};

use super::HttpState;

#[derive(Clone)]
struct StateData {
    service: Arc<Service>,
    runtime: AgentRuntime,
}

pub(super) fn routes<S: Clone + Send + Sync + 'static>(
    service: Arc<Service>,
    runtime: AgentRuntime,
) -> Router<S> {
    let scoped = Router::new()
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/{session}", get(get_session))
        .route("/sessions/{session}/turns", post(submit))
        .route("/sessions/{session}/turns/{turn}", get(get_turn))
        .route("/binding", get(get_binding).put(set_binding))
        .route("/connections", get(connections))
        .route("/connections/{slot}", put(set_connection))
        .route("/connections/{slot}/oauth", post(oauth));
    Router::new()
        .nest("/api/vaults/{vault_id}/agent", scoped)
        .route(c::OAUTH_CALLBACK_PATH, get(callback).head(callback_head))
        .with_state(StateData { service, runtime })
}

type PathArg<T> = std::result::Result<Path<T>, PathRejection>;
type QueryArg<T> = std::result::Result<Query<T>, QueryRejection>;
type JsonArg = std::result::Result<Json<Value>, JsonRejection>;

fn path<T>(arg: PathArg<T>) -> Result<T> {
    arg.map(|Path(value)| value)
        .map_err(|_| Error::invalid("Некорректный идентификатор в URL"))
}

fn query<T>(arg: QueryArg<T>) -> Result<T> {
    arg.map(|Query(value)| value)
        .map_err(|_| Error::invalid("Некорректные параметры URL"))
}

fn body<T: DeserializeOwned>(arg: JsonArg) -> Result<T> {
    let Json(value) = arg.map_err(|error| {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Error::invalid("Превышен лимит размера запроса")
        } else {
            Error::invalid("Некорректное тело запроса JSON")
        }
    })?;
    if !value.is_object() {
        return Err(Error::invalid("Требуется JSON-объект"));
    }
    serde_json::from_value(value).map_err(|_| Error::invalid("Некорректное тело запроса JSON"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateSession {
    id: SessionId,
}

async fn list_sessions(
    State(state): State<StateData>,
    arg: PathArg<String>,
) -> Result<Json<Vec<Summary>>> {
    let vault = state.service.agent_vault(&path(arg)?)?;
    Ok(Json(state.runtime.sessions(&vault).await?))
}

async fn create_session(
    State(state): State<StateData>,
    arg: PathArg<String>,
    input: JsonArg,
) -> Result<Json<Summary>> {
    let vault = state.service.agent_vault(&path(arg)?)?;
    let input: CreateSession = body(input)?;
    Ok(Json(state.runtime.create_session(&vault, input.id).await?))
}

async fn get_session(
    State(state): State<StateData>,
    arg: PathArg<(String, SessionId)>,
) -> Result<Json<Conversation>> {
    let (vault, session) = path(arg)?;
    let vault = state.service.agent_vault(&vault)?;
    Ok(Json(state.runtime.session(&vault, session).await?))
}

async fn submit(
    State(state): State<StateData>,
    arg: PathArg<(String, SessionId)>,
    input: JsonArg,
) -> Result<(StatusCode, Json<Turn>)> {
    let (vault, session) = path(arg)?;
    let vault = state.service.agent_vault(&vault)?;
    let input = Submit::try_from(body::<Value>(input)?)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(state.runtime.submit(vault, session, input).await?),
    ))
}

async fn get_turn(
    State(state): State<StateData>,
    arg: PathArg<(String, SessionId, TurnId)>,
) -> Result<Json<Turn>> {
    let (vault, session, turn) = path(arg)?;
    let vault = state.service.agent_vault(&vault)?;
    Ok(Json(state.runtime.get_turn(&vault, session, turn).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Folder {
    folder: String,
}

async fn get_binding(
    State(state): State<StateData>,
    arg: PathArg<String>,
    folder: QueryArg<Folder>,
) -> Result<Json<b::BindingView>> {
    let vault = state.service.agent_vault(&path(arg)?)?;
    Ok(Json(
        state.runtime.binding(vault, query(folder)?.folder).await?,
    ))
}

async fn set_binding(
    State(state): State<StateData>,
    arg: PathArg<String>,
    input: JsonArg,
) -> Result<Json<b::BindingView>> {
    let vault = state.service.agent_vault(&path(arg)?)?;
    Ok(Json(state.runtime.set_binding(vault, body(input)?).await?))
}

pub(super) async fn pick(
    State(state): State<HttpState>,
    arg: PathArg<String>,
    input: JsonArg,
) -> Result<Response> {
    state.service.agent_vault(&path(arg)?)?;
    body::<Empty>(input)?;
    Ok(
        match super::pick_folder(&state, "Выберите локальную папку с исходным кодом").await
        {
            Ok(path) => {
                let path = path
                    .map(|path| path.into_os_string().into_string())
                    .transpose()
                    .map_err(|_| Error::invalid("Путь к папке должен быть в UTF-8"))?;
                Json(json!({"localDir":path})).into_response()
            }
            Err(response) if response.status() == StatusCode::CONFLICT => {
                return Err(Error::new(
                    StatusCode::CONFLICT,
                    "busy",
                    "Диалог выбора каталога уже открыт",
                ));
            }
            Err(response) => response,
        },
    )
}

fn connection_vault(service: &Service, id: &str) -> Result<c::VaultId> {
    let vault = service.agent_vault(id)?;
    Ok(c::VaultId::new(vault.id())?)
}

async fn connections(
    State(state): State<StateData>,
    arg: PathArg<String>,
) -> Result<Json<Vec<c::Connection>>> {
    let vault = connection_vault(&state.service, &path(arg)?)?;
    Ok(Json(state.runtime.connections().list(&vault).await?))
}

async fn set_connection(
    State(state): State<StateData>,
    arg: PathArg<(String, c::Slot)>,
    input: JsonArg,
) -> Result<Json<c::Connection>> {
    let (vault, slot) = path(arg)?;
    let vault = connection_vault(&state.service, &vault)?;
    Ok(Json(
        state
            .runtime
            .connections()
            .put(&vault, slot, body(input)?)
            .await?,
    ))
}

async fn oauth(
    State(state): State<StateData>,
    arg: PathArg<(String, c::Slot)>,
    input: JsonArg,
) -> Result<(StatusCode, Json<Value>)> {
    let (vault, slot) = path(arg)?;
    let vault = connection_vault(&state.service, &vault)?;
    body::<Empty>(input)?;
    let url = state
        .runtime
        .connections()
        .begin_oauth(&vault, slot)
        .await?;
    open::that_detached(url.as_str()).map_err(|_| {
        Error::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "browser_unavailable",
            "Не удалось открыть системный браузер",
        )
    })?;
    Ok((StatusCode::ACCEPTED, Json(json!({}))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Callback {
    code: String,
    state: String,
}

async fn callback_head() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

async fn callback(
    State(state): State<StateData>,
    headers: HeaderMap,
    args: QueryArg<Callback>,
) -> Response {
    let result = async {
        let args = query(args)?;
        let host = headers
            .get(header::HOST)
            .and_then(|host| host.to_str().ok())
            .unwrap_or_default();
        state
            .runtime
            .connections()
            .finish_oauth(c::OAuthCallback {
                host,
                code: &args.code,
                state: &args.state,
            })
            .await?;
        Ok::<_, Error>(())
    }
    .await;
    let response = match result {
        Ok(()) => "Вход завершён. Закройте эту вкладку и вернитесь в LiveNote.".into_response(),
        Err(error) => error.into_response(),
    };
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        response,
    )
        .into_response()
}
