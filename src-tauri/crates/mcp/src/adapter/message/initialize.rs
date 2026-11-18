use serde_json::{Map, Value};

use super::{Method, expect_kind, invalid_params};

pub(super) fn parse(params: &mut Map<String, Value>, issues: &mut Vec<Value>) -> Method {
    let version = params.swap_remove("protocolVersion");
    expect_kind(
        issues,
        (&["params", "protocolVersion"], "string"),
        version.as_ref(),
    );
    let capabilities = params.get("capabilities");
    expect_kind(
        issues,
        (&["params", "capabilities"], "object"),
        capabilities,
    );
    if let Some(capabilities) = capabilities.and_then(Value::as_object) {
        for field in ["experimental", "sampling", "elicitation", "roots", "tasks"] {
            if let Some(value) = capabilities.get(field) {
                expect_kind(
                    issues,
                    (&["params", "capabilities", field], "object"),
                    Some(value),
                );
            }
        }
        if let Some(value) = capabilities
            .get("roots")
            .and_then(|roots| roots.get("listChanged"))
        {
            expect_kind(
                issues,
                (
                    &["params", "capabilities", "roots", "listChanged"],
                    "boolean",
                ),
                Some(value),
            );
        }
    }
    let client = params.get("clientInfo");
    expect_kind(issues, (&["params", "clientInfo"], "object"), client);
    if let Some(client) = client.and_then(Value::as_object) {
        for field in ["name", "version"] {
            expect_kind(
                issues,
                (&["params", "clientInfo", field], "string"),
                client.get(field),
            );
        }
        for field in ["title", "description", "websiteUrl"] {
            if let Some(value) = client.get(field) {
                expect_kind(
                    issues,
                    (&["params", "clientInfo", field], "string"),
                    Some(value),
                );
            }
        }
        if let Some(icons) = client.get("icons") {
            expect_kind(
                issues,
                (&["params", "clientInfo", "icons"], "array"),
                Some(icons),
            );
        }
    }
    match version {
        Some(Value::String(version)) => Method::Initialize(version),
        _ => invalid_params(issues),
    }
}
