use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

use super::{ProviderRequest, ProviderResponse};
use crate::error::RelayError;

const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

const UNSUPPORTED_KEYWORDS: &[&str] = &[
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "uniqueItems",
    "additionalProperties",
];

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

pub struct GeminiProvider {
    client: Client,
    api_key: String,
    model_id: String,
    base_url: String,
}

impl GeminiProvider {
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
        let mut body = serde_json::json!({
            "systemInstruction": {
                "parts": [{ "text": request.system }]
            },
            "contents": [{
                "role": "user",
                "parts": [{ "text": request.user_message }]
            }],
            "generationConfig": {
                "maxOutputTokens": request.max_tokens,
                "temperature": 0.0,
            }
        });

        if let Some(ref schema) = request.output_schema {
            let mut cleaned = schema.clone();
            strip_unsupported_keywords(&mut cleaned);
            let gen_config = body
                .get_mut("generationConfig")
                .and_then(|v| v.as_object_mut())
                .unwrap();
            gen_config.insert(
                "responseMimeType".to_string(),
                Value::String("application/json".to_string()),
            );
            gen_config.insert("responseSchema".to_string(), cleaned);
        }

        let url = format!(
            "{}/v1beta/models/{}:generateContent?key={}",
            self.base_url, self.model_id, self.api_key
        );
        let response = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    RelayError::Provider("Gemini API request timed out".to_string())
                } else if e.is_connect() {
                    RelayError::Provider("Gemini API connection failed".to_string())
                } else {
                    RelayError::Provider(format!("Gemini API request failed: {e}"))
                }
            })?;

        let status = response.status();
        let response_text = response
            .text()
            .await
            .map_err(|e| RelayError::Provider(format!("failed to read response body: {e}")))?;

        if !status.is_success() {
            tracing::debug!(status = %status, body = %response_text, "Gemini API error");
            return Err(match status.as_u16() {
                401 | 403 => RelayError::Provider("Gemini API authentication error".to_string()),
                429 => RelayError::Provider("Gemini API rate limited".to_string()),
                500..=599 => RelayError::Provider("Gemini API server error".to_string()),
                _ => RelayError::Provider(format!("Gemini API error: {status}")),
            });
        }

        let response_json: Value = serde_json::from_str(&response_text)
            .map_err(|e| RelayError::Provider(format!("failed to parse API response: {e}")))?;

        let text = extract_text(&response_json)?;
        let model_id = response_json
            .get("modelVersion")
            .and_then(|v| v.as_str())
            .unwrap_or(&self.model_id)
            .to_string();
        let stop_reason = response_json
            .get("candidates")
            .and_then(|v| v.get(0))
            .and_then(|v| v.get("finishReason"))
            .and_then(|v| v.as_str())
            .unwrap_or("STOP")
            .to_string();

        Ok(ProviderResponse {
            text,
            model_id,
            stop_reason,
        })
    }
}

fn extract_text(response: &Value) -> Result<String, RelayError> {
    let candidate = response
        .get("candidates")
        .and_then(|v| v.get(0))
        .ok_or_else(|| RelayError::Provider("response missing candidates".to_string()))?;

    let parts = candidate
        .get("content")
        .and_then(|v| v.get("parts"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| RelayError::Provider("candidate missing content parts".to_string()))?;

    for part in parts {
        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
            return Ok(text.to_string());
        }
    }

    Err(RelayError::Provider("no text part in response".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_unsupported_keywords() {
        let mut schema = serde_json::json!({
            "type": "object",
            "additionalProperties": false,
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

        assert!(schema.get("additionalProperties").is_none());
        assert!(schema["properties"]["count"].get("minimum").is_none());
        assert!(schema["properties"]["count"].get("maximum").is_none());
        assert_eq!(schema["properties"]["count"]["type"], "integer");
        assert_eq!(schema["properties"]["count"]["description"], "A count");
    }

    #[test]
    fn test_extract_text_success() {
        let response = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{ "text": "{\"decision\":\"PROCEED\"}" }]
                },
                "finishReason": "STOP"
            }],
            "modelVersion": "gemini-2.5-flash-001"
        });

        let text = extract_text(&response).unwrap();
        assert_eq!(text, "{\"decision\":\"PROCEED\"}");
    }

    #[test]
    fn test_extract_text_missing_candidates() {
        let response = serde_json::json!({"usageMetadata": {}});
        assert!(extract_text(&response).is_err());
    }

    #[test]
    fn test_extract_text_no_text_part() {
        let response = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{ "functionCall": {"name": "foo", "args": {}} }]
                }
            }]
        });
        assert!(extract_text(&response).is_err());
    }
}
