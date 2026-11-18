use crate::{
    ApiError, Output, args,
    edit::renamed,
    service::{decode, require_version},
    state::State,
    tree::Move,
};
use serde_json::Value;
pub fn immediate(state: &mut State, op: &str, args: Value) -> Result<Output, ApiError> {
    match op {
        "get_vault" => Output::json(state.snapshot()),
        "list_pages" => Output::json(state.snapshot().pages),
        "get_page" | "get_document" | "export_page" => {
            let args::PathArg { path } = decode(args)?;
            let document = state.require(&path)?.document();
            match op {
                "get_page" => Output::json(state.render_fields(document).page),
                "get_document" => Output::json(state.render_fields(document)),
                _ => Ok(Output::Bytes(document.source.as_bytes().to_vec())),
            }
        }
        "export_vault" => state.export_archive().map(Output::Bytes),
        "search" => {
            let args::Search { q, tag } = decode(args)?;
            Output::json(
                state
                    .projection
                    .search(&q, tag.as_deref())
                    .map_err(|err| ApiError::invalid(err.to_string()))?,
            )
        }
        "create_folder" | "delete_folder" | "move_folder" | "move_document" | "patch_metadata" => {
            tree_action(state, op, args)
        }
        "update_page" => Output::json(state.update(decode(args)?, None)?),
        "delete_block" => {
            let args::Delete {
                page_id,
                expected,
                block_id,
            } = decode(args)?;
            let id = block_id.ok_or_else(|| ApiError::invalid("Требуется block_id"))?;
            let update = args::Update {
                page_id,
                expected,
                title: None,
                block_order: None,
                delete_block_ids: Some(vec![id.clone()]),
            };
            Output::json(state.update(update, Some(&id))?)
        }
        "delete_page" => {
            state.delete_page(&decode(args)?)?;
            Ok(Output::Empty)
        }
        "set_rendered" => {
            let args: args::Rendered = decode(args)?;
            let page = &state.require(&args.page_id)?.document().page;
            if page.revision == args.revision
                && page.blocks.iter().any(|block| block.id == args.block_id)
            {
                state
                    .renders
                    .entry(args.page_id.clone())
                    .or_default()
                    .insert(args.block_id.clone(), args);
            }
            Ok(Output::Empty)
        }
        _ => Err(ApiError::not_found("Операция не найдена")),
    }
}

fn tree_action(state: &mut State, op: &str, args: Value) -> Result<Output, ApiError> {
    match op {
        "create_folder" | "delete_folder" | "move_folder" => {
            let args::Folder {
                path,
                from,
                expected_tree_version,
                recursive,
            } = decode(args)?;
            match op {
                "create_folder" => {
                    Output::json(state.create_folder(&path, &expected_tree_version)?)
                }
                "delete_folder" => {
                    Output::json(state.delete_folder(&path, &expected_tree_version, recursive)?)
                }
                _ => {
                    let from = from.ok_or_else(|| ApiError::invalid("Требуется from"))?;
                    state
                        .move_path(
                            &from,
                            &path,
                            Move::Folder {
                                expected: &expected_tree_version,
                            },
                        )
                        .map(Output::Json)
                }
            }
        }
        "move_document" => {
            let args::MoveDocument { from, to, expected } = decode(args)?;
            require_version(&expected)?;
            state
                .move_path(
                    &from,
                    &to,
                    Move::Document {
                        expected: &expected,
                        source: None,
                    },
                )
                .map(Output::Json)
        }
        "patch_metadata" => {
            let args::Metadata {
                path,
                expected,
                title,
                aliases,
                tags,
            } = decode(args)?;
            require_version(&expected)?;
            if aliases.is_some() || tags.is_some() {
                return Err(ApiError::invalid(
                    "Редактируйте aliases в YAML и #теги в исходнике",
                ));
            }
            let title = title.ok_or_else(|| ApiError::invalid("Требуется title"))?;
            let next = renamed(&path, &title);
            state.move_path(
                &path,
                &next,
                Move::Document {
                    expected: &expected,
                    source: None,
                },
            )?;
            Output::json(state.render_fields(state.require(&next)?.document()))
        }
        _ => Err(ApiError::not_found("Операция не найдена")),
    }
}
