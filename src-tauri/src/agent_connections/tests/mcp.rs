use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};
use url::Url;

use super::{TOKEN, fixture, state};
use crate::agent_connections as c;

const SHA: &str = "c9839f884fc1177080913b7df1b6ab7c79b3df07";
const FOREIGN_SHA: &str = "d9839f884fc1177080913b7df1b6ab7c79b3df07";
const PATH: &str = "lib/main.rs";
const DEEP_PATH: &str = "lib/deep.rs";

fn tool(name: &str, fields: &[(&str, &str)]) -> Value {
    let properties = fields
        .iter()
        .map(|(key, kind)| ((*key).into(), json!({"type":kind})))
        .collect::<serde_json::Map<String, Value>>();
    json!({"name":name,"inputSchema":{"type":"object","properties":properties}})
}

fn list(provider: c::Provider, indexed: bool) -> Vec<Value> {
    let mut tools = match provider {
        c::Provider::Confluence => vec![
            tool(
                "confluence_search",
                &[("query", "string"), ("limit", "integer")],
            ),
            tool(
                "confluence_get_page",
                &[
                    ("page_id", "string"),
                    ("include_metadata", "boolean"),
                    ("convert_to_markdown", "boolean"),
                ],
            ),
        ],
        c::Provider::Github => vec![
            tool(
                "get_commit",
                &[
                    ("owner", "string"),
                    ("repo", "string"),
                    ("sha", "string"),
                    ("detail", "string"),
                ],
            ),
            tool(
                "get_file_contents",
                &[
                    ("owner", "string"),
                    ("repo", "string"),
                    ("sha", "string"),
                    ("path", "string"),
                ],
            ),
        ],
        c::Provider::Gitlab => vec![
            tool(
                "get_commit",
                &[("project_id", "string"), ("commit_sha", "string")],
            ),
            tool(
                "list_repository_tree",
                &[
                    ("project_id", "string"),
                    ("ref", "string"),
                    ("recursive", "boolean"),
                ],
            ),
            tool(
                "get_repository_file",
                &[
                    ("project_id", "string"),
                    ("ref", "string"),
                    ("file_path", "string"),
                    ("offset", "integer"),
                    ("limit", "integer"),
                ],
            ),
        ],
    };
    if indexed {
        tools.push(match provider {
            c::Provider::Confluence => tool("unused_search", &[]),
            c::Provider::Github => tool(
                "search_code",
                &[("query", "string"), ("perPage", "integer")],
            ),
            c::Provider::Gitlab => tool(
                "search_project_code",
                &[
                    ("project_id", "string"),
                    ("search", "string"),
                    ("ref", "string"),
                    ("per_page", "integer"),
                ],
            ),
        });
    }
    tools.push(tool("update_file", &[]));
    tools
}

fn reply(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn text(value: Value) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}]})
}

fn conf(args: &Value, name: &Value, site: &str) -> Value {
    match name.as_str() {
        Some("confluence_search") => {
            assert_eq!(args["query"], "type = page AND text ~ \"needle\"");
            text(json!([
                {"id":"10","url":format!("{site}/wiki/spaces/A/pages/10"),"title":"Документ","excerpt":"needle"},
                {"id":"11","url":"https://foreign.invalid/wiki/11","title":"Чужой документ"}
            ]))
        }
        Some("confluence_get_page") => {
            assert_eq!(args["page_id"], "10");
            text(json!({"content":{"value":"Введение\nneedle\nКонец"}}))
        }
        _ => panic!("Недопустимый метод MCP: {name}"),
    }
}

