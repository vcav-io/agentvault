//! Startup configuration checks, exercised against the relay binary.
//!
//! Each case starts `selkey-relay` with a minimal environment (dummy provider
//! key, no network calls) and checks whether it refuses to start.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const STRONG_TOKEN_A: &str = "6a1f0c3e9b7d24a58e0f1b6c3d9a7e2f91c5e07b3d8a26f4e1b0c79d5a3f8e62";
const STRONG_TOKEN_B: &str = "c4e8b2a6f0d93715e2b8a4c6d0f19e375a0d1c8e93b7f264a1e0d8c5b39f7a26";
const SIGNING_KEY_HEX: &str = "4242424242424242424242424242424242424242424242424242424242424242";

/// Outcome of starting the relay.
enum Startup {
    /// The process exited on its own with this success flag and output.
    Exited { success: bool, output: String },
    /// The process was still running after the wait and was stopped.
    Running { output: String },
}

fn write_agents(name: &str, tokens: [&str; 2]) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("selkey-startup-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("agents.json");
    let agents = serde_json::json!({
        "agents": [
            { "agent_id": "alice", "inbox_token": tokens[0] },
            { "agent_id": "bob", "inbox_token": tokens[1] },
        ]
    });
    std::fs::write(&path, agents.to_string()).unwrap();
    path
}

fn start_relay(extra_env: &[(&str, &str)], wait: Duration) -> Startup {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_selkey-relay"));
    cmd.env_clear()
        .env("RUST_LOG", "info")
        .env("SELKEY_PORT", "0")
        .env("SELKEY_BIND_ADDR", "127.0.0.1")
        .env(
            "SELKEY_PROMPT_PROGRAM_DIR",
            format!("{manifest_dir}/prompt_programs"),
        )
        .env(
            "SELKEY_SCHEMA_DIR",
            format!("{manifest_dir}/../../schemas/output"),
        )
        .env("ANTHROPIC_API_KEY", "dummy-key-not-used")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn relay");
    let deadline = Instant::now() + wait;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            child.kill().ok();
            child.wait().ok();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .ok();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .ok();
    match status {
        Some(status) => Startup::Exited {
            success: status.success(),
            output,
        },
        None => Startup::Running { output },
    }
}

fn assert_refuses(env: &[(&str, &str)], expected: &str) {
    match start_relay(env, Duration::from_secs(20)) {
        Startup::Exited { success, output } => {
            assert!(!success, "relay exited successfully: {output}");
            assert!(
                output.contains(expected),
                "expected {expected:?} in output: {output}"
            );
        }
        Startup::Running { output } => {
            panic!("relay started but should have refused ({expected}): {output}")
        }
    }
}

#[test]
fn test_relay_refuses_to_start_without_signing_key_outside_dev() {
    let agents = write_agents("nokey", [STRONG_TOKEN_A, STRONG_TOKEN_B]);
    assert_refuses(
        &[("SELKEY_AGENT_REGISTRY_PATH", agents.to_str().unwrap())],
        "SELKEY_SIGNING_KEY_HEX is not set",
    );
}

#[test]
fn test_relay_starts_with_ephemeral_key_in_dev() {
    let outcome = start_relay(
        &[("SELKEY_ENV", "dev"), ("SELKEY_INBOX_AUTH", "off")],
        Duration::from_secs(3),
    );
    match outcome {
        Startup::Running { output } => assert!(output.contains("ephemeral"), "{output}"),
        Startup::Exited { output, .. } => panic!("dev relay exited: {output}"),
    }
}

#[test]
fn test_relay_refuses_weak_operator_token() {
    let agents = write_agents("weakop", [STRONG_TOKEN_A, STRONG_TOKEN_B]);
    assert_refuses(
        &[
            ("SELKEY_AGENT_REGISTRY_PATH", agents.to_str().unwrap()),
            ("SELKEY_SIGNING_KEY_HEX", SIGNING_KEY_HEX),
            ("SELKEY_OPERATOR_TOKEN", "operator-token"),
        ],
        "SELKEY_OPERATOR_TOKEN rejected",
    );
}

#[test]
fn test_relay_refuses_weak_registry_token() {
    let agents = write_agents("weakreg", [STRONG_TOKEN_A, "bob_token_456"]);
    assert_refuses(
        &[
            ("SELKEY_AGENT_REGISTRY_PATH", agents.to_str().unwrap()),
            ("SELKEY_SIGNING_KEY_HEX", SIGNING_KEY_HEX),
        ],
        "weak inbox_token",
    );
}

#[test]
fn test_dev_relay_refuses_public_bind_without_operator_token() {
    // The check runs before the listener binds, so nothing is exposed.
    assert_refuses(
        &[
            ("SELKEY_ENV", "dev"),
            ("SELKEY_INBOX_AUTH", "off"),
            ("SELKEY_BIND_ADDR", "0.0.0.0"),
        ],
        "refusing to start: relay is bound to a non-loopback address",
    );
}

#[test]
fn test_relay_refuses_schema_registry_with_nested_draft_declaration() {
    let dir = std::env::temp_dir().join(format!(
        "selkey-startup-nested-draft-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let schema = serde_json::json!({
        "type": "object",
        "$defs": {
            "signal": { "$schema": "http://json-schema.org/draft-04/schema#", "const": "OK" }
        },
        "properties": { "signal": { "$ref": "#/$defs/signal" } },
        "required": ["signal"],
        "additionalProperties": false
    });
    std::fs::write(dir.join("nested_draft.json"), schema.to_string()).unwrap();
    assert_refuses(
        &[
            ("SELKEY_ENV", "dev"),
            ("SELKEY_INBOX_AUTH", "off"),
            ("SELKEY_SCHEMA_DIR", dir.to_str().unwrap()),
        ],
        "Failed to load schema registry",
    );
    std::fs::remove_dir_all(&dir).ok();
}
