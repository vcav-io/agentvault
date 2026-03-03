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
    let model_id =
        std::env::var("VCAV_MODEL_ID").unwrap_or_else(|_| "claude-sonnet-4-6".to_string());
    let prompt_dir =
        std::env::var("VCAV_PROMPT_PROGRAM_DIR").unwrap_or_else(|_| "prompt_programs".to_string());
    let port: u16 = std::env::var("VCAV_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3100);

    let signing_key = match std::env::var("VCAV_SIGNING_KEY_HEX") {
        Ok(hex_str) => {
            let bytes = hex::decode(&hex_str).expect("VCAV_SIGNING_KEY_HEX must be valid hex");
            let bytes: [u8; 32] = bytes
                .try_into()
                .expect("VCAV_SIGNING_KEY_HEX must be exactly 64 hex characters (32 bytes)");
            let key = SigningKey::from_bytes(&bytes);
            tracing::info!(
                verifying_key_hex = %receipt_core::public_key_to_hex(&key.verifying_key()),
                "Loaded relay signing key from VCAV_SIGNING_KEY_HEX"
            );
            key
        }
        Err(_) => {
            let key = SigningKey::generate(&mut rand::thread_rng());
            tracing::warn!(
                verifying_key_hex = %receipt_core::public_key_to_hex(&key.verifying_key()),
                "No VCAV_SIGNING_KEY_HEX set — generated ephemeral signing key (receipts will not verify across restarts)"
            );
            key
        }
    };

    let anthropic_base_url = std::env::var("ANTHROPIC_BASE_URL").ok();

    let openai_api_key = std::env::var("OPENAI_API_KEY").ok();
    let openai_model_id =
        std::env::var("VCAV_OPENAI_MODEL_ID").unwrap_or_else(|_| "gpt-4o".to_string());
    let openai_base_url = std::env::var("OPENAI_BASE_URL").ok();

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

    if let Err(e) = enforcement_policy::validate_enforcement_lockfile(&relay_policies_dir) {
        tracing::error!(error = %e, "enforcement policy lockfile validation failed — refusing to start");
        std::process::exit(1);
    }

    // Derive policy filename from lockfile — no hardcoded filenames.
    let lockfile_entries = match enforcement_policy::load_lockfile_entries(&relay_policies_dir) {
        Ok(entries) => entries,
        Err(e) => {
            tracing::error!(error = %e, "failed to read enforcement policy lockfile — refusing to start");
            std::process::exit(1);
        }
    };
    if lockfile_entries.len() != 1 {
        tracing::error!(
            count = lockfile_entries.len(),
            "expected exactly one enforcement policy in lockfile (multi-policy selection not yet implemented)"
        );
        std::process::exit(1);
    }
    let policy_id = lockfile_entries.keys().next().unwrap();
    let enforcement_policy_path = std::path::Path::new(&relay_policies_dir)
        .join(format!("{policy_id}.json"))
        .to_string_lossy()
        .into_owned();

    let loaded_policy = match enforcement_policy::load_enforcement_policy(&enforcement_policy_path)
    {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(error = %e, "failed to load enforcement policy — refusing to start");
            std::process::exit(1);
        }
    };

    if let Err(e) = enforcement_policy::validate_policy_scope(&loaded_policy) {
        tracing::error!(error = %e, "enforcement policy scope validation failed — refusing to start");
        std::process::exit(1);
    }

    if let Err(e) = enforcement_policy::validate_rule_categories(&loaded_policy) {
        tracing::error!(error = %e, "enforcement policy contains unsupported rule categories — refusing to start");
        std::process::exit(1);
    }

    if let Err(e) = enforcement_policy::validate_capabilities(&loaded_policy) {
        tracing::error!(error = %e, "enforcement policy requires unsupported capabilities — refusing to start");
        std::process::exit(1);
    }

    if loaded_policy.rules.is_empty() {
        tracing::warn!("0 enforcement rules loaded — guard disabled");
    } else {
        tracing::info!(
            rule_count = loaded_policy.rules.len(),
            scope = %loaded_policy.policy_scope,
            "Enforcement rules apply to all output schemas"
        );
    }

    let enforcement_policy_hash = match enforcement_policy::content_hash(&loaded_policy) {
        Ok(h) => h,
        Err(e) => {
            tracing::error!(error = %e, "failed to compute enforcement policy hash — refusing to start");
            std::process::exit(1);
        }
    };

    tracing::info!(
        policy_id = %loaded_policy.policy_id,
        hash = %enforcement_policy_hash,
        "Enforcement policy loaded"
    );

    let session_ttl_secs: u64 = std::env::var("VCAV_SESSION_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let session_store = SessionStore::new(Duration::from_secs(session_ttl_secs));

    // Start background session reaper
    session_store.clone().start_reaper();

    // Load agent registry for inbox auth.
    // Fail-closed: missing file = startup failure unless VCAV_INBOX_AUTH=off + VCAV_ENV=dev.
    let inbox_auth_off = std::env::var("VCAV_INBOX_AUTH")
        .map(|v| v == "off")
        .unwrap_or(false);
    let is_dev = std::env::var("VCAV_ENV")
        .map(|v| v == "dev")
        .unwrap_or(false);
    if inbox_auth_off && !is_dev {
        tracing::error!(
            "VCAV_INBOX_AUTH=off requires VCAV_ENV=dev — refusing to start. \
             This is a safety check to prevent accidentally disabling inbox auth in production."
        );
        std::process::exit(1);
    }
    let agent_registry_path = std::env::var("VCAV_AGENT_REGISTRY_PATH").ok();
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
                "VCAV_INBOX_AUTH=off + VCAV_ENV=dev — inbox endpoints disabled (no agent registry)"
            );
            AgentRegistry::empty()
        }
        None => {
            tracing::error!(
                "VCAV_AGENT_REGISTRY_PATH not set and VCAV_INBOX_AUTH != off — refusing to start. \
                 Set VCAV_AGENT_REGISTRY_PATH to an agents.json file, or set VCAV_INBOX_AUTH=off + VCAV_ENV=dev to disable inbox."
            );
            std::process::exit(1);
        }
    };

    // Feature-gate warning: VCAV_INBOX_DB_PATH set but persistence not compiled
    if std::env::var("VCAV_INBOX_DB_PATH").is_ok() {
        #[cfg(not(feature = "persistence"))]
        tracing::warn!(
            "VCAV_INBOX_DB_PATH is set but binary was compiled without 'persistence' feature. \
             Using in-memory inbox. Rebuild with --features persistence to enable SQLite."
        );
    }

    // Create inbox store with configurable TTL (default 7 days)
    let invite_ttl_secs: u64 = std::env::var("VCAV_INVITE_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(604800);

    #[cfg(feature = "persistence")]
    let inbox_store = match std::env::var("VCAV_INBOX_DB_PATH") {
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

    if anthropic_api_key.is_none() && openai_api_key.is_none() {
        tracing::error!(
            "No inference providers configured. Set at least one of ANTHROPIC_API_KEY or OPENAI_API_KEY."
        );
        std::process::exit(1);
    }

    if anthropic_api_key.is_some() {
        tracing::info!(model_id = %model_id, "Anthropic provider enabled");
    }
    if openai_api_key.is_some() {
        tracing::info!(model_id = %openai_model_id, "OpenAI provider enabled");
    }

    let state = Arc::new(AppState {
        signing_key,
        anthropic_api_key,
        anthropic_model_id: model_id,
        anthropic_base_url,
        openai_api_key,
        openai_model_id,
        openai_base_url,
        prompt_program_dir: prompt_dir,
        session_store,
        enforcement_policy: loaded_policy,
        enforcement_policy_hash,
        agent_registry,
        inbox_store,
        is_dev,
    });

    let app = build_router(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!(%addr, session_ttl_secs, "AgentVault relay starting");
    let listener = TcpListener::bind(&addr).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}