fn github(args: &Value, name: &Value, site: &str) -> Value {
    if name != "search_code" {
        assert_eq!(args["owner"], "team");
        assert_eq!(args["repo"], "project");
    }
    match name.as_str() {
        Some("get_commit") => {
            assert_eq!(args["sha"], "release");
            text(json!({"sha":SHA,"html_url":format!("{site}/team/project/commit/{SHA}")}))
        }
        Some("search_code") => {
            assert_eq!(args["query"], "needle repo:team/project");
            text(json!({"items":[
                {"path":DEEP_PATH,"html_url":format!("{site}/team/project/blob/{SHA}/{DEEP_PATH}"),
                    "repository":{"full_name":"team/project"}},
                {"path":"foreign.rs","html_url":format!("{site}/team/neighbor/blob/{SHA}/foreign.rs"),
                    "repository":{"full_name":"team/neighbor"}}
            ]}))
        }
        Some("get_file_contents") => {
            assert_eq!(args["sha"], SHA);
            match args["path"].as_str() {
                Some("/") => text(json!([
                    {"path":"lib","type":"dir","html_url":format!("{site}/team/project/tree/{SHA}/lib")},
                    {"path":"other.rs","type":"file","html_url":format!("{site}/team/neighbor/blob/{SHA}/other.rs")}
                ])),
                Some("lib") => text(
                    json!([{"path":PATH,"type":"file","html_url":format!("{site}/team/project/blob/{SHA}/{PATH}")}]),
                ),
                Some(PATH) => json!({"content":[{"type":"resource","resource":{
                    "uri":format!("repo://team/project/sha/{SHA}/contents/{PATH}"),
                    "mimeType":"text/plain","text":"start\nneedle\nend"
                }}]}),
                Some(DEEP_PATH) => {
                    let mut lines = vec!["start"; 200];
                    lines.push("needle");
                    json!({"content":[{"type":"resource","resource":{
                        "uri":format!("repo://team/project/sha/{SHA}/contents/{DEEP_PATH}"),
                        "mimeType":"text/plain","text":lines.join("\n")
                    }}]})
                }
                _ => panic!("Прочитан файл за пределами привязки"),
            }
        }
        _ => panic!("Недопустимый метод MCP: {name}"),
    }
}

fn gitlab(args: &Value, name: &Value, site: &str) -> Value {
    assert_eq!(args["project_id"], "team/project");
    let payload = match name.as_str() {
        Some("get_commit") => {
            assert_eq!(args["commit_sha"], "release");
            json!({"sha":SHA,"webUrl":format!("{site}/team/project/-/commit/{SHA}")})
        }
        Some("search_project_code") => {
            assert_eq!(args["search"], "needle");
            assert_eq!(args["ref"], SHA);
            json!([
                {"path":DEEP_PATH,"ref":SHA,"startline":201,"data":"needle"},
                {"path":"foreign.rs","ref":FOREIGN_SHA,"startline":1,"data":"needle"}
            ])
        }
        Some("list_repository_tree") => {
            assert_eq!(args["ref"], SHA);
            json!({"entries":[{"path":PATH,"type":"blob"},{"path":"wrong.rs","type":"blob"}],
                "pageInfo":{"hasNextPage":false}})
        }
        Some("get_repository_file") => {
            assert_eq!(args["ref"], SHA);
            match (args["file_path"].as_str(), args["offset"].as_u64()) {
                (Some(PATH), Some(0)) => {
                    json!({"path":PATH,"ref":SHA,"content":"start\nneedle\nend",
                    "metadata":{"returned_lines":{"start":1,"end":3}}})
                }
                (Some(PATH), Some(1)) => json!({"path":PATH,"ref":SHA,"content":"needle",
                    "metadata":{"returned_lines":{"start":2,"end":2}}}),
                (Some(DEEP_PATH), Some(200)) => {
                    json!({"path":DEEP_PATH,"ref":SHA,"content":"needle",
                    "metadata":{"returned_lines":{"start":201,"end":201}}})
                }
                (Some("wrong.rs"), Some(0)) => {
                    json!({"path":"wrong.rs","ref":FOREIGN_SHA,"content":"needle wrong ref",
                    "metadata":{"returned_lines":{"start":1,"end":1}}})
                }
                _ => panic!("Прочитан файл за пределами привязки"),
            }
        }
        _ => panic!("Недопустимый метод MCP: {name}"),
    };
    json!({"structuredContent": payload})
}

#[derive(Clone, Copy)]
struct Fixture {
    provider: c::Provider,
    indexed: bool,
}

