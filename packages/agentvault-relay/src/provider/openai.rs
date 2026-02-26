use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

use super::{ProviderRequest, ProviderResponse};
use crate::error::RelayError;

const DEFAULT_BASE_URL: &str = "https://api.openai.com";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

const UNSUPPORTED_KEYWORDS: &[&str] =
    &["minimum", "maximum", "minItems", "maxItems", "uniqueItems"];

/// Recursively strips JSON Schema keywords unsupported by OpenAI strict mode.
fn strip_unsupported_keywords(value: &mut Value) {
    if let Some(obj) = value.as_object_mut() {
        obj.retain(|key, _| {
            !UNSUPPORTED_KEYWORDS.contains(&key.as_str()) && !key.starts_with("x-")
        });
        for child in obj.values_mut() {
            strip_unsupported_keywords(child);
        }
    } else if let Some(arr) = value.as_array_mut() {
        for item in arr {
            strip_unsupported_keywords(item);
        }
    }
}

/// Recursively adds `"additionalProperties": false` to all objects in a JSON Schema.
/// OpenAI strict mode requires this on every nested object.
fn ensure_strict_schema(value: &mut Value) {
    if let Some(obj) = value.as_object_mut() {
        if obj.get("type").and_then(|v| v.as_str()) == Some("object") {
            obj.entry("additionalProperties")
                .or_insert(Value::Bool(false));
        }
        // Recurse into properties
        if let Some(props) = obj.get_mut("properties") {
            if let Some(props_obj) = props.as_object_mut() {
                for child in props_obj.values_mut() {
                    ensure_strict_schema(child);
                }
            }
        }
        // Recurse into items (arrays)
        if let Some(items) = obj.get_mut("items") {
            ensure_strict_schema(items);
        }
    }
}

pub struct OpenAIProvider {
    client: Client,
    api_key: String,
    model_id: String,
    base_url: String,
}

impl OpenAIProvider {
    pub fn new(
        api_key: String,
        model_id: String,
        base_url: Option<String>,
    ) -> Result<Self, RelayError> {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| RelayError::Internal(format!("failed to build HTTP client: {e}")))?;

        Ok(Self {
            client,
            api_key,
            model_id,
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
        })
    }

    pub async fn call(&self, request: ProviderRequest) -> Result<ProviderResponse, RelayError> {
        let messages = vec![
            serde_json::json!({ "role": "system", "content": request.system }),
            serde_json::json!({ "role": "user", "content": request.user_message }),
        ];

        let mut body = serde_json::json!({
            "model": self.model_id,
            "max_completion_tokens": request.max_tokens,
            "temperature": 0.0,
            "messages": messages,
        });

        if let Some(ref schema) = request.output_schema {
            let mut strict_schema = schema.clone();
            strip_unsupported_keywords(&mut strict_schema);
            ensure_strict_schema(&mut strict_schema);
            body.as_object_mut().unwrap().insert(
                "response_format".to_string(),
                serde_json::json!({
                    "type": "json_schema",
                    "json_schema": {
                        "name": "relay_output",
                        "strict": true,
                        "schema": strict_schema
                    }
                }),
            );
        }

        let url = format!("{}/v1/chat/completions", self.base_url);
        let response = self
            .client
            .post(&url)
            .header("authorization", format!("Bearer {}", self.api_key))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    RelayError::Provider("OpenAI API request timed out".to_string())
                } else if e.is_connect() {
                    RelayError::Provider("OpenAI API connection failed".to_string())
                } else {
                    RelayError::Provider(format!("OpenAI API request failed: {e}"))
                }
            })?;

        let status = response.status();
        let response_text = response
            .text()
            .await
            .map_err(|e| RelayError::Provider(format!("failed to read response body: {e}")))?;

        if !status.is_success() {
            tracing::debug!(status = %status, "OpenAI API error");
            return Err(match status.as_u16() {
                401 | 403 => RelayError::Provider("OpenAI API authentication error".to_string()),
                429 => RelayError::Provider("OpenAI API rate limited".to_string()),
                500..=599 => RelayError::Provider("OpenAI API server error".to_string()),
                _ => RelayError::Provider(format!("OpenAI API error: {status}")),
            });
        }

        let response_json: Value = serde_json::from_str(&response_text)
            .map_err(|e| RelayError::Provider(format!("failed to parse API response: {e}")))?;

        let text = extract_text(&response_json)?;
        let model_id = response_json
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or(&self.model_id)
            .to_string();
        let stop_reason = response_json
            .get("choices")
            .and_then(|v| v.get(0))
            .and_then(|v| v.get("finish_reason"))
            .and_then(|v| v.as_str())
            .unwrap_or("stop")
            .to_string();

        Ok(ProviderResponse {
            text,
            model_id,
            stop_reason,
        })
    }
}

