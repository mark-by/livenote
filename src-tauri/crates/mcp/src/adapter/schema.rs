use serde_json::{Map, Value};

pub(super) const fn kind(value: Option<&Value>) -> &'static str {
    match value {
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
        None => "undefined",
    }
}

pub(super) fn parse(
    schema: &Value,
    input: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let mut issues = Vec::new();
    let arguments = Validator(&mut issues).object((schema, ""), input);
    if issues.is_empty() {
        Ok(arguments)
    } else {
        Err(issues.join("\n"))
    }
}

struct Validator<'a>(&'a mut Vec<String>);

impl Validator<'_> {
    fn object(
        &mut self,
        field: (&Value, &str),
        mut input: Map<String, Value>,
    ) -> Map<String, Value> {
        let (schema, path) = field;
        let mut output = Map::new();
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            for (key, field) in properties {
                let field_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                if let Some(value) = input.swap_remove(key) {
                    if let Some(value) = self.normalize((field, &field_path), value) {
                        output.insert(key.clone(), value);
                    }
                } else if let Some(default) = field.get("default") {
                    output.insert(key.clone(), default.clone());
                } else if schema
                    .get("required")
                    .and_then(Value::as_array)
                    .is_some_and(|keys| keys.iter().any(|value| value.as_str() == Some(key)))
                {
                    self.0.push(format!("Required at {field_path}"));
                }
            }
        }
        output
    }

    // Обрабатывает подмножество JSON Schema, которое публикуют инструменты LiveNote.
    // Как Zod, удаляет неизвестные поля вместо отказа при additionalProperties: false.
    fn normalize(&mut self, field: (&Value, &str), value: Value) -> Option<Value> {
        let (schema, path) = field;
        let actual = kind(Some(&value));
        let specification = schema.get("type")?;
        if let Some(choices) = schema.get("enum").and_then(Value::as_array) {
            if choices.contains(&value) {
                return Some(value);
            }
            let options = choices
                .iter()
                .filter_map(Value::as_str)
                .map(|choice| format!("'{choice}'"))
                .collect::<Vec<_>>()
                .join(" | ");
            let issue = match value {
                Value::String(text) => {
                    format!("Invalid enum value. Expected {options}, received '{text}'")
                }
                _ => format!("Expected {options}, received {actual}"),
            };
            self.0.push(format!("{issue} at {path}"));
            return None;
        }
        if let Value::Array(types) = specification {
            if types.iter().any(|allowed| allowed.as_str() == Some(actual)) {
                return Some(value);
            }
            self.0
                .push(format!("Expected string, received {actual} at {path}"));
            return None;
        }
        let expected = specification.as_str()?;
        match (expected, value) {
            ("object", Value::Object(fields)) => {
                Some(Value::Object(self.object((schema, path), fields)))
            }
            ("array", Value::Array(items)) => {
                let item_schema = schema.get("items")?;
                let normalized = items.into_iter().enumerate().filter_map(|(index, item)| {
                    self.normalize((item_schema, &format!("{path}[{index}]")), item)
                });
                Some(Value::Array(normalized.collect()))
            }
            ("integer", Value::Number(number)) => {
                if let Some(float) = number.as_f64() {
                    if float.fract() != 0.0 {
                        self.0
                            .push(format!("Expected integer, received float at {path}"));
                        return None;
                    }
                    if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64)
                        && float < minimum
                    {
                        self.0.push(format!(
                            "Number must be greater than or equal to {minimum} at {path}"
                        ));
                        return None;
                    }
                    if number.is_f64()
                        && let Ok(integer) = float.to_string().parse::<serde_json::Number>()
                    {
                        return Some(Value::Number(integer));
                    }
                }
                Some(Value::Number(number))
            }
            ("string" | "boolean", value) if expected == actual => Some(value),
            (_, _) => {
                let expected = if expected == "integer" {
                    "number"
                } else {
                    expected
                };
                self.0
                    .push(format!("Expected {expected}, received {actual} at {path}"));
                None
            }
        }
    }
}
