#[derive(Debug, Clone)]
pub(crate) struct IgnoreRule {
    base: String,
    pattern: String,
    negated: bool,
    directory_only: bool,
    anchored: bool,
}

impl IgnoreRule {
    pub(crate) fn parse(base: &str, source: &str) -> Vec<Self> {
        source
            .lines()
            .filter_map(|line| Self::parse_line(base, line))
            .collect()
    }

    fn parse_line(base: &str, line: &str) -> Option<Self> {
        let line = line.trim_end_matches(['\r', ' ']);
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (negated, mut pattern) = match line.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, line),
        };
        if let Some(rest) = pattern.strip_prefix('\\') {
            pattern = rest;
        }
        if pattern.is_empty() {
            return None;
        }
        let (directory_only, mut pattern) = match pattern.strip_suffix('/') {
            Some(rest) => (true, rest),
            None => (false, pattern),
        };
        let anchored = pattern.starts_with('/');
        if anchored {
            pattern = &pattern[1..];
        }
        if pattern.is_empty() {
            return None;
        }
        Some(Self {
            base: base.to_string(),
            pattern: pattern.to_string(),
            negated,
            directory_only,
            anchored,
        })
    }

    fn matches(&self, relative: &str, directory: bool) -> Option<bool> {
        if self.directory_only && !directory {
            return None;
        }
        let path = if self.base.is_empty() {
            relative
        } else {
            relative.strip_prefix(&self.base)?.strip_prefix('/')?
        };
        if path.is_empty() {
            return None;
        }
        let matched = if self.anchored || self.pattern.contains('/') {
            glob_matches(&self.pattern, path)
        } else {
            path.split('/')
                .any(|segment| glob_matches(&self.pattern, segment))
        };
        matched.then_some(self.negated)
    }
}

pub(crate) fn ignored(rules: &[IgnoreRule], relative: &str, directory: bool) -> bool {
    let mut ignored = false;
    for rule in rules {
        if let Some(negated) = rule.matches(relative, directory) {
            ignored = !negated;
        }
    }
    ignored
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let path: Vec<char> = path.chars().collect();
    let mut memo = vec![vec![None; path.len() + 1]; pattern.len() + 1];
    glob_at(&pattern, &path, 0, 0, &mut memo)
}

fn glob_at(
    pattern: &[char],
    path: &[char],
    pattern_index: usize,
    path_index: usize,
    memo: &mut [Vec<Option<bool>>],
) -> bool {
    if let Some(cached) = memo[pattern_index][path_index] {
        return cached;
    }
    let result = match pattern.get(pattern_index) {
        None => path_index == path.len(),
        Some('*') => {
            let double = pattern.get(pattern_index + 1) == Some(&'*');
            let next = if double {
                pattern_index + 2
            } else {
                pattern_index + 1
            };
            glob_at(pattern, path, next, path_index, memo)
                || (double
                    && pattern.get(next) == Some(&'/')
                    && glob_at(pattern, path, next + 1, path_index, memo))
                || (path_index < path.len()
                    && (double || path[path_index] != '/')
                    && glob_at(pattern, path, pattern_index, path_index + 1, memo))
        }
        Some('?') => {
            path_index < path.len()
                && path[path_index] != '/'
                && glob_at(pattern, path, pattern_index + 1, path_index + 1, memo)
        }
        Some('[') => character_class(pattern, path, pattern_index, path_index, memo),
        Some('\\') if pattern_index + 1 < pattern.len() => {
            path.get(path_index) == pattern.get(pattern_index + 1)
                && glob_at(pattern, path, pattern_index + 2, path_index + 1, memo)
        }
        Some(expected) => {
            path.get(path_index) == Some(expected)
                && glob_at(pattern, path, pattern_index + 1, path_index + 1, memo)
        }
    };
    memo[pattern_index][path_index] = Some(result);
    result
}

fn character_class(
    pattern: &[char],
    path: &[char],
    pattern_index: usize,
    path_index: usize,
    memo: &mut [Vec<Option<bool>>],
) -> bool {
    let Some(&character) = path.get(path_index) else {
        return false;
    };
    if character == '/' {
        return false;
    }
    let Some(relative_end) = pattern[pattern_index + 1..]
        .iter()
        .position(|item| *item == ']')
    else {
        return character == '[' && glob_at(pattern, path, pattern_index + 1, path_index + 1, memo);
    };
    let end = pattern_index + 1 + relative_end;
    let class = &pattern[pattern_index + 1..end];
    let (negated, class) = match class.first() {
        Some('!') => (true, &class[1..]),
        _ => (false, class),
    };
    let mut contains = false;
    let mut index = 0;
    while index < class.len() {
        if index + 2 < class.len() && class[index + 1] == '-' {
            contains |= class[index] <= character && character <= class[index + 2];
            index += 3;
        } else {
            contains |= class[index] == character;
            index += 1;
        }
    }
    (contains != negated) && glob_at(pattern, path, end + 1, path_index + 1, memo)
}

#[cfg(test)]
mod tests {
    use super::{IgnoreRule, ignored};

    #[test]
    fn применяет_последнее_правило_и_относительный_корень() {
        let mut rules = IgnoreRule::parse("", "*.log\n!keep.log\nbuild/\n/root.txt\n");
        rules.extend(IgnoreRule::parse("src", "*.tmp\n"));
        assert!(ignored(&rules, "debug.log", false));
        assert!(!ignored(&rules, "keep.log", false));
        assert!(ignored(&rules, "build", true));
        assert!(ignored(&rules, "root.txt", false));
        assert!(!ignored(&rules, "docs/root.txt", false));
        assert!(ignored(&rules, "src/data.tmp", false));
        assert!(!ignored(&rules, "other/data.tmp", false));
    }

    #[test]
    fn поддерживает_globstar_и_классы_символов() {
        let rules = IgnoreRule::parse("", "src/**/generated?.rs\n");
        assert!(ignored(&rules, "src/a/b/generated1.rs", false));
        assert!(ignored(&rules, "src/generated2.rs", false));
        assert!(!ignored(&rules, "src/a/generated.rs", false));
    }
}
