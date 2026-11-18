use markdown::mdast::Node;
use regex::Regex;
use std::sync::LazyLock;

#[expect(clippy::expect_used, reason = "литерал проверяется тестами парсера")]
static WIKI_PROSE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").expect("выражение текста wiki")
});
pub(crate) fn extract(root: &Node) -> String {
    let mut prose = String::new();
    append_prose(root, &mut prose);
    WIKI_PROSE
        .replace_all(&prose, |c: &regex::Captures<'_>| {
            c.get(2)
                .or_else(|| c.get(1))
                .map_or("", |m| m.as_str())
                .to_owned()
        })
        .into_owned()
}

fn append_prose(node: &Node, output: &mut String) {
    match node {
        Node::Html(_)
        | Node::Code(_)
        | Node::InlineCode(_)
        | Node::Link(_)
        | Node::Definition(_) => (),
        Node::Image(image) => output.push_str(&image.alt),
        Node::Text(text) => output.push_str(&text.value),
        _ => {
            if let Some(children) = node.children() {
                for (i, child) in children.iter().enumerate() {
                    if i != 0 && matches!(node, Node::Root(_) | Node::List(_) | Node::Blockquote(_))
                    {
                        output.push('\n');
                    }
                    append_prose(child, output);
                }
            }
        }
    }
}
