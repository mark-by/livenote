use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, StatusCode, redirect::Policy};
use sha2::{Digest, Sha256};
use std::{env::consts, path::Path, time::Duration};
use tokio::{fs::File, io::AsyncWriteExt};

// Совпадает с browserVersion для chromium-headless-shell в Playwright 1.63.0.
pub const VERSION: &str = "153.0.8010.12";
const ORIGIN: &str = "https://storage.googleapis.com/chrome-for-testing-public";

#[derive(Clone, Copy)]
pub struct Artifact {
    pub platform: &'static str,
    sha256: &'static str,
    bytes: u64,
}

impl Artifact {
    pub fn current() -> Result<Self> {
        match (consts::OS, consts::ARCH) {
            ("macos", "aarch64") => Ok(Self {
                platform: "mac-arm64",
                sha256: "89d80a6d26ccd0ccfd51e22d9e1297283862af2b0cd91dce07459b35ca0059f2",
                bytes: 98_831_293,
            }),
            ("linux", "x86_64") => Ok(Self {
                platform: "linux64",
                sha256: "a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d",
                bytes: 119_809_080,
            }),
            (os, arch) => bail!("Установка Chrome Headless Shell недоступна на {os}/{arch}"),
        }
    }
}

pub async fn verified_zip(artifact: Artifact, path: &Path) -> Result<()> {
    let platform = artifact.platform;
    let url = format!("{ORIGIN}/{VERSION}/{platform}/chrome-headless-shell-{platform}.zip");
    let client = Client::builder()
        .tls_backend_rustls()
        .https_only(true)
        .redirect(Policy::none())
        .no_brotli()
        .no_deflate()
        .no_gzip()
        .no_zstd()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(900))
        .build()
        .context("Не удалось настроить HTTPS для загрузки Chrome Headless Shell")?;
    let mut response = client
        .get(url)
        .send()
        .await
        .context("Не удалось загрузить архив Chrome Headless Shell")?;
    let status = response.status();
    ensure!(status == StatusCode::OK, "Сервер вернул HTTP {status}");

    let mut file = File::create_new(path)
        .await
        .context("Не удалось создать файл архива")?;
    let mut hash = Sha256::new();
    let mut remaining = artifact.bytes;
    while let Some(chunk) = response
        .chunk()
        .await
        .context("Не удалось прочитать данные архива")?
    {
        remaining = remaining
            .checked_sub(u64::try_from(chunk.len())?)
            .context("Размер архива Chrome Headless Shell превышает ожидаемый")?;
        hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .context("Не удалось записать данные архива")?;
    }
    ensure!(
        remaining == 0,
        "Архив Chrome Headless Shell загружен не полностью"
    );
    let actual = hash.finalize();
    ensure!(
        format!("{actual:x}") == artifact.sha256,
        "SHA-256 архива Chrome Headless Shell не совпадает"
    );
    file.flush()
        .await
        .context("Не удалось завершить запись архива")
}
