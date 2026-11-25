use std::{borrow::Cow, collections::BTreeMap, io::Read, ops::Range};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use flate2::read::DeflateDecoder;
use percent_encoding::percent_decode_str;
use roxmltree::{Document, Node};

use crate::{
    ApiError, args,
    diagram::{Validator, invalid},
};

use super::{DiagramFormat, Layout, text};
use livenote_diagrams::ValidationStatus;

pub(super) struct Check {
    pub path: String,
    pub format: DiagramFormat,
    pub next: String,
    pub previous: Option<String>,
    pub drawio_page: Option<String>,
    pub layout: Layout,
}

impl Check {
    pub async fn validate(&self, validator: &Validator) -> Result<Option<String>, ApiError> {
        if let Some(previous) = self.previous.as_deref().filter(|old| *old != self.next) {
            match self.format {
                DiagramFormat::Drawio => {
                    preserve_drawio(previous, &self.next, self.drawio_page.as_deref())?
                }
                DiagramFormat::Bpmn => preserve_bpmn(previous, &self.next)?,
                DiagramFormat::Mermaid => preserve_mermaid(validator, previous, &self.next).await?,
            }
        }
        let layout = match self.layout {
            Layout::Preserve => args::Layout::Preserve,
            Layout::Auto => args::Layout::Auto,
        };
        let (source, validation) = validator.validate(self.format, &self.next, layout).await;
        if validation.syntax != ValidationStatus::Ok {
            return Err(invalid(&self.path, Some(&validation)));
        }
        if let Some(source) = &source {
            text::check_size(source.len())?;
        }
        Ok(source)
    }
}

fn cannot_preserve() -> ApiError {
    ApiError::new(
        422,
        "diagram_invalid",
        "Не удалось подтвердить сохранение элементов, связей и геометрии",
    )
}

fn xml(source: &str) -> Result<Document<'_>, ApiError> {
    Document::parse_with_options(
        source,
        roxmltree::ParsingOptions {
            nodes_limit: 100_000,
            ..roxmltree::ParsingOptions::default()
        },
    )
    .map_err(|_| cannot_preserve())
}

fn drawio_page<'a, 'input>(
    root: Node<'a, 'input>,
    id: Option<&str>,
) -> Result<Node<'a, 'input>, ApiError> {
    let pages = || root.children().filter(|node| node.has_tag_name("diagram"));
    match id {
        Some(id) => pages().find(|node| node.attribute("id") == Some(id)),
        None => pages().next(),
    }
    .ok_or_else(cannot_preserve)
}

pub(super) fn expand_drawio<'a>(
    source: &'a str,
    id: Option<&str>,
) -> Result<Cow<'a, str>, ApiError> {
    let doc = xml(source)?;
    let root = doc.root_element();
    if root.has_tag_name("mxGraphModel") {
        if id.is_some() {
            return Err(cannot_preserve());
        }
        return Ok(Cow::Borrowed(source));
    }
    let page = drawio_page(root, id)?;
    if page.children().any(|node| node.is_element()) {
        return Ok(Cow::Borrowed(source));
    }
    let Some(range) = compressed_range(page)? else {
        return Ok(Cow::Borrowed(source));
    };
    let encoded = source
        .get(range.clone())
        .ok_or_else(cannot_preserve)?
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    let raw = STANDARD.decode(encoded).map_err(|_| cannot_preserve())?;
    let mut uri = String::new();
    DeflateDecoder::new(raw.as_slice())
        .take(u64::try_from(text::MAX_SOURCE).map_err(ApiError::internal)? + 1)
        .read_to_string(&mut uri)
        .map_err(|_| cannot_preserve())?;
    text::check_size(uri.len())?;
    let decoded = percent_decode_str(&uri)
        .decode_utf8()
        .map_err(|_| cannot_preserve())?;
    if !xml(&decoded)?.root_element().has_tag_name("mxGraphModel") {
        return Err(cannot_preserve());
    }
    let mut expanded = source.to_owned();
    expanded.replace_range(range, &decoded);
    text::check_size(expanded.len())?;
    Ok(Cow::Owned(expanded))
}

fn compressed_range(page: Node<'_, '_>) -> Result<Option<Range<usize>>, ApiError> {
    let mut parts = page.children().filter(|node| node.is_text());
    let Some(part) = parts.next() else {
        return Ok(None);
    };
    if parts.next().is_some() {
        return Err(cannot_preserve());
    }
    Ok(part
        .text()
        .filter(|text| !text.trim().is_empty())
        .map(|_| part.range()))
}

fn preserve_drawio(before: &str, after: &str, page_id: Option<&str>) -> Result<(), ApiError> {
    let before = expand_drawio(before, page_id)?;
    let after = expand_drawio(after, page_id)?;
    let old_doc = xml(&before)?;
    let next_doc = xml(&after)?;
    let old = old_doc.root_element();
    let next = next_doc.root_element();
    if tag(old) != tag(next) || attrs(old, &[]) != attrs(next, &[]) {
        return Err(cannot_preserve());
    }
    let (old, next) = if old.has_tag_name("mxGraphModel") {
        (old, next)
    } else {
        let old_page = drawio_page(old, page_id)?;
        let next_page = drawio_page(next, page_id)?;
        let other_pages = |doc: Node<'_, '_>, skip: Node<'_, '_>, source: &str| {
            doc.children()
                .filter(|node| node.is_element() && node.range() != skip.range())
                .filter_map(|node| source.get(node.range()).map(str::to_owned))
                .collect::<Vec<_>>()
        };
        if old_page.prev_siblings().filter(Node::is_element).count()
            != next_page.prev_siblings().filter(Node::is_element).count()
            || attrs(old_page, &[]) != attrs(next_page, &[])
            || other_pages(old, old_page, &before) != other_pages(next, next_page, &after)
        {
            return Err(cannot_preserve());
        }
        (
            old_page.first_element_child().ok_or_else(cannot_preserve)?,
            next_page
                .first_element_child()
                .ok_or_else(cannot_preserve)?,
        )
    };
    if attrs(old, &[]) != attrs(next, &[]) {
        return Err(cannot_preserve());
    }
    let old = drawio_cells(old)?;
    let next = drawio_cells(next)?;
    subset(&old, &next)
}