async fn endpoint(
    State(fixture): State<Fixture>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(headers["Authorization"], format!("Bearer {TOKEN}"));
    let id = &body["id"];
    let host = headers["Host"].to_str().expect("Host тестового сервера");
    let site = format!("http://{host}");
    if body["method"] != "initialize" {
        assert_eq!(headers["Mcp-Session-Id"], "fixture-id");
        assert_eq!(headers["MCP-Protocol-Version"], "2025-06-18");
    }
    match body["method"].as_str() {
        Some("initialize") => (
            [("Mcp-Session-Id", "fixture-id")],
            Json(reply(
                id,
                json!({
                    "protocolVersion":"2025-06-18","capabilities":{"tools":{}}
                }),
            )),
        )
            .into_response(),
        Some("notifications/initialized") => StatusCode::ACCEPTED.into_response(),
        Some("tools/list") => Json(reply(
            id,
            json!({"tools": list(fixture.provider, fixture.indexed)}),
        ))
        .into_response(),
        Some("tools/call") => {
            let args = &body["params"]["arguments"];
            let name = &body["params"]["name"];
            let result = match fixture.provider {
                c::Provider::Confluence => conf(args, name, &site),
                c::Provider::Github => github(args, name, &site),
                c::Provider::Gitlab => gitlab(args, name, &site),
            };
            let frame = format!(
                ": ping\r\ndata: {{\"jsonrpc\":\"2.0\",\"id\":\"foreign\",\"method\":\"ping\"}}\r\n\r\ndata: {}\r\n\r\n",
                reply(id, result)
            );
            ([("Content-Type", "text/event-stream")], frame).into_response()
        }
        _ => panic!("Недопустимый запрос MCP"),
    }
}

#[tokio::test]
async fn scoped_adapters_return_only_hits_from_matching_host_repo_and_ref() {
    for provider in [
        c::Provider::Confluence,
        c::Provider::Github,
        c::Provider::Gitlab,
    ] {
        // Arrange: MCP объявляет метод записи наряду с инструментами чтения.
        let url = fixture(
            Router::new()
                .route("/mcp", post(endpoint))
                .with_state(Fixture {
                    provider,
                    indexed: false,
                }),
        )
        .await;
        let (_temp, connections, vault) = state();
        let (profile, scope) = options(provider, &url);
        connections
            .put(
                &vault,
                provider.into(),
                c::ConnectionUpdate {
                    profile,
                    secret: c::SecretChange::Token {
                        value: TOKEN.into(),
                    },
                },
            )
            .await
            .expect("Профиль MCP");
        let mut mcp = connections.mcp(&vault, provider).await.expect("Сессия MCP");

        // Act: адаптер ищет совпадение и читает строку по ссылке из ответа.
        let hits = mcp
            .search(
                scope,
                c::Query {
                    text: "needle".into(),
                    limit: 10,
                },
            )
            .await
            .expect("Результаты поиска");
        assert_eq!(hits.len(), 1, "{provider:?}");
        let line = if provider == c::Provider::Confluence {
            1
        } else {
            2
        };
        let fragment = mcp
            .read(
                &hits[0].source,
                c::Lines {
                    first: line,
                    last: 2,
                },
            )
            .await
            .expect("Фрагмент");

        // Assert: чужие источники отброшены, результат содержит проверенную строку.
        assert_eq!(hits[0].excerpt, "needle");
        let cite = serde_json::to_value(&fragment.cite).expect("Ссылка JSON");
        if provider == c::Provider::Confluence {
            assert_eq!(fragment.text, "Введение\nneedle");
            assert_eq!(cite["kind"], "confluence");
        } else {
            assert_eq!(fragment.text, "needle");
            assert_eq!(cite["path"], PATH);
            assert_eq!(cite["line"], 2);
            assert!(cite["url"].as_str().expect("URL").contains(SHA));
        }
    }
}

