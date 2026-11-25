use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use crate::agent_bindings::hash;
use crate::agent_bindings::ignore::{self, IgnoreRule};
use crate::agent_bindings::model::{
    BindingError, BindingResult, BoundSource, Cite, Fragment, Hit, Lines, LocalLimits, Query,
};
use crate::agent_bindings::store::validate_relative;

pub struct LocalCode {
    limits: LocalLimits,
}

struct TextFile {
    text: String,
}

impl Default for LocalCode {
    fn default() -> Self {
        Self::new(LocalLimits::default())
    }
}

impl LocalCode {
    pub fn new(limits: LocalLimits) -> Self {
        Self { limits }
    }

    pub fn read(
        &self,
        source: &BoundSource,
        relative_path: &str,
        lines: Lines,
    ) -> BindingResult<Fragment> {
        validate_relative(relative_path, true)?;
        validate_readable_name(relative_path)?;
        validate_lines(lines, self.limits.max_read_lines)?;
        let root = canonical_root(source)?;
        let file = open_text(&root, relative_path, self.limits.max_file_bytes)?;
        let all_lines: Vec<&str> = file.text.lines().collect();
        if lines.last > all_lines.len() {
            return Err(BindingError::new(
                "invalid_lines",
                "Запрошенный диапазон выходит за конец файла.",
            ));
        }
        let text = all_lines[lines.first - 1..lines.last].join("\n");
        Ok(Fragment {
            cite: Cite::LocalCode {
                path: relative_path.to_string(),
                line: lines.first,
            },
            text,
        })
    }

    pub fn search(&self, source: &BoundSource, query: Query) -> BindingResult<Vec<Hit>> {
        if query.text.trim().is_empty() {
            return Err(BindingError::new(
                "invalid_query",
                "Поисковый запрос не должен быть пустым.",
            ));
        }
        self.scan(source, Some(&query.text.to_lowercase()), query.limit)
    }

    pub fn discover(&self, source: &BoundSource) -> BindingResult<Vec<Hit>> {
        self.scan(source, None, 4)
    }

    fn scan(
        &self,
        source: &BoundSource,
        needle: Option<&str>,
        limit: usize,
    ) -> BindingResult<Vec<Hit>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let root = canonical_root(source)?;
        let deadline = Instant::now() + self.limits.search_timeout;
        let result_limit = limit.min(self.limits.max_results);
        let mut hits = Vec::new();
        let mut visited_files = 0_usize;
        let mut directories = vec![(root.clone(), String::new(), Vec::new())];

        while let Some((directory, relative, parent_rules)) = directories.pop() {
            check_deadline(deadline)?;
            let mut rules = parent_rules;
            rules.extend(read_ignore_rules(&directory, &relative));
            let mut entries = read_directory(&directory)?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries.into_iter().rev() {
                check_deadline(deadline)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let child_relative = join_relative(&relative, &name);
                let file_type = entry.file_type().map_err(|_| io_error())?;
                if file_type.is_symlink() || name == ".git" {
                    continue;
                }
                if file_type.is_dir() {
                    if !secret_name(&name) && !ignore::ignored(&rules, &child_relative, true) {
                        directories.push((entry.path(), child_relative, rules.clone()));
                    }
                    continue;
                }
                if !file_type.is_file()
                    || secret_name(&name)
                    || ignore::ignored(&rules, &child_relative, false)
                {
                    continue;
                }
                visited_files += 1;
                if visited_files > self.limits.max_files {
                    return Err(BindingError::new(
                        "limit_exceeded",
                        "Поиск превысил ограничение на число файлов.",
                    ));
                }
                if needle.is_none()
                    && !name.eq_ignore_ascii_case("readme.md")
                    && !name.eq_ignore_ascii_case("index.md")
                {
                    continue;
                }
                let file = match open_text(&root, &child_relative, self.limits.max_file_bytes) {
                    Ok(file) => file,
                    Err(error) if matches!(error.code, "not_text" | "too_large") => continue,
                    Err(error) => return Err(error),
                };
                let preview = needle.is_none().then(|| truncate(&file.text, 1800));
                let lines = preview.as_deref().into_iter().chain(
                    file.text
                        .lines()
                        .take(if preview.is_some() { 0 } else { usize::MAX }),
                );
                for (index, line) in lines.enumerate() {
                    if needle.map_or_else(
                        || !line.trim().is_empty(),
                        |term| line.to_lowercase().contains(term),
                    ) {
                        let line_number = index + 1;
                        let excerpt = if needle.is_none() {
                            line.to_owned()
                        } else {
                            truncate(line.trim_end_matches('\r'), self.limits.max_excerpt_chars)
                        };
                        hits.push(Hit {
                            reference: hash::reference(
                                format!("local\0{child_relative}\0{line_number}\0{line}")
                                    .as_bytes(),
                            ),
                            cite: Cite::LocalCode {
                                path: child_relative.clone(),
                                line: line_number,
                            },
                            excerpt,
                        });
                        if hits.len() == result_limit {
                            return Ok(hits);
                        }
                    }
                    check_deadline(deadline)?;
                }
            }
        }
        Ok(hits)
    }
}

