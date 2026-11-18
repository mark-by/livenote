use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;

use tempfile::TempDir;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::DiagramError;

pub struct Launched {
    pub(crate) input: ChildStdin,
    pub(crate) output: ChildStdout,
    pub(crate) child: Child,
    pub(crate) profile: TempDir,
}

pub fn launch(chromium: &Path) -> Result<Launched, DiagramError> {
    let profile = tempfile::Builder::new()
        .prefix("livenote-chromium-")
        .tempdir()?;
    let mut user_data_dir = OsString::from("--user-data-dir=");
    user_data_dir.push(profile.path());
    // Chromium читает CDP из fd 3 и пишет в fd 4. Shell дублирует анонимные каналы и
    // заменяет свой процесс Chromium. Ни путь, ни диаграммы не входят в текст скрипта.
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            "exec 3<&0 4>&1 </dev/null >/dev/null; exec \"$@\"",
            "livenote-chromium",
        ])
        .arg(chromium)
        .args([
            "--remote-debugging-pipe",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-quic",
            "--no-first-run",
            "--no-default-browser-check",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            // Запросы к разрешённым ресурсам перехватывает CDP. Для остальных
            // нет доступного прокси; правило распространяется и на loopback.
            "--proxy-server=http://diagram-worker.invalid:9",
            "--proxy-bypass-list=<-loopback>",
            "--host-resolver-rules=MAP * ~NOTFOUND",
        ])
        .arg(user_data_dir)
        .env_clear()
        .env("HOME", profile.path())
        .env("XDG_CONFIG_HOME", profile.path())
        .env("XDG_CACHE_HOME", profile.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let input = child.stdin.take().ok_or(DiagramError::Disconnected)?;
    let output = child.stdout.take().ok_or(DiagramError::Disconnected)?;
    Ok(Launched {
        input,
        output,
        child,
        profile,
    })
}
