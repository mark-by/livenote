use super::*;

const PAGE: &str = "process.md";
const MARKDOWN: &str = "# Процесс\n";
const DRAWIO: &str = r#"<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Start" parent="1" vertex="1"><mxGeometry x="10" y="20" width="50" height="40" as="geometry"/></mxCell></root></mxGraphModel>"#;

#[tokio::test]
async fn agent_blocks_publication_after_diagram_validation_failure() {
    // Arrange: после черновика страницы модель передаёт неверный XML, затем готовит другую заметку.
    let app = Desktop::new().await;
    let question = "Создай страницу со схемой draw.io и отдельную заметку";
    let other = "other.md";
    let (model, _) = model(move |index, input| match index {
        0 => stage_page(index, PAGE),
        1 => write_policy(input, question, "allow"),
        2 => call(
            index,
            "stage_diagram",
            json!({"pagePath": PAGE, "format": "drawio", "source": "<mxGraphModel>"}),
        ),
        3 => {
            let result = result(input);
            assert_eq!(result["error"]["code"], "diagram_invalid", "{result}");
            assert!(
                result["error"]["details"]["validation"].is_object(),
                "{result}"
            );
            stage_page(index, other)
        }
        4 => {
            assert_eq!(result(input)["staged"], true);
            json!({"content":"Страницы сохранены."})
        }
        _ => panic!("Неожиданный запрос модели"),
    })
    .await;

    // Act: отправляем запрос и ждём результата.
    let turn = finish_turn(&app, &model, (false, question)).await;

    // Assert: успешная подготовка другой заметки не снимает ошибку диаграммы.
    assert_eq!(turn["status"], "failed", "{turn}");
    assert_eq!(turn["error"]["code"], "diagram_invalid");
    assert!(!app.vault.path().join(PAGE).exists());
    assert!(!app.vault.path().join(other).exists());
    let events = turn["progress"]["events"].as_array().unwrap();
    let stages: Vec<_> = events
        .iter()
        .filter(|event| event["kind"] == "stage")
        .cloned()
        .collect();
    assert_eq!(
        json!(stages),
        json!([
            {"kind":"stage","source":"vault","target":{"path":PAGE,"pendingPublish":true}},
            {"kind":"stage","source":"vault"},
            {"kind":"stage","source":"vault","target":{"path":other,"pendingPublish":true}}
        ])
    );
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn agent_progress_points_to_appended_diagram_on_an_existing_page() {
    // Arrange: существующая страница заканчивается без перевода строки.
    let chromium = std::env::var_os("LIVENOTE_TEST_CHROMIUM").unwrap().into();
    let web = std::env::var_os("LIVENOTE_TEST_DIAGRAM_WEB")
        .unwrap()
        .into();
    let app = Desktop::open(Some(DiagramEngine::new(chromium, web))).await;
    fs::write(app.vault.path().join(PAGE), "# Процесс\r\nТекст").unwrap();
    let question = "Добавь схему draw.io на страницу";
    let (model, _) = model(move |index, input| match index {
        0 => call(
            index,
            "stage_diagram",
            json!({"pagePath": PAGE, "format": "drawio", "source": DRAWIO}),
        ),
        1 => write_policy(input, question, "allow"),
        2 => json!({"content":"Схема добавлена."}),
        _ => panic!("Неожиданный запрос модели"),
    })
    .await;

    // Act: получаем итог хода через HTTP.
    let turn = finish_turn(&app, &model, (false, question)).await;

    // Assert: цель указывает на строку ссылки на схему, а не на файл вложения.
    assert_eq!(turn["status"], "done", "{turn}");
    let events = turn["progress"]["events"].as_array().unwrap();
    let stage = events.iter().find(|event| event["kind"] == "stage");
    let expected = json!({"kind":"stage","source":"vault","target":{"path":PAGE,"line":4}});
    assert_eq!(stage, Some(&expected));
}

#[tokio::test]
async fn agent_denies_diagram_write_without_user_authorization() {
    // Arrange: пользователь просит показать пример, но модель пытается изменить страницу.
    let app = Desktop::new().await;
    let path = app.vault.path().join(PAGE);
    fs::write(&path, MARKDOWN).unwrap();
    let question = "Покажи пример draw.io в чате";
    let (model, _) = model(move |index, input| match index {
        0 => call(
            index,
            "stage_diagram",
            json!({"pagePath": PAGE, "format": "drawio", "source": DRAWIO}),
        ),
        1 => write_policy(input, question, "deny"),
        2 => {
            assert_eq!(result(input)["error"]["code"], "write_forbidden");
            json!({"content":"Схема добавлена."})
        }
        _ => panic!("Неожиданный запрос модели"),
    })
    .await;

    // Act: отправляем запрос и ждём результата.
    let turn = finish_turn(&app, &model, (false, question)).await;

    // Assert: сервер сообщает об отказе и оставляет страницу без изменений.
    assert_eq!(turn["status"], "failed", "{turn}");
    assert_eq!(turn["error"]["code"], "write_forbidden");
    assert_eq!(fs::read_to_string(path).unwrap(), MARKDOWN);
}

#[tokio::test]
async fn agent_blocks_publication_after_malformed_diagram_arguments() {
    // Arrange: модель передаёт неизвестный формат, затем готовит страницу.
    let app = Desktop::new().await;
    let question = "Создай страницу со схемой";
    let (model, _) = model(move |index, input| match index {
        0 => call(
            index,
            "stage_diagram",
            json!({"pagePath": PAGE, "format": "svg", "source": "<svg/>"}),
        ),
        1 => {
            assert_eq!(result(input)["error"]["code"], "invalid_request");
            stage_page(index, PAGE)
        }
        2 => write_policy(input, question, "allow"),
        3 => {
            assert_eq!(result(input)["staged"], true);
            json!({"content":"Страница сохранена."})
        }
        _ => panic!("Неожиданный запрос модели"),
    })
    .await;

    // Act: отправляем запрос и ждём результата.
    let turn = finish_turn(&app, &model, (false, question)).await;

    // Assert: ошибка аргументов блокирует публикацию страницы.
    assert_eq!(turn["status"], "failed", "{turn}");
    assert_eq!(turn["error"]["code"], "invalid_request");
    assert!(!app.vault.path().join(PAGE).exists());
}

fn stage_page(index: usize, path: &str) -> Value {
    let args = json!({"kind": "create", "path": path, "source": MARKDOWN});
    call(index, "stage", args)
}
