pub mod anthropic;
pub mod openai;

pub struct ProviderRequest {
    pub system: String,
    pub user_message: String,
    pub output_schema: Option<serde_json::Value>,
    pub max_tokens: u32,
}

pub struct ProviderResponse {
    pub text: String,
    pub model_id: String,
    #[allow(dead_code)]
    pub stop_reason: String,
}