#[tokio::test]
async fn indexed_adapters_find_deep_hits_and_discard_other_repositories() {
    for provider in [c::Provider::Github, c::Provider::Gitlab] {
        // Arrange: индекс содержит строку 201 в файле, недоступном ограниченному обходу.
        let url = fixture(
            Router::new()
                .route("/mcp", post(endpoint))
                .with_state(Fixture {
                    provider,
                    indexed: true,
                }),
        )
        .await;
        let (_temp, connections, vault) = state();
        let (profile, scope) = options(provider, &url);
        connections
            .put(
                &vault,
                provider.into(),
                c::ConnectionUpdate {
                    profile,
                    secret: c::SecretChange::Token {
                        value: TOKEN.into(),
                    },
                },
            )
            .await
            .expect("Профиль MCP");
        let mut mcp = connections.mcp(&vault, provider).await.expect("Сессия MCP");

        // Act: адаптер использует нативный поиск и читает найденную строку по SHA.
        let hits = mcp
            .search(
                scope,
                c::Query {
                    text: "needle".into(),
                    limit: 10,
                },
            )
            .await
            .expect("Результаты нативного поиска");
        let fragment = mcp
            .read(
                &hits[0].source,
                c::Lines {
                    first: 201,
                    last: 201,
                },
            )
            .await
            .expect("Фрагмент по зафиксированному SHA");

        // Assert: чужой репозиторий отброшен, найдена и прочитана именно строка 201.
        assert_eq!(hits.len(), 1, "{provider:?}");
        assert_eq!(hits[0].excerpt, "needle");
        assert_eq!(fragment.text, "needle");
        let cite = serde_json::to_value(&fragment.cite).expect("Ссылка JSON");
        assert_eq!(cite["path"], DEEP_PATH);
        assert_eq!(cite["line"], 201);
        assert!(cite["url"].as_str().expect("URL").contains(SHA));
    }
}

fn options(provider: c::Provider, url: &Url) -> (c::Profile, c::SearchScope) {
    let endpoint = url.join("/mcp").expect("MCP URL").to_string();
    let resource_host = url[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
    let repo = |provider| {
        c::SearchScope::Repo(c::Repo {
            provider,
            url: url
                .join("/team/project")
                .expect("URL репозитория")
                .to_string(),
            reference: Some("release".into()),
        })
    };
    match provider {
        c::Provider::Confluence => (
            c::Profile::Confluence {
                endpoint,
                resource_host,
            },
            c::SearchScope::Confluence,
        ),
        c::Provider::Gitlab => (
            c::Profile::Gitlab {
                endpoint,
                resource_host,
            },
            repo(c::RepoProvider::Gitlab),
        ),
        c::Provider::Github => (
            c::Profile::Github {
                endpoint,
                resource_host,
            },
            repo(c::RepoProvider::Github),
        ),
    }
}

#[tokio::test]
async fn mcp_rejects_catalog_that_marks_an_allowed_name_as_writable() {
    // Arrange: сервер объявляет поиск, но помечает его как операцию записи.
    let app = Router::new().route(
        "/mcp",
        post(|Json(body): Json<Value>| async move {
            let id = &body["id"];
            match body["method"].as_str() {
                Some("initialize") => Json(reply(
                    id,
                    json!({
                        "protocolVersion":"2025-06-18","capabilities":{"tools":{}}
                    }),
                ))
                .into_response(),
                Some("notifications/initialized") => StatusCode::ACCEPTED.into_response(),
                Some("tools/list") => {
                    let mut tools = list(c::Provider::Confluence, false);
                    tools[0]["annotations"] = json!({"readOnlyHint": false});
                    Json(reply(id, json!({"tools":tools}))).into_response()
                }
                _ => panic!("Запущен недопустимый инструмент"),
            }
        }),
    );
    let url = fixture(app).await;
    let (_temp, connections, vault) = state();
    let (profile, _) = options(c::Provider::Confluence, &url);
    let slot = c::Slot::Confluence;
    connections
        .put(
            &vault,
            slot,
            c::ConnectionUpdate {
                profile,
                secret: c::SecretChange::Token {
                    value: TOKEN.into(),
                },
            },
        )
        .await
        .expect("Профиль MCP");

    // Act: клиент открывает подключение и проверяет каталог.
    let mcp = connections.mcp(&vault, c::Provider::Confluence).await;

    // Assert: клиент не открывает сеанс для работы с инструментами записи.
    assert!(matches!(mcp, Err(c::ConnectionError::Unsupported)));
    assert_eq!(
        connections.list(&vault).await.expect("Статус")[0].state,
        c::ConnectionState::Unsupported
    );
}
