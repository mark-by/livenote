use std::fs;
use std::sync::Mutex;

use super::{BindingVault, Bindings};
use crate::agent_bindings::hash;
use crate::agent_bindings::model::{
    Binding, BindingRequest, BindingResult, CasBytes, Repo, RepoProvider, Version, VersionedBytes,
};

#[derive(Default)]
struct TestVault {
    id: String,
    file: Mutex<Option<VersionedBytes>>,
}

impl TestVault {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            file: Mutex::new(None),
        }
    }

    fn bytes(&self) -> Vec<u8> {
        self.file
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|file| file.bytes.clone())
            .unwrap_or_default()
    }
}

impl BindingVault for TestVault {
    fn vault_id(&self) -> &str {
        &self.id
    }

    fn read_bindings(&self) -> BindingResult<Option<VersionedBytes>> {
        Ok(self
            .file
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone())
    }

    fn write_bindings(&self, update: CasBytes) -> BindingResult<Version> {
        let mut file = self.file.lock().unwrap_or_else(|error| error.into_inner());
        let actual = file.as_ref().map(|current| current.version.clone());
        if actual != update.expected {
            return Err(crate::agent_bindings::BindingError::new(
                "conflict",
                "CAS-конфликт",
            ));
        }
        let version = hash::version(&update.bytes);
        *file = Some(VersionedBytes {
            version: version.clone(),
            bytes: update.bytes,
        });
        Ok(version)
    }
}

fn repo(url: &str) -> Repo {
    Repo {
        provider: RepoProvider::Gitlab,
        url: url.to_string(),
        reference: Some("main".to_string()),
    }
}

fn request(folder: &str, value: Binding, version: Option<String>) -> BindingRequest {
    BindingRequest {
        folder: folder.to_string(),
        value,
        version,
    }
}

#[test]
fn разделяет_общие_и_локальные_данные() -> Result<(), Box<dyn std::error::Error>> {
    let temporary = tempfile::tempdir()?;
    let local_code = temporary.path().join("копия");
    fs::create_dir(&local_code)?;
    let bindings = Bindings::new(temporary.path().join("private"));
    let vault = TestVault::new("vault-a");
    let value = Binding {
        repo: Some(repo("https://gitlab.example/team/service")),
        local_dir: Some(local_code.clone()),
    };

    let saved = bindings.put(&vault, request("services/store", value, None))?;
    assert_eq!(saved.value.local_dir, Some(local_code.canonicalize()?));
    assert!(saved.version.is_some());

    let shared: serde_json::Value = serde_json::from_slice(&vault.bytes())?;
    assert_eq!(shared["schema"], 1);
    assert_eq!(
        shared["folders"]["services/store"]["url"],
        "https://gitlab.example/team/service"
    );
    assert!(shared.to_string().find("localDir").is_none());
    assert!(!shared.to_string().contains("копия"));

    let local_path = bindings.local_file("vault-a");
    let local_text = fs::read_to_string(local_path)?;
    assert!(local_text.contains("копия"));
    assert!(!local_text.contains("gitlab.example"));
    Ok(())
}

#[test]
fn наследует_ближайшую_папку_по_сегментам() -> Result<(), Box<dyn std::error::Error>> {
    let temporary = tempfile::tempdir()?;
    let bindings = Bindings::new(temporary.path());
    let vault = TestVault::new("vault-a");
    let root = bindings.put(
        &vault,
        request(
            "",
            Binding {
                repo: Some(repo("https://gitlab.example/team/root")),
                local_dir: None,
            },
            None,
        ),
    )?;
    bindings.put(
        &vault,
        request(
            "services/store",
            Binding {
                repo: Some(repo("https://gitlab.example/team/store")),
                local_dir: None,
            },
            None,
        ),
    )?;
    bindings.put(
        &vault,
        request(
            "services/storehouse",
            Binding {
                repo: Some(repo("https://gitlab.example/team/storehouse")),
                local_dir: None,
            },
            None,
        ),
    )?;

    let inherited = bindings.resolve(&vault, "services/store/docs/api")?;
    assert_eq!(
        inherited.map(|source| source.folder),
        Some("services/store".into())
    );
    let root_inherited = bindings.resolve(&vault, "services/other/docs")?;
    assert_eq!(
        root_inherited.map(|source| source.folder),
        Some(String::new())
    );
    assert_eq!(root.value.repo, root_inherited_repo(&bindings, &vault)?);
    let unrelated = bindings.resolve(&vault, "services/storehouse/docs")?;
    assert_eq!(
        unrelated
            .and_then(|source| source.repo)
            .map(|repo| repo.url),
        Some("https://gitlab.example/team/storehouse".into())
    );
    Ok(())
}

fn root_inherited_repo(
    bindings: &Bindings,
    vault: &TestVault,
) -> Result<Option<Repo>, Box<dyn std::error::Error>> {
    Ok(bindings
        .resolve(vault, "services/other")?
        .and_then(|source| source.repo))
}

#[test]
fn проверяет_cas_и_удаляет_пустую_привязку() -> Result<(), Box<dyn std::error::Error>> {
    let temporary = tempfile::tempdir()?;
    let bindings = Bindings::new(temporary.path());
    let vault = TestVault::new("vault-a");
    let saved = bindings.put(
        &vault,
        request(
            "service",
            Binding {
                repo: Some(repo("https://gitlab.example/team/service")),
                local_dir: None,
            },
            None,
        ),
    )?;

    let stale = bindings.put(&vault, request("service", Binding::default(), None));
    assert_eq!(
        stale.map(|_| ()).err().map(|error| error.code),
        Some("conflict")
    );

    let removed = bindings.put(
        &vault,
        request("service", Binding::default(), saved.version),
    )?;
    assert_eq!(removed.version, None);
    assert_eq!(bindings.resolve(&vault, "service/docs")?, None);
    Ok(())
}

#[test]
fn отклоняет_секреты_в_url_и_переходы_в_путях() {
    let temporary = match tempfile::tempdir() {
        Ok(value) => value,
        Err(error) => panic!("не удалось создать fixture: {error}"),
    };
    let bindings = Bindings::new(temporary.path());
    let vault = TestVault::new("vault-a");
    for url in [
        "https://user:token@gitlab.example/team/service",
        "https://gitlab.example/team/service?token=secret",
        "https://gitlab.example/team/service#secret",
    ] {
        let result = bindings.put(
            &vault,
            request(
                "service",
                Binding {
                    repo: Some(repo(url)),
                    local_dir: None,
                },
                None,
            ),
        );
        assert_eq!(
            result.err().map(|error| error.code),
            Some("invalid_binding")
        );
    }
    let traversal = bindings.put(&vault, request("../service", Binding::default(), None));
    assert_eq!(
        traversal.err().map(|error| error.code),
        Some("invalid_path")
    );
}
