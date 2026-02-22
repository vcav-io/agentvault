use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

use crate::error::RelayError;
use super::{ProviderRequest, ProviderResponse};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const ANTHROPIC_VERSION: &str = "2023-06-01";

const UNSUPPORTED_KEYWORDS: &[&str] = &["minimum", "maximum"];

fn strip_unsupported_keywords(value: &mut Value) {
    if let Some(obj) = value.as_object_mut() {
        obj.retain(|key, _| !UNSUPPORTED_KEYWORDS.contains(&key.as_str()));
        for child in obj.values_mut() {
            strip_unsupported_keywords(child);
        }
    } else if let Some(arr) = value.as_array_mut() {
        for item in arr {
            strip_unsupported_keywords(item);
        }
    }
}

pub struct AnthropicProvider {
    client: Client,
    api_key: String,
    model_id: String,
    base_url: String,
}

impl AnthropicProvider {
    pub fn new(api_key: String, model_id: String, base_url: Option<String>) -> Result<Self, RelayError> {
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
        let mut body = serde_json::json!({
            "model": self.model_id,
            "max_tokens": request.max_tokens,
            "temperature": 0.0,
            "system": request.system,
            "messages": [{ "role": "user", "content": request.user_message }],
        });

        if let Some(ref schema) = request.output_schema {
            let mut cleaned = schema.clone();
            strip_unsupported_keywords(&mut cleaned);
            body.as_object_mut().unwrap().insert(
                "output_config".to_string(),
                serde_json::json!({
                    "format": {
                        "type": "json_schema",
                        "schema": cleaned
                    }
                }),
            );
        }

        let url = format!("{}/v1/messages", self.base_url);
        let response = self
            .client
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    RelayError::Provider("Anthropic API request timed out".to_string())
                } else if e.is_connect() {
                    RelayError::Provider("Anthropic API connection failed".to_string())
                } else {
                    RelayError::Provider(format!("Anthropic API request failed: {e}"))
                }
            })?;

        let status = response.status();
        let response_text = response
            .text()
            .await
            .map_err(|e| RelayError::Provider(format!("failed to read response body: {e}")))?;

        if !status.is_success() {
            tracing::debug!(status = %status, "Anthropic API error");
            return Err(match status.as_u16() {
                401 | 403 => RelayError::Provider("Anthropic API authentication error".to_string()),
                429 => RelayError::Provider("Anthropic API rate limited".to_string()),
                500..=599 => RelayError::Provider("Anthropic API server error".to_string()),
                _ => RelayError::Provider(format!("Anthropic API error: {status}")),
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
            .get("stop_reason")
            .and_then(|v| v.as_str())
            .unwrap_or("end_turn")
            .to_string();

        Ok(ProviderResponse {
            text,
            model_id,
            stop_reason,
        })
    }
}

fn extract_text(response: &Value) -> Result<String, RelayError> {
    let content_array = response
        .get("content")
        .and_then(|v| v.as_array())
        .ok_or_else(|| RelayError::Provider("response missing content".to_string()))?;

    for content_block in content_array {
        let block_type = content_block
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if block_type == "text" {
            let text = content_block
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RelayError::Provider("text block missing text".to_string()))?;
            return Ok(text.to_string());
        }
    }

    Err(RelayError::Provider("no text block in response".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

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
                }
            }
        });

        strip_unsupported_keywords(&mut schema);

        assert!(schema["properties"]["count"].get("minimum").is_none());
        assert!(schema["properties"]["count"].get("maximum").is_none());
        assert_eq!(schema["properties"]["count"]["type"], "integer");
        assert_eq!(schema["properties"]["count"]["description"], "A count");
    }

    #[test]
    fn test_extract_text_success() {
        let response = serde_json::json!({
            "content": [{
                "type": "text",
                "text": "{\"decision\":\"PROCEED\"}"
            }],
            "model": "claude-sonnet-4-5-20250929",
            "stop_reason": "end_turn"
        });

        let text = extract_text(&response).unwrap();
        assert_eq!(text, "{\"decision\":\"PROCEED\"}");
    }

    #[test]
    fn test_extract_text_missing_content() {
        let response = serde_json::json!({"id": "msg_123"});
        assert!(extract_text(&response).is_err());
    }

    #[test]
    fn test_extract_text_no_text_block() {
        let response = serde_json::json!({
            "content": [{
                "type": "tool_use",
                "id": "t1",
                "name": "tool",
                "input": {}
            }]
        });
        assert!(extract_text(&response).is_err());
    }
}