fn extract_text(response: &Value) -> Result<String, RelayError> {
    let choice = response
        .get("choices")
        .and_then(|v| v.get(0))
        .ok_or_else(|| RelayError::Provider("response missing choices".to_string()))?;

    let content = choice
        .get("message")
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| RelayError::Provider("choice missing message content".to_string()))?;

    Ok(content.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_text_success() {
        let response = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "{\"decision\":\"PROCEED\"}"
                },
                "finish_reason": "stop"
            }],
            "model": "gpt-4o-2024-08-06"
        });

        let text = extract_text(&response).unwrap();
        assert_eq!(text, "{\"decision\":\"PROCEED\"}");
    }

    #[test]
    fn test_extract_text_missing_choices() {
        let response = serde_json::json!({"id": "chatcmpl-123"});
        assert!(extract_text(&response).is_err());
    }

    #[test]
    fn test_extract_text_no_content() {
        let response = serde_json::json!({
            "choices": [{
                "message": {},
                "finish_reason": "stop"
            }]
        });
        assert!(extract_text(&response).is_err());
    }

    #[test]
    fn test_strip_unsupported_keywords() {
        let mut schema = serde_json::json!({
            "type": "object",
            "properties": {
                "count": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 100,
                    "description": "A count"
                },
                "items": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["A", "B"] },
                    "minItems": 0,
                    "maxItems": 3,
                    "uniqueItems": true,
                    "x-vcav-entropy-bits-upper-bound": 8
                }
            }
        });

        strip_unsupported_keywords(&mut schema);

        assert!(schema["properties"]["count"].get("minimum").is_none());
        assert!(schema["properties"]["count"].get("maximum").is_none());
        assert_eq!(schema["properties"]["count"]["type"], "integer");
        assert_eq!(schema["properties"]["count"]["description"], "A count");
        // Array keywords and x- extensions stripped
        assert!(schema["properties"]["items"].get("minItems").is_none());
        assert!(schema["properties"]["items"].get("maxItems").is_none());
        assert!(schema["properties"]["items"].get("uniqueItems").is_none());
        assert!(schema["properties"]["items"]
            .get("x-vcav-entropy-bits-upper-bound")
            .is_none());
        // Core fields preserved
        assert_eq!(schema["properties"]["items"]["type"], "array");
    }

    #[test]
    fn test_ensure_strict_schema() {
        let mut schema = serde_json::json!({
            "type": "object",
            "properties": {
                "nested": {
                    "type": "object",
                    "properties": {
                        "value": { "type": "string" }
                    }
                },
                "list": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string" }
                        }
                    }
                }
            },
            "additionalProperties": false
        });

        ensure_strict_schema(&mut schema);

        // Top-level already had it
        assert_eq!(schema["additionalProperties"], false);
        // Nested object should now have it
        assert_eq!(
            schema["properties"]["nested"]["additionalProperties"],
            false
        );
        // Array item object should now have it
        assert_eq!(
            schema["properties"]["list"]["items"]["additionalProperties"],
            false
        );
    }
}
