use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const BINDINGS_FILE: &str = "livenote.bindings.json";

pub type Version = String;
pub type BindingResult<T> = Result<T, BindingError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingError {
    pub code: &'static str,
    pub message: String,
}

impl BindingError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for BindingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for BindingError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionedBytes {
    pub version: Version,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CasBytes {
    pub expected: Option<Version>,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepoProvider {
    Gitlab,
    Github,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Repo {
    pub provider: RepoProvider,
    pub url: String,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub repo: Option<Repo>,
    pub local_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingView {
    pub value: Binding,
    pub version: Option<Version>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingRequest {
    pub value: Binding,
    pub version: Option<Version>,
    pub folder: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundSource {
    pub folder: String,
    pub repo: Option<Repo>,
    pub local_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    pub text: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lines {
    pub first: usize,
    pub last: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Cite {
    #[serde(rename_all = "camelCase")]
    LocalCode { path: String, line: usize },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hit {
    #[serde(rename = "ref")]
    pub reference: String,
    pub cite: Cite,
    pub excerpt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fragment {
    pub cite: Cite,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct LocalLimits {
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub max_results: usize,
    pub max_read_lines: usize,
    pub max_excerpt_chars: usize,
    pub search_timeout: Duration,
}

impl Default for LocalLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 1024 * 1024,
            max_files: 10_000,
            max_results: 100,
            max_read_lines: 1_000,
            max_excerpt_chars: 500,
            search_timeout: Duration::from_secs(2),
        }
    }
}
