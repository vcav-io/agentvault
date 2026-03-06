use std::sync::Arc;
use std::time::Duration;

use ed25519_dalek::SigningKey;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use agentvault_relay::{
    agent_registry::AgentRegistry, build_router, enforcement_policy, inbox::InboxStore,
    session::SessionStore, AppState,
};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let anthropic_api_key = std::env::var("ANTHROPIC_API_KEY").ok();
    let model_id = std::env::var("AV_MODEL_ID").unwrap_or_else(|_| "claude-sonnet-4-6".to_string());
    let prompt_dir =
        std::env::var("AV_PROMPT_PROGRAM_DIR").unwrap_or_else(|_| "prompt_programs".to_string());
    let port: u16 = std::env::var("AV_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3100);

    let signing_key = match std::env::var("AV_SIGNING_KEY_HEX") {
        Ok(hex_str) => {
            let bytes = hex::decode(&hex_str).expect("AV_SIGNING_KEY_HEX must be valid hex");
            let bytes: [u8; 32] = bytes
                .try_into()
                .expect("AV_SIGNING_KEY_HEX must be exactly 64 hex characters (32 bytes)");
            let key = SigningKey::from_bytes(&bytes);
            tracing::info!(
                verifying_key_hex = %receipt_core::public_key_to_hex(&key.verifying_key()),
                "Loaded relay signing key from AV_SIGNING_KEY_HEX"
            );
            key
        }
        Err(_) => {
            let key = SigningKey::generate(&mut rand::thread_rng());
            tracing::warn!(
                verifying_key_hex = %receipt_core::public_key_to_hex(&key.verifying_key()),
                "No AV_SIGNING_KEY_HEX set — generated ephemeral signing key (receipts will not verify across restarts)"
            );
            key
        }
    };

    let anthropic_base_url = std::env::var("ANTHROPIC_BASE_URL").ok();

    let openai_api_key = std::env::var("OPENAI_API_KEY").ok();
    let openai_model_id =
        std::env::var("AV_OPENAI_MODEL_ID").unwrap_or_else(|_| "gpt-4o".to_string());
    let openai_base_url = std::env::var("OPENAI_BASE_URL").ok();

    let gemini_api_key = std::env::var("GEMINI_API_KEY").ok();
    let gemini_model_id =
        std::env::var("AV_GEMINI_MODEL_ID").unwrap_or_else(|_| "gemini-2.5-flash".to_string());
    let gemini_base_url = std::env::var("GEMINI_BASE_URL").ok();

    // Validate model profile lockfile before binding to port.
    // Exits with a non-zero code on hash mismatch.
    if let Err(e) = agentvault_relay::prompt_program::validate_model_profile_lockfile(&prompt_dir) {
        tracing::error!(error = %e, "model profile lockfile validation failed — refusing to start");
        std::process::exit(1);
    }

    // Load and validate enforcement policy. Fail-closed: missing lockfile = startup failure.
    let relay_policies_dir = std::path::Path::new(&prompt_dir)
        .join("relay_policies")
        .to_string_lossy()
        .into_owned();

    // Check dev skip flags before loading — validate_enforcement_lockfile returns Ok(()) when
    // both flags are set, but the subsequent load calls would still fail without the lockfile.
    let lockfile_skip = std::env::var("AV_ENFORCEMENT_LOCKFILE_SKIP")
        .map(|v| v == "1")
        .unwrap_or(false);
    let is_dev_for_lockfile = std::env::var("AV_ENV").map(|v| v == "dev").unwrap_or(false);
    let skip_enforcement = lockfile_skip && is_dev_for_lockfile;

    let policy_registry = if skip_enforcement {
        tracing::warn!(
            "AV_ENFORCEMENT_LOCKFILE_SKIP=1 + AV_ENV=dev — skipping enforcement policy (dev mode only)"
        );
        enforcement_policy::PolicyRegistry::dev_skip()
    } else {
        if let Err(e) = enforcement_policy::validate_enforcement_lockfile(&relay_policies_dir) {
            tracing::error!(error = %e, "enforcement policy lockfile validation failed — refusing to start");
            std::process::exit(1);
        }

        let lockfile_entries = match enforcement_policy::load_lockfile_entries(&relay_policies_dir)
        {
            Ok(entries) => entries,
            Err(e) => {
                tracing::error!(error = %e, "failed to read enforcement policy lockfile — refusing to start");
                std::process::exit(1);
            }
        };

        let policies = match enforcement_policy::load_all_policies(
            &relay_policies_dir,
            &lockfile_entries,
        ) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(error = %e, "failed to load enforcement policies — refusing to start");
                std::process::exit(1);
            }
        };

        // Determine default hash
        let default_hash = match std::env::var("AV_DEFAULT_POLICY_HASH") {
            Ok(configured_hash) => {
                if !policies.contains_key(&configured_hash) {
                    tracing::error!(
                        configured_hash = %configured_hash,
                        available = ?policies.keys().collect::<Vec<_>>(),
                        "configured AV_DEFAULT_POLICY_HASH is not present in lockfile-verified policy set"
                    );
                    std::process::exit(1);
                }
                configured_hash
            }
            Err(_) if policies.len() == 1 => policies.keys().next().unwrap().clone(),
            Err(_) => {
                tracing::error!(
                    count = policies.len(),
                    "AV_DEFAULT_POLICY_HASH is required when multiple enforcement policies are loaded"
                );
                std::process::exit(1);
            }
        };

        match enforcement_policy::PolicyRegistry::new(policies, default_hash) {
            Ok(registry) => {
                tracing::info!(
                    count = registry.len(),
                    default = %registry.default_policy().hash,
                    hashes = ?registry.hashes(),
                    "Enforcement policy registry loaded"
                );
                registry
            }
            Err(e) => {
                tracing::error!(error = %e, "failed to construct policy registry — refusing to start");
                std::process::exit(1);
            }
        }
    };

    let session_ttl_secs: u64 = std::env::var("AV_SESSION_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let session_store = SessionStore::new(Duration::from_secs(session_ttl_secs));

    // Start background session reaper
    session_store.clone().start_reaper();

    // Load agent registry for inbox auth.
    // Fail-closed: missing file = startup failure unless AV_INBOX_AUTH=off + AV_ENV=dev.
    let inbox_auth_off = std::env::var("AV_INBOX_AUTH")
        .map(|v| v == "off")
        .unwrap_or(false);
    let is_dev = std::env::var("AV_ENV").map(|v| v == "dev").unwrap_or(false);
    if inbox_auth_off && !is_dev {
        tracing::error!(
            "AV_INBOX_AUTH=off requires AV_ENV=dev — refusing to start. \
             This is a safety check to prevent accidentally disabling inbox auth in production."
        );
        std::process::exit(1);
    }
    let agent_registry_path = std::env::var("AV_AGENT_REGISTRY_PATH").ok();
    let agent_registry = match agent_registry_path {
        Some(ref path) => match AgentRegistry::load_from_file(path) {
            Ok(registry) => {
                tracing::info!(agents = registry.len(), path = %path, "Agent registry loaded");
                registry
            }
            Err(e) => {
                tracing::error!(error = %e, "agent registry load failed — refusing to start");
                std::process::exit(1);
            }
        },
        None if inbox_auth_off && is_dev => {
            tracing::warn!(
                "AV_INBOX_AUTH=off + AV_ENV=dev — inbox endpoints disabled (no agent registry)"
            );
            AgentRegistry::empty()
        }
        None => {
            tracing::error!(
                "AV_AGENT_REGISTRY_PATH not set and AV_INBOX_AUTH != off — refusing to start. \
                 Set AV_AGENT_REGISTRY_PATH to an agents.json file, or set AV_INBOX_AUTH=off + AV_ENV=dev to disable inbox."
            );
            std::process::exit(1);
        }
    };

    // Feature-gate warning: AV_INBOX_DB_PATH set but persistence not compiled
    if std::env::var("AV_INBOX_DB_PATH").is_ok() {
        #[cfg(not(feature = "persistence"))]
        tracing::warn!(
            "AV_INBOX_DB_PATH is set but binary was compiled without 'persistence' feature. \
             Using in-memory inbox. Rebuild with --features persistence to enable SQLite."
        );
    }

    // Create inbox store with configurable TTL (default 7 days)
    let invite_ttl_secs: u64 = std::env::var("AV_INVITE_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(604800);

    #[cfg(feature = "persistence")]
    let inbox_store = match std::env::var("AV_INBOX_DB_PATH") {
        Ok(path) => {
            tracing::info!(path = %path, "Opening SQLite inbox database");
            match InboxStore::new_with_sqlite(Duration::from_secs(invite_ttl_secs), path).await {
                Ok(store) => store,
                Err(e) => {
                    tracing::error!(error = %e, "failed to open SQLite inbox — refusing to start");
                    std::process::exit(1);
                }
            }
        }
        Err(_) => InboxStore::new(Duration::from_secs(invite_ttl_secs)),
    };

    #[cfg(not(feature = "persistence"))]
    let inbox_store = InboxStore::new(Duration::from_secs(invite_ttl_secs));

    // Start background inbox reaper
    inbox_store.clone().start_reaper();

    let max_completion_tokens: u32 = match std::env::var("AV_MAX_COMPLETION_TOKENS") {
        Ok(val) => match val.parse() {
            Ok(n) => {
                tracing::info!(max_completion_tokens = n, "Using AV_MAX_COMPLETION_TOKENS");
                n
            }
            Err(_) => {
                tracing::warn!(
                    value = %val,
                    "AV_MAX_COMPLETION_TOKENS is not a valid u32, falling back to 4096"
                );
                4096
            }
        },
        Err(_) => 4096,
    };

    // Load schema registry (optional — empty registry if dir not found)
    let schema_registry_dir = std::env::var("AV_SCHEMA_DIR").unwrap_or_else(|_| {
        std::path::Path::new(&prompt_dir)
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("schemas")
            .join("output")
            .to_string_lossy()
            .into_owned()
    });
    let schema_registry = {
        let path = std::path::Path::new(&schema_registry_dir);
        if path.is_dir() {
            match agentvault_relay::schema_registry::SchemaRegistry::load_from_dir(path) {
                Ok(reg) => {
                    tracing::info!(
                        schema_count = reg.len(),
                        dir = %schema_registry_dir,
                        "Schema registry loaded"
                    );
                    reg
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to load schema registry — using empty registry");
                    agentvault_relay::schema_registry::SchemaRegistry::empty()
                }
            }
        } else {
            tracing::info!(dir = %schema_registry_dir, "Schema directory not found — using empty registry");
            agentvault_relay::schema_registry::SchemaRegistry::empty()
        }
    };

    let health_expose_model = std::env::var("AV_HEALTH_EXPOSE_MODEL")
        .map(|v| matches!(v.to_lowercase().as_str(), "true" | "1" | "yes"))
        .unwrap_or(false);

    if anthropic_api_key.is_none() && openai_api_key.is_none() && gemini_api_key.is_none() {
        tracing::error!(
            "No inference providers configured. Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY."
        );
        std::process::exit(1);
    }

    if anthropic_api_key.is_some() {
        tracing::info!(model_id = %model_id, "Anthropic provider enabled");
    }
    if openai_api_key.is_some() {
        tracing::info!(model_id = %openai_model_id, "OpenAI provider enabled");
    }
    if gemini_api_key.is_some() {
        tracing::info!(model_id = %gemini_model_id, "Gemini provider enabled");
    }

    // Log the active provider/model at startup so operators can confirm config
    // even when /health redacts it.
    {
        let provider = if anthropic_api_key.is_some() {
            "anthropic"
        } else if openai_api_key.is_some() {
            "openai"
        } else {
            "gemini"
        };
        let active_model = match provider {
            "anthropic" => model_id.as_str(),
            "openai" => openai_model_id.as_str(),
            _ => gemini_model_id.as_str(),
        };
        tracing::info!(provider = %provider, model_id = %active_model, "startup: active provider/model");
    }

    let state = Arc::new(AppState {
        signing_key,
        anthropic_api_key,
        anthropic_model_id: model_id,
        anthropic_base_url,
        openai_api_key,
        openai_model_id,
        openai_base_url,
        gemini_api_key,
        gemini_model_id,
        gemini_base_url,
        prompt_program_dir: prompt_dir,
        session_store,
        policy_registry,
        agent_registry,
        inbox_store,
        max_completion_tokens,
        session_ttl_secs,
        invite_ttl_secs,
        schema_registry,
        is_dev,
        health_expose_model,
    });

    let app = build_router(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!(%addr, session_ttl_secs, "AgentVault relay starting");
    let listener = TcpListener::bind(&addr).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}