fn drawio_cells(model: Node<'_, '_>) -> Result<BTreeMap<String, String>, ApiError> {
    let root = model
        .first_element_child()
        .filter(|node| node.has_tag_name("root"))
        .ok_or_else(cannot_preserve)?;
    keyed(root.children().filter(Node::is_element).map(|wrapper| {
        let cell = if wrapper.has_tag_name("mxCell") {
            wrapper
        } else {
            wrapper
                .first_element_child()
                .filter(|node| node.has_tag_name("mxCell"))
                .ok_or_else(cannot_preserve)?
        };
        let id = wrapper
            .attribute("id")
            .or_else(|| cell.attribute("id"))
            .ok_or_else(cannot_preserve)?;
        let signature = format!(
            "{:?}{:?}{:?}",
            tag(wrapper),
            attrs(cell, &["value"]),
            canonical(cell)
        );
        Ok((id.to_owned(), signature))
    }))
}

fn preserve_bpmn(before: &str, after: &str) -> Result<(), ApiError> {
    const BPMNDI: &str = "http://www.omg.org/spec/BPMN/20100524/DI";
    let before = xml(before)?;
    let after = xml(after)?;
    let bpmn = |doc: &Document<'_>| {
        keyed(doc.descendants().filter_map(|node| {
            let id = node.attribute("id")?;
            let parent = node
                .ancestors()
                .skip(1)
                .find_map(|item| item.attribute("id"));
            let data = match (node.tag_name().namespace(), node.tag_name().name()) {
                (Some(BPMNDI), "BPMNShape" | "BPMNEdge") => canonical(node),
                _ => format!("{:?}:{:?}", tag(node), attrs(node, &["name"])),
            };
            Some(Ok((id.to_owned(), format!("{parent:?}:{data}"))))
        }))
    };
    subset(&bpmn(&before)?, &bpmn(&after)?)
}

fn keyed(
    input: impl Iterator<Item = Result<(String, String), ApiError>>,
) -> Result<BTreeMap<String, String>, ApiError> {
    let mut values = BTreeMap::new();
    for entry in input {
        let (id, value) = entry?;
        if values.insert(id, value).is_some() {
            return Err(cannot_preserve());
        }
    }
    Ok(values)
}

fn subset(old: &BTreeMap<String, String>, next: &BTreeMap<String, String>) -> Result<(), ApiError> {
    if old.iter().all(|(id, value)| next.get(id) == Some(value)) {
        Ok(())
    } else {
        Err(cannot_preserve())
    }
}

fn tag<'a>(node: Node<'a, '_>) -> (Option<&'a str>, &'a str) {
    (node.tag_name().namespace(), node.tag_name().name())
}

fn attrs<'a, 'input>(
    node: Node<'a, 'input>,
    except: &[&str],
) -> Vec<(Option<&'a str>, &'a str, &'a str)> {
    let mut attrs = node
        .attributes()
        .filter(|attr| attr.namespace().is_some() || !except.contains(&attr.name()))
        .map(|attr| (attr.namespace(), attr.name(), attr.value()))
        .collect::<Vec<_>>();
    attrs.sort_unstable();
    attrs
}

fn canonical(node: Node<'_, '_>) -> String {
    // Не используем рекурсию: глубина XML зависит от входных данных.
    format!(
        "{:?}",
        node.descendants()
            .filter(Node::is_element)
            .map(|child| {
                let ignored = if child == node && child.has_tag_name("mxCell") {
                    &["value"][..]
                } else {
                    &[]
                };
                (
                    tag(child),
                    attrs(child, ignored),
                    child
                        .ancestors()
                        .skip(1)
                        .take_while(|ancestor| *ancestor != node)
                        .count(),
                )
            })
            .collect::<Vec<_>>()
    )
}

async fn preserve_mermaid(
    validator: &Validator,
    before: &str,
    after: &str,
) -> Result<(), ApiError> {
    let old = validator
        .engine
        .render(DiagramFormat::Mermaid, before, validator.theme, false)
        .await;
    let next = validator
        .engine
        .render(DiagramFormat::Mermaid, after, validator.theme, false)
        .await;
    let old = old.render.ok_or_else(cannot_preserve)?;
    let next = next.render.ok_or_else(cannot_preserve)?;
    if svg_signature(&old.svg)? != svg_signature(&next.svg)? {
        return Err(cannot_preserve());
    }
    Ok(())
}

fn svg_signature(source: &str) -> Result<Vec<String>, ApiError> {
    let doc = xml(source)?;
    let root = doc.root_element();
    let render_id = root.attribute("id").ok_or_else(cannot_preserve)?;
    let geometry = root
        .descendants()
        .filter(|node| {
            node.is_element() && !node.ancestors().any(|item| item.has_tag_name("style"))
        })
        .map(|node| {
            let attrs = attrs(node, &[]);
            format!("{:?}:{:?}:{}", tag(node), attrs, node.ancestors().count())
                .replace(render_id, "mermaid")
        })
        .collect::<Vec<_>>();
    if geometry.len() < 2 {
        return Err(cannot_preserve());
    }
    Ok(geometry)
}