fn canonical_root(source: &BoundSource) -> BindingResult<PathBuf> {
    let local_dir = source.local_dir.as_ref().ok_or_else(|| {
        BindingError::new("not_bound", "Для папки не задана локальная директория.")
    })?;
    let root = fs::canonicalize(local_dir)
        .map_err(|_| BindingError::new("not_found", "Локальная директория недоступна."))?;
    if !root.is_dir() {
        return Err(BindingError::new(
            "invalid_path",
            "Локальная привязка должна указывать на директорию.",
        ));
    }
    Ok(root)
}

fn open_text(root: &Path, relative: &str, max_bytes: u64) -> BindingResult<TextFile> {
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(part) = component else {
            return Err(BindingError::new(
                "invalid_path",
                "Некорректный путь к файлу.",
            ));
        };
        path.push(part);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| BindingError::new("not_found", "Файл не найден."))?;
        if metadata.file_type().is_symlink() {
            return Err(BindingError::new(
                "invalid_path",
                "Чтение через символическую ссылку запрещено.",
            ));
        }
    }
    let canonical =
        fs::canonicalize(&path).map_err(|_| BindingError::new("not_found", "Файл не найден."))?;
    if !canonical.starts_with(root) {
        return Err(BindingError::new(
            "invalid_path",
            "Файл находится вне привязанной директории.",
        ));
    }
    let mut handle = fs::File::open(&canonical)
        .map_err(|_| BindingError::new("not_found", "Файл не найден."))?;
    let metadata = handle
        .metadata()
        .map_err(|_| BindingError::new("not_found", "Метаданные файла недоступны."))?;
    if !metadata.is_file() {
        return Err(BindingError::new(
            "invalid_path",
            "Можно читать только обычные файлы.",
        ));
    }
    if metadata.len() > max_bytes {
        return Err(BindingError::new(
            "too_large",
            "Файл превышает ограничение на размер.",
        ));
    }
    let mut bytes = Vec::new();
    handle
        .by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| BindingError::new("not_found", "Не удалось прочитать файл."))?;
    if bytes.len() as u64 > max_bytes {
        return Err(BindingError::new(
            "too_large",
            "Файл превышает ограничение на размер.",
        ));
    }
    if bytes.contains(&0) {
        return Err(BindingError::new(
            "not_text",
            "Двоичный файл не участвует в поиске.",
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| BindingError::new("not_text", "Файл не является текстом UTF-8."))?;
    Ok(TextFile { text })
}

fn read_directory(path: &Path) -> BindingResult<Vec<fs::DirEntry>> {
    let entries = fs::read_dir(path).map_err(|_| io_error())?;
    let mut output = Vec::new();
    for entry in entries {
        output.push(entry.map_err(|_| io_error())?);
    }
    Ok(output)
}

fn read_ignore_rules(directory: &Path, relative: &str) -> Vec<IgnoreRule> {
    let path = directory.join(".gitignore");
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return Vec::new();
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return Vec::new();
    }
    match fs::read_to_string(path) {
        Ok(source) => IgnoreRule::parse(relative, &source),
        Err(_) => Vec::new(),
    }
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn validate_readable_name(relative: &str) -> BindingResult<()> {
    if relative.split('/').any(|segment| segment == ".git")
        || relative.rsplit('/').next().is_some_and(secret_name)
    {
        return Err(BindingError::new(
            "access_denied",
            "Чтение секретов и служебных файлов Git запрещено.",
        ));
    }
    Ok(())
}

fn secret_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || matches!(
            lower.as_str(),
            ".netrc"
                | ".npmrc"
                | ".pypirc"
                | "auth.json"
                | "credentials"
                | "credentials.json"
                | "id_rsa"
                | "id_dsa"
                | "id_ecdsa"
                | "id_ed25519"
                | "secrets.json"
                | "secrets.yaml"
                | "secrets.yml"
        )
        || [".pem", ".key", ".p12", ".pfx", ".kdbx", ".keystore", ".jks"]
            .iter()
            .any(|extension| lower.ends_with(extension))
}

