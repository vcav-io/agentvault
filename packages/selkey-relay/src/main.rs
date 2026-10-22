use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use selkey_relay::{
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
        std::env::var("SELKEY_MODEL_ID").unwrap_or_else(|_| "claude-sonnet-4-6".to_string());
    let prompt_dir = std::env::var("SELKEY_PROMPT_PROGRAM_DIR")
        .unwrap_or_else(|_| "prompt_programs".to_string());
    let port: u16 = std::env::var("SELKEY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3100);

    let is_dev = std::env::var("SELKEY_ENV")
        .map(|v| v == "dev")
        .unwrap_or(false);

    let signing_key = match selkey_relay::load_signing_key(
        std::env::var("SELKEY_SIGNING_KEY_HEX").ok().as_deref(),
        is_dev,
    ) {
        Ok((key, ephemeral)) => {
            let verifying_key = key.verifying_key();
            if ephemeral {
                tracing::warn!(
                    verifying_key_hex = %receipt_core::public_key_to_hex(&verifying_key),
                    key_id = %selkey_relay::relay_key_id(&verifying_key),
                    "SELKEY_ENV=dev without SELKEY_SIGNING_KEY_HEX — generated ephemeral signing key (receipts will not verify across restarts)"
                );
            } else {
                tracing::info!(
                    verifying_key_hex = %receipt_core::public_key_to_hex(&verifying_key),
                    key_id = %selkey_relay::relay_key_id(&verifying_key),
                    "Loaded relay signing key from SELKEY_SIGNING_KEY_HEX"
                );
            }
            key
        }
        Err(msg) => {
            tracing::error!("{msg}");
            std::process::exit(1);
        }
    };

    let anthropic_base_url = std::env::var("ANTHROPIC_BASE_URL").ok();

    let openai_api_key = std::env::var("OPENAI_API_KEY").ok();
    let openai_model_id =
        std::env::var("SELKEY_OPENAI_MODEL_ID").unwrap_or_else(|_| "gpt-4o".to_string());
    let openai_base_url = std::env::var("OPENAI_BASE_URL").ok();

    let gemini_api_key = std::env::var("GEMINI_API_KEY").ok();
    let gemini_model_id = std::env::var("SELKEY_GEMINI_MODEL_ID")
        .unwrap_or_else(|_| "gemini-3-flash-preview".to_string());
    let gemini_base_url = std::env::var("GEMINI_BASE_URL").ok();

    // ========================================================================
    // Registry admission: if SELKEY_REGISTRY_PATH is set, use the admission
    // module to load artefacts from the local registry clone.
    // ========================================================================
    let registry_admission = match std::env::var("SELKEY_REGISTRY_PATH") {
        Ok(registry_path) => {
            let config_path = std::env::var("SELKEY_ADMISSION_CONFIG")
                .unwrap_or_else(|_| "relay-admission.toml".to_string());
            let config_path = std::path::Path::new(&config_path);
            // If config_path is relative, resolve against the registry path parent
            let config_path = if config_path.is_relative() {
                std::env::current_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."))
                    .join(config_path)
            } else {
                config_path.to_path_buf()
            };
            tracing::info!(
                registry_path = %registry_path,
                config = %config_path.display(),
                "Loading artefacts via registry admission"
            );
            match selkey_relay::admission::load_admission(&config_path, Some(&registry_path)) {
                Ok(artefacts) => {
                    tracing::info!(
                        schemas = artefacts.schemas.len(),
                        policies = artefacts.policies.len(),
                        profiles = artefacts.profiles.len(),
                        programs = artefacts.programs.len(),
                        "Registry admission: all artefacts loaded and verified"
                    );
                    Some(artefacts)
                }
                Err(e) => {
                    tracing::error!(error = %e, "registry admission failed — refusing to start");
                    std::process::exit(1);
                }
            }
        }
        Err(_) => None,
    };

    // Validate model profile lockfile before binding to port.
    // Exits with a non-zero code on hash mismatch.
    // Skip when registry admission is active (profiles already verified).
    if registry_admission.is_none() {
        if let Err(e) = selkey_relay::prompt_program::validate_model_profile_lockfile(&prompt_dir) {
            tracing::error!(error = %e, "model profile lockfile validation failed — refusing to start");
            std::process::exit(1);
        }
    }

    // Load and validate enforcement policy. Fail-closed: missing lockfile = startup failure.
    let relay_policies_dir = std::path::Path::new(&prompt_dir)
        .join("relay_policies")
        .to_string_lossy()
        .into_owned();

    // Check dev skip flags before loading — validate_enforcement_lockfile returns Ok(()) when
    // both flags are set, but the subsequent load calls would still fail without the lockfile.
    let lockfile_skip = std::env::var("SELKEY_ENFORCEMENT_LOCKFILE_SKIP")
        .map(|v| v == "1")
        .unwrap_or(false);
    let is_dev_for_lockfile = std::env::var("SELKEY_ENV")
        .map(|v| v == "dev")
        .unwrap_or(false);
    let skip_enforcement = lockfile_skip && is_dev_for_lockfile;

    let policy_registry = if let Some(ref admitted) = registry_admission {
        // Build policy registry from admitted artefacts
        if admitted.policies.is_empty() && !skip_enforcement {
            tracing::error!(
                "registry admission loaded zero policies and enforcement is not skipped — refusing to start"
            );
            std::process::exit(1);
        }
        if admitted.policies.is_empty() && skip_enforcement {
            tracing::warn!("registry admission loaded zero policies — using dev skip");
            enforcement_policy::PolicyRegistry::dev_skip()
        } else {
            let default_hash = match &admitted.default_policy_hash {
                Some(h) => h.clone(),
                None if admitted.policies.len() == 1 => {
                    admitted.policies.keys().next().unwrap().clone()
                }
                None => {
                    tracing::error!(
                        count = admitted.policies.len(),
                        "policies.default is required in admission config when multiple policies are admitted"
                    );
                    std::process::exit(1);
                }
            };
            match enforcement_policy::PolicyRegistry::new(admitted.policies.clone(), default_hash) {
                Ok(registry) => {
                    tracing::info!(
                        count = registry.len(),
                        default = %registry.default_policy().hash,
                        hashes = ?registry.hashes(),
                        "Enforcement policy registry loaded (from registry admission)"
                    );
                    registry
                }
                Err(e) => {
                    tracing::error!(error = %e, "failed to construct policy registry from admission — refusing to start");
                    std::process::exit(1);
                }
            }
        }
    } else if skip_enforcement {
        tracing::warn!(
            "SELKEY_ENFORCEMENT_LOCKFILE_SKIP=1 + SELKEY_ENV=dev — skipping enforcement policy (dev mode only)"
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
        let default_hash = match std::env::var("SELKEY_DEFAULT_POLICY_HASH") {
            Ok(configured_hash) => {
                if !policies.contains_key(&configured_hash) {
                    tracing::error!(
                        configured_hash = %configured_hash,
                        available = ?policies.keys().collect::<Vec<_>>(),
                        "configured SELKEY_DEFAULT_POLICY_HASH is not present in lockfile-verified policy set"
                    );
                    std::process::exit(1);
                }
                configured_hash
            }
            Err(_) if policies.len() == 1 => policies.keys().next().unwrap().clone(),
            Err(_) => {
                tracing::error!(
                    count = policies.len(),
                    "SELKEY_DEFAULT_POLICY_HASH is required when multiple enforcement policies are loaded"
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

    let session_ttl_secs: u64 = std::env::var("SELKEY_SESSION_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let limit_config = match selkey_relay::limits::LimitConfig::from_env() {
        Ok(config) => config,
        Err(msg) => {
            tracing::error!("{msg} — refusing to start");
            std::process::exit(1);
        }
    };
    tracing::info!(limits = ?limit_config, "relay limits");
    let session_store = SessionStore::new(Duration::from_secs(session_ttl_secs))
        .with_max_sessions(limit_config.max_sessions);

    // Start background session reaper
    session_store.clone().start_reaper();

    // Load agent registry for inbox auth.
    // Fail-closed: missing file = startup failure unless SELKEY_INBOX_AUTH=off + SELKEY_ENV=dev.
    let inbox_auth_off = std::env::var("SELKEY_INBOX_AUTH")
        .map(|v| v == "off")
        .unwrap_or(false);
    if inbox_auth_off && !is_dev {
        tracing::error!(
            "SELKEY_INBOX_AUTH=off requires SELKEY_ENV=dev — refusing to start. \
             This is a safety check to prevent accidentally disabling inbox auth in production."
        );
        std::process::exit(1);
    }
    let agent_registry_path = std::env::var("SELKEY_AGENT_REGISTRY_PATH").ok();
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
                "SELKEY_INBOX_AUTH=off + SELKEY_ENV=dev — inbox endpoints disabled (no agent registry)"
            );
            AgentRegistry::empty()
        }
        None => {
            tracing::error!(
                "SELKEY_AGENT_REGISTRY_PATH not set and SELKEY_INBOX_AUTH != off — refusing to start. \
                 Set SELKEY_AGENT_REGISTRY_PATH to an agents.json file, or set SELKEY_INBOX_AUTH=off + SELKEY_ENV=dev to disable inbox."
            );
            std::process::exit(1);
        }
    };

    // Feature-gate warning: SELKEY_INBOX_DB_PATH set but persistence not compiled
    if std::env::var("SELKEY_INBOX_DB_PATH").is_ok() {
        #[cfg(not(feature = "persistence"))]
        tracing::warn!(
            "SELKEY_INBOX_DB_PATH is set but binary was compiled without 'persistence' feature. \
             Using in-memory inbox. Rebuild with --features persistence to enable SQLite."
        );
    }

    // Create inbox store with configurable TTL (default 7 days)
    let invite_ttl_secs: u64 = std::env::var("SELKEY_INVITE_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(604800);

    #[cfg(feature = "persistence")]
    let inbox_store = match std::env::var("SELKEY_INBOX_DB_PATH") {
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
    }
    .with_limits(
        limit_config.max_invites,
        limit_config.max_pending_invites_per_agent,
    )
    .with_max_held_per_agent(limit_config.max_invites_per_agent);

    #[cfg(not(feature = "persistence"))]
    let inbox_store = InboxStore::new(Duration::from_secs(invite_ttl_secs))
        .with_limits(
            limit_config.max_invites,
            limit_config.max_pending_invites_per_agent,
        )
        .with_max_held_per_agent(limit_config.max_invites_per_agent);

    // Start background inbox reaper
    inbox_store.clone().start_reaper();

    let max_completion_tokens: u32 = match std::env::var("SELKEY_MAX_COMPLETION_TOKENS") {
        Ok(val) => match val.parse() {
            Ok(n) => {
                tracing::info!(
                    max_completion_tokens = n,
                    "Using SELKEY_MAX_COMPLETION_TOKENS"
                );
                n
            }
            Err(_) => {
                tracing::warn!(
                    value = %val,
                    "SELKEY_MAX_COMPLETION_TOKENS is not a valid u32, falling back to 4096"
                );
                4096
            }
        },
        Err(_) => 4096,
    };

    // Load schema registry — from admission if available, otherwise from directory
    let schema_registry = if let Some(ref admitted) = registry_admission {
        let reg = selkey_relay::schema_registry::SchemaRegistry::from_map(admitted.schemas.clone());
        tracing::info!(
            schema_count = reg.len(),
            "Schema registry loaded (from registry admission)"
        );
        reg
    } else {
        let schema_registry_dir = std::env::var("SELKEY_SCHEMA_DIR").unwrap_or_else(|_| {
            std::path::Path::new(&prompt_dir)
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("schemas")
                .join("output")
                .to_string_lossy()
                .into_owned()
        });
        let path = std::path::Path::new(&schema_registry_dir);
        if path.is_dir() {
            match selkey_relay::schema_registry::SchemaRegistry::load_from_dir(path) {
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
                    selkey_relay::schema_registry::SchemaRegistry::empty()
                }
            }
        } else {
            tracing::info!(dir = %schema_registry_dir, "Schema directory not found — using empty registry");
            selkey_relay::schema_registry::SchemaRegistry::empty()
        }
    };

    if schema_registry.is_empty() && !is_dev {
        tracing::warn!(
            "schema registry is empty — contracts will be rejected (only registry output schemas \
             are accepted outside SELKEY_ENV=dev). Set SELKEY_SCHEMA_DIR to the schemas/output directory."
        );
    }

    let health_expose_model = std::env::var("SELKEY_HEALTH_EXPOSE_MODEL")
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

    let operator_token = std::env::var("SELKEY_OPERATOR_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());
    if let Some(ref token) = operator_token {
        if let Err(reason) = selkey_relay::auth::check_token_strength(token) {
            tracing::error!("SELKEY_OPERATOR_TOKEN rejected: {reason} — refusing to start");
            std::process::exit(1);
        }
    }
    let bind_addr =
        selkey_relay::resolve_bind_addr(std::env::var("SELKEY_BIND_ADDR").ok().as_deref());
    match (&operator_token, is_dev) {
        (Some(_), _) => {
            tracing::info!("SELKEY_OPERATOR_TOKEN set — required on POST /relay and POST /sessions")
        }
        (None, true) => tracing::warn!(
            "SELKEY_ENV=dev without SELKEY_OPERATOR_TOKEN — POST /relay and POST /sessions are unauthenticated"
        ),
        (None, false) => tracing::info!(
            "SELKEY_OPERATOR_TOKEN not set — POST /relay is disabled; POST /sessions is unauthenticated"
        ),
    }
    let allow_unauthenticated = std::env::var("SELKEY_ALLOW_UNAUTHENTICATED")
        .map(|v| v == "1")
        .unwrap_or(false);
    if let Err(msg) = selkey_relay::check_exposure(
        bind_addr,
        operator_token.is_some(),
        is_dev,
        allow_unauthenticated,
    ) {
        tracing::error!(%bind_addr, "{msg}");
        std::process::exit(1);
    }
    if operator_token.is_none() && !bind_addr.is_loopback() {
        tracing::warn!(
            %bind_addr,
            "relay is bound to a non-loopback address without SELKEY_OPERATOR_TOKEN — anyone who can reach it can create sessions"
        );
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
        admitted_programs: registry_admission.as_ref().map(|a| a.programs.clone()),
        admitted_profiles: registry_admission.as_ref().map(|a| a.profiles.clone()),
        operator_token,
        limits: selkey_relay::limits::Limits::new(limit_config),
    });

    let host_policy = selkey_relay::host_guard::HostPolicy::for_bind(
        bind_addr,
        std::env::var("SELKEY_ALLOWED_HOSTS").ok().as_deref(),
    );
    match &host_policy {
        Some(policy) => tracing::info!(?policy, "Host header check enabled"),
        None => tracing::info!(
            "Host header check disabled (non-loopback bind, no SELKEY_ALLOWED_HOSTS)"
        ),
    }
    let app = selkey_relay::host_guard::apply(build_router(state), host_policy);

    let addr = std::net::SocketAddr::new(bind_addr, port);
    tracing::info!(%addr, session_ttl_secs, "Selkey relay starting");
    let listener = TcpListener::bind(&addr).await.expect("bind failed");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("server error");
}
