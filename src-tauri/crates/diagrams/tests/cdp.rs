use std::{env, fs, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use livenote_diagrams::{DiagramEngine, DiagramFormat, MermaidTheme, ValidationStatus};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    net::UnixListener,
    process::Command,
    time::timeout,
};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;
const TEST_TIMEOUT: Duration = Duration::from_secs(40);

#[tokio::test]
#[ignore = "требует сборку Vite desktop, Chrome Headless Shell и nc"]
async fn cdp_partial_png_reply_preserves_svg_and_next_render() -> TestResult {
    // Arrange: первый запуск Chromium проходит через локальный прокси CDP.
    let fixture = tempfile::tempdir()?;
    let launcher = fixture.path().join("launch");
    let socket = fixture.path().join("s");
    let listener = UnixListener::bind(socket)?;
    let chromium = env::var("LIVENOTE_TEST_CHROMIUM")?;
    let web_root = env::var("LIVENOTE_TEST_DIAGRAM_WEB")?;
    fs::write(launcher.with_extension("chrome"), format!("{chromium}\n"))?;
    fs::write(
        &launcher,
        r#"#!/bin/sh
if [ -f "$0.args" ]; then
    IFS= read -r chrome < "$0.chrome"
    exec "$chrome" "$@"
fi
printf '%s\n' "$@" > "$0.args"
exec nc -U "${0%/*}/s" <&3 >&4
"#,
    )?;
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700))?;
    let engine = DiagramEngine::new(launcher.clone(), web_root.into());

    // Act: задерживаем хвост ответа PNG, затем запрашиваем другую диаграмму.
    let theme = MermaidTheme::Default;
    let format = DiagramFormat::Mermaid;
    let first = engine.render(format, "flowchart LR\n A[FirstSvg] --> B", theme, true);
    let (first, follow_up) = timeout(TEST_TIMEOUT, async {
        tokio::join!(first, delay_cdp_screenshot_reply(&listener, &launcher))
    })
    .await?;
    let follow_up = follow_up?;
    let next = engine
        .render(format, "flowchart LR\n C[NextSvg] --> D", theme, true)
        .await;

    // Assert: первый SVG сохранился, а следующий запрос вернул SVG и PNG.
    assert_eq!(first.validation.syntax, ValidationStatus::Ok);
    let first = first.render.ok_or("Нет первого SVG")?;
    assert!(first.svg.contains("FirstSvg"));
    assert!(first.png_base64.is_none());
    assert_eq!(next.validation.syntax, ValidationStatus::Ok);
    let next = next.render.ok_or("Нет следующего SVG")?;
    assert!(next.svg.contains("NextSvg"));
    let png = STANDARD.decode(next.png_base64.ok_or("Нет следующего PNG")?)?;
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    eprintln!("Первый запрос: SVG без PNG. Следующий запрос: SVG и PNG.");
    assert_eq!(follow_up, None, "Команда в CDP после частичного ответа");
    Ok(())
}

async fn delay_cdp_screenshot_reply(
    listener: &UnixListener,
    launcher: &Path,
) -> TestResult<Option<String>> {
    let (client, _) = listener.accept().await?;
    let (input, mut output) = client.into_split();
    let mut input = BufReader::new(input);
    let args = fs::read_to_string(launcher.with_extension("args"))?;
    let chromium = fs::read_to_string(launcher.with_extension("chrome"))?;
    let mut child = Command::new("/bin/sh")
        .args([
            "-c",
            "exec 3<&0 4>&1 </dev/null >/dev/null; exec \"$@\"",
            "chrome",
        ])
        .arg(chromium.trim_end())
        .args(args.lines())
        .env_clear()
        .env("HOME", launcher.parent().ok_or("Нет временного каталога")?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut chrome_in = child.stdin.take().ok_or("Нет входного канала Chromium")?;
    let mut chrome_out = BufReader::new(child.stdout.take().ok_or("Нет выхода Chromium")?);
    let mut command = Vec::new();
    let mut reply = Vec::new();
    let mut screenshot_id = None;
    let follow_up = loop {
        tokio::select! {
            read = input.read_until(0, &mut command) => {
                assert_ne!(read?, 0, "CDP закрылся до ответа PNG");
                let message: Value = serde_json::from_slice(&command[..command.len() - 1])?;
                if message["method"] == "Page.captureScreenshot" {
                    screenshot_id = message["id"].as_u64();
                }
                chrome_in.write_all(&command).await?;
                command.clear();
            }
            read = chrome_out.read_until(0, &mut reply) => {
                assert_ne!(read?, 0, "Chromium закрылся до ответа PNG");
                let message: Value = serde_json::from_slice(&reply[..reply.len() - 1])?;
                if screenshot_id.is_some() && screenshot_id == message["id"].as_u64() {
                    assert!(message["result"]["data"].is_string(), "{message}");
                    let (prefix, tail) = reply.split_at(reply.len() / 2);
                    output.write_all(prefix).await?;
                    eprintln!("Передано {} из {} байт ответа PNG.", prefix.len(), reply.len());
                    // Хвост остаётся в прокси до закрытия канала или следующей команды.
                    if input.read_until(0, &mut command).await? == 0 {
                        break None;
                    }
                    let message: Value = serde_json::from_slice(&command[..command.len() - 1])?;
                    output.write_all(tail).await?;
                    let method = message["method"].as_str().ok_or("Нет метода CDP")?;
                    break Some(method.to_owned());
                }
                output.write_all(&reply).await?;
                reply.clear();
            }
        }
    };
    child.kill().await?;
    Ok(follow_up)
}