fn validate_lines(lines: Lines, max_lines: usize) -> BindingResult<()> {
    if lines.first == 0 || lines.last < lines.first {
        return Err(BindingError::new(
            "invalid_lines",
            "Номера строк начинаются с 1, последняя строка не предшествует первой.",
        ));
    }
    if lines.last - lines.first + 1 > max_lines {
        return Err(BindingError::new(
            "limit_exceeded",
            "Запрошен слишком большой диапазон строк.",
        ));
    }
    Ok(())
}

fn check_deadline(deadline: Instant) -> BindingResult<()> {
    if Instant::now() >= deadline {
        Err(BindingError::new(
            "timeout",
            "Поиск превысил ограничение по времени.",
        ))
    } else {
        Ok(())
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

fn io_error() -> BindingError {
    BindingError::new("io", "Не удалось прочитать локальную директорию.")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use super::LocalCode;
    use crate::agent_bindings::model::{BoundSource, Cite, Lines, LocalLimits, Query};

    fn source(root: &Path) -> BoundSource {
        BoundSource {
            folder: String::new(),
            repo: None,
            local_dir: Some(root.to_path_buf()),
        }
    }

    fn code() -> LocalCode {
        LocalCode::new(LocalLimits {
            max_file_bytes: 4096,
            max_files: 100,
            max_results: 10,
            max_read_lines: 10,
            max_excerpt_chars: 80,
            search_timeout: Duration::from_secs(5),
        })
    }

    fn query(text: &str) -> Query {
        Query {
            text: text.to_string(),
            limit: 10,
        }
    }

    #[test]
    fn читает_строки_и_возвращает_относительную_ссылку() -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempfile::tempdir()?;
        fs::create_dir(temporary.path().join("src"))?;
        fs::write(
            temporary.path().join("src/main.rs"),
            "один\nдва\nтри\nчетыре\n",
        )?;
        let fragment = code().read(
            &source(temporary.path()),
            "src/main.rs",
            Lines { first: 2, last: 3 },
        )?;
        assert_eq!(fragment.text, "два\nтри");
        assert_eq!(
            fragment.cite,
            Cite::LocalCode {
                path: "src/main.rs".into(),
                line: 2,
            }
        );
        Ok(())
    }

    #[test]
    fn запрещает_выход_из_корня_и_чтение_без_привязки() -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempfile::tempdir()?;
        fs::write(temporary.path().join("root.txt"), "корень")?;
        let traversal = code().read(
            &source(temporary.path()),
            "../root.txt",
            Lines { first: 1, last: 1 },
        );
        assert_eq!(
            traversal.err().map(|error| error.code),
            Some("invalid_path")
        );
        let unbound = BoundSource {
            folder: String::new(),
            repo: None,
            local_dir: None,
        };
        let denied = code().search(&unbound, query("текст"));
        assert_eq!(denied.err().map(|error| error.code), Some("not_bound"));
        fs::write(temporary.path().join(".env"), "SECRET=value")?;
        let secret = code().read(
            &source(temporary.path()),
            ".env",
            Lines { first: 1, last: 1 },
        );
        assert_eq!(secret.err().map(|error| error.code), Some("access_denied"));
        Ok(())
    }

    #[test]
    fn учитывает_gitignore_и_исключает_секреты_и_двоичные_файлы()
    -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempfile::tempdir()?;
        fs::create_dir(temporary.path().join(".git"))?;
        fs::create_dir(temporary.path().join("logs"))?;
        fs::write(temporary.path().join(".gitignore"), "logs/\n*.tmp\n")?;
        fs::write(temporary.path().join(".git/config"), "слово")?;
        fs::write(temporary.path().join("logs/debug.txt"), "слово")?;
        fs::write(temporary.path().join("scratch.tmp"), "слово")?;
        fs::write(temporary.path().join(".env"), "слово=secret")?;
        fs::write(temporary.path().join("key.pem"), "слово")?;
        fs::write(temporary.path().join("binary.dat"), [0, 1, 2, 3])?;
        fs::write(
            temporary.path().join("main.rs"),
            "первая строка\nслово здесь\n",
        )?;

        let hits = code().search(&source(temporary.path()), query("СЛОВО"))?;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].excerpt, "слово здесь");
        assert_eq!(
            hits[0].cite,
            Cite::LocalCode {
                path: "main.rs".into(),
                line: 2,
            }
        );
        assert_eq!(hits[0].reference.len(), 36);
        Ok(())
    }

    #[test]
    fn запрещает_чтение_и_поиск_auth_json() -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempfile::tempdir()?;
        let directory = temporary.path().join(".livenote");
        fs::create_dir(&directory)?;
        fs::write(directory.join("auth.json"), "fixture-auth-secret")?;
        let denied = code().read(
            &source(temporary.path()),
            ".livenote/auth.json",
            Lines { first: 1, last: 1 },
        );
        assert_eq!(denied.err().map(|error| error.code), Some("access_denied"));
        assert!(
            code()
                .search(&source(temporary.path()), query("fixture-auth-secret"))?
                .is_empty()
        );
        Ok(())
    }

    #[test]
    fn ограничивает_число_результатов_и_размер_файла() -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempfile::tempdir()?;
        fs::write(temporary.path().join("large.txt"), "12345")?;
        let limited = LocalCode::new(LocalLimits {
            max_file_bytes: 4,
            ..LocalLimits::default()
        });
        let large = limited.read(
            &source(temporary.path()),
            "large.txt",
            Lines { first: 1, last: 1 },
        );
        assert_eq!(large.err().map(|error| error.code), Some("too_large"));

        fs::write(temporary.path().join("large.txt"), "слово\nслово\nслово")?;
        let hits = code().search(
            &source(temporary.path()),
            Query {
                text: "слово".into(),
                limit: 2,
            },
        )?;
        assert_eq!(hits.len(), 2);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn не_следует_по_symlink_при_чтении_и_поиске() -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempfile::tempdir()?;
        let root = temporary.path().join("root");
        let outside = temporary.path().join("outside");
        fs::create_dir(&root)?;
        fs::create_dir(&outside)?;
        fs::write(outside.join("private.txt"), "слово")?;
        std::os::unix::fs::symlink(&outside, root.join("link"))?;
        std::os::unix::fs::symlink(outside.join("private.txt"), root.join("file.txt"))?;

        let read = code().read(&source(&root), "file.txt", Lines { first: 1, last: 1 });
        assert_eq!(read.err().map(|error| error.code), Some("invalid_path"));
        let hits = code().search(&source(&root), query("слово"))?;
        assert!(hits.is_empty());
        Ok(())
    }

    #[test]
    fn не_возвращает_абсолютные_пути_в_результатах() -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempfile::tempdir()?;
        let file: PathBuf = temporary.path().join("note.txt");
        fs::write(&file, "слово")?;
        let hits = code().search(&source(temporary.path()), query("слово"))?;
        let serialized = serde_json::to_string(&hits)?;
        assert!(!serialized.contains(&temporary.path().to_string_lossy().to_string()));
        Ok(())
    }
}
