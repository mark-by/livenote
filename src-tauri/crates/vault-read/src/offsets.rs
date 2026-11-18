use crate::Utf16Offset;

/// Сопоставляет байтовые позиции AST с позициями JavaScript. Хранит только изменения разницы.
pub(crate) struct Offsets(Vec<(usize, usize)>);

impl Offsets {
    pub(crate) fn new(source: &str) -> Self {
        let mut delta = 0usize;
        Self(
            source
                .char_indices()
                .filter_map(|(at, ch)| {
                    if ch.is_ascii() {
                        return None;
                    }
                    delta = delta.saturating_add(ch.len_utf8().saturating_sub(ch.len_utf16()));
                    Some((at.saturating_add(ch.len_utf8()), delta))
                })
                .collect(),
        )
    }

    pub(crate) fn at(&self, byte: usize) -> Utf16Offset {
        let i = self.0.partition_point(|&(at, _)| at <= byte);
        let delta = i
            .checked_sub(1)
            .and_then(|index| self.0.get(index))
            .map_or(0, |&(_, delta)| delta);
        Utf16Offset(byte.saturating_sub(delta))
    }
}
