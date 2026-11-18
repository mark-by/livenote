use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::VaultAsset;

/// Возвращает SHA-256 в шестнадцатеричной форме.
#[must_use]
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Возвращает версию байтов файла.
#[must_use]
pub fn file_version(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256(bytes))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub version: String,
    pub revision: u64,
}

/// Возвращает версию документа с учётом пути, исходного текста и его диаграмм.
#[must_use]
pub fn fingerprint(path: &str, source: &str, assets: &[VaultAsset]) -> Fingerprint {
    let assets: BTreeMap<_, _> = assets
        .iter()
        .map(|asset| (asset.path.as_str(), asset))
        .collect();
    let mut hash = Sha256::new();
    let mut field = |value: &str| {
        let length = u64::try_from(value.len()).unwrap_or(u64::MAX);
        hash.update(length.to_be_bytes());
        hash.update(value.as_bytes());
    };
    field("livenote-vault-v2");
    field(path);
    field(source);
    field(&assets.len().to_string());
    for (path, asset) in assets {
        field(path);
        field(asset.kind.as_str());
        field(if asset.source.is_some() {
            "present"
        } else {
            "missing"
        });
        field(asset.source.as_deref().unwrap_or_default());
    }
    let digest = hash.finalize();
    let mut prefix = [0; 8];
    for (target, byte) in prefix.iter_mut().zip(digest.iter()) {
        *target = *byte;
    }
    Fingerprint {
        version: format!("sha256:{digest:x}"),
        revision: 1 + (u64::from_be_bytes(prefix) >> 12),
    }
}

/// Возвращает UUID v8 для канонического пути, полученного от файлового слоя.
#[must_use]
pub fn vault_id_for_root(canonical_root: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"livenote:vault\0");
    hash.update(canonical_root.as_bytes());
    let mut bytes = [0; 16];
    for (i, (target, byte)) in bytes.iter_mut().zip(hash.finalize()).enumerate() {
        *target = match i {
            6 => (byte & 0x0f) | 0x80,
            8 => (byte & 0x3f) | 0x80,
            _ => byte,
        };
    }
    let mut id = String::with_capacity(36);
    for (i, byte) in bytes.into_iter().enumerate() {
        use std::fmt::Write;
        if matches!(i, 4 | 6 | 8 | 10) {
            id.push('-');
        }
        match write!(id, "{byte:02x}") {
            Ok(()) | Err(_) => (),
        }
    }
    id
}

/// Путь индекса внутри системного каталога кэша (обычно `~/.livenote`).
#[must_use]
pub fn vault_cache_path(canonical_root: &str, cache_home: &Path) -> PathBuf {
    cache_home
        .join(vault_id_for_root(canonical_root))
        .join("index.sqlite")
}
