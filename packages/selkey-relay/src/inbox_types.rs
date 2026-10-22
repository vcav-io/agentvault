use chrono::{DateTime, Utc};

use crate::session::SessionTokens;
use crate::types::Contract;

// Re-export protocol types from vault-family-types for use within this crate.
// InviteDetailResponse is defined locally (extended with contract_json).
pub use vault_family_types::{
    AcceptInviteRequest, AcceptInviteResponse, CreateInviteRequest, CreateInviteResponse,
    DeclineInviteRequest, DeclineReasonCode, InboxEvent, InboxEventType, InboxQuery, InboxResponse,
    InviteStatus, InviteSummary,
};

/// Caller-dependent invite detail response (extended from vault-family-types).
///
/// Adds `contract_json` so the responder can confirm the exact proposed contract
/// without rebuilding it locally (structured confirmation).
///
/// Token redaction rules:
/// - Recipient sees everything EXCEPT initiator tokens
/// - Sender sees everything EXCEPT responder tokens
/// - Pre-accept: neither side sees any session tokens
/// - Post-accept: each side sees only their own role's tokens
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct InviteDetailResponse {
    pub invite_id: String,
    pub from_agent_id: String,
    pub to_agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_agent_pubkey: Option<String>,
    pub status: InviteStatus,
    pub purpose_code: String,
    pub contract_hash: String,
    /// Full proposed contract — always present in invite detail responses.
    /// Enables structured confirmation: responder validates and confirms
    /// the exact proposed contract rather than rebuilding from purpose.
    pub contract_json: serde_json::Value,
    pub provider: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decline_reason_code: Option<DeclineReasonCode>,
    // Session linkage (populated after accept, redacted per caller)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submit_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_token: Option<String>,
}

// ============================================================================
// Invite (internal)
// ============================================================================

/// Core invite object stored by the relay.
///
/// The full contract is stored server-side but never exposed in list responses.
/// Recipients see only contract_hash + purpose_code pre-accept.
#[derive(Debug, Clone)]
pub struct Invite {
    pub version: String,
    pub invite_id: String,
    pub from_agent_id: String,
    pub to_agent_id: String,
    /// Sender's Ed25519 public key (hex). Included so the recipient can verify
    /// sender identity out-of-band. Not used for relay-level signing in Phase 1.
    pub from_agent_pubkey: Option<String>,
    /// Full contract (stored server-side, used on accept to create session).
    pub contract: Contract,
    pub contract_hash: String,
    pub provider: String,
    pub purpose_code: String,
    /// Invariant-coupled fields below are `pub(crate)` to prevent external code
    /// from bypassing the state machine in `InboxStore`.
    pub(crate) status: InviteStatus,
    pub created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    /// Session linkage — populated on accept, immutable thereafter.
    pub(crate) session_id: Option<String>,
    /// All 4 session tokens — populated on accept, immutable thereafter.
    /// Redacted per-caller in responses (each side sees only their role's tokens).
    pub(crate) session_tokens: Option<SessionTokens>,
    /// Reason code for decline.
    pub(crate) decline_reason_code: Option<DeclineReasonCode>,
}

impl Invite {
    /// Build a caller-dependent detail response with proper token redaction.
    pub fn to_detail_response(&self, caller_agent_id: &str) -> InviteDetailResponse {
        let is_sender = caller_agent_id == self.from_agent_id;
        let is_recipient = caller_agent_id == self.to_agent_id;

        let (session_id, submit_token, read_token) = match &self.session_tokens {
            Some(tokens) if self.status == InviteStatus::Accepted => {
                if is_sender {
                    (
                        self.session_id.clone(),
                        Some(tokens.initiator_submit.clone()),
                        Some(tokens.initiator_read.clone()),
                    )
                } else if is_recipient {
                    (
                        self.session_id.clone(),
                        Some(tokens.responder_submit.clone()),
                        Some(tokens.responder_read.clone()),
                    )
                } else {
                    (None, None, None)
                }
            }
            _ => (None, None, None),
        };

        InviteDetailResponse {
            invite_id: self.invite_id.clone(),
            from_agent_id: self.from_agent_id.clone(),
            to_agent_id: self.to_agent_id.clone(),
            from_agent_pubkey: self.from_agent_pubkey.clone(),
            status: self.status,
            purpose_code: self.purpose_code.clone(),
            contract_hash: self.contract_hash.clone(),
            contract_json: serde_json::to_value(&self.contract).unwrap_or(serde_json::Value::Null),
            provider: self.provider.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            expires_at: self.expires_at,
            decline_reason_code: self.decline_reason_code,
            session_id,
            submit_token,
            read_token,
        }
    }

    /// Build a lightweight summary for inbox listings.
    pub fn to_summary(&self) -> InviteSummary {
        InviteSummary {
            invite_id: self.invite_id.clone(),
            from_agent_id: self.from_agent_id.clone(),
            from_agent_pubkey: self.from_agent_pubkey.clone(),
            status: self.status,
            purpose_code: self.purpose_code.clone(),
            contract_hash: self.contract_hash.clone(),
            created_at: self.created_at,
            expires_at: self.expires_at,
        }
    }

    /// Check if this invite can transition to the given status.
    pub fn can_transition_to(&self, target: InviteStatus) -> bool {
        match (self.status, target) {
            // From PENDING, any non-PENDING terminal state is valid
            (InviteStatus::Pending, InviteStatus::Accepted) => true,
            (InviteStatus::Pending, InviteStatus::Declined) => true,
            (InviteStatus::Pending, InviteStatus::Canceled) => true,
            (InviteStatus::Pending, InviteStatus::Expired) => true,
            // Idempotent: same state is OK
            (current, target) if current == target => true,
            // Everything else is invalid
            _ => false,
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Contract;

    fn test_invite() -> Invite {
        let now = Utc::now();
        Invite {
            version: "1".to_string(),
            invite_id: "inv_test123".to_string(),
            from_agent_id: "alice".to_string(),
            to_agent_id: "bob".to_string(),
            from_agent_pubkey: Some("aa".repeat(32)),
            contract: Contract {
                purpose_code: vault_family_types::Purpose::Compatibility,
                output_schema_id: "test".to_string(),
                output_schema: serde_json::json!({"type": "object"}),
                participants: vec!["alice".to_string(), "bob".to_string()],
                prompt_template_hash: "a".repeat(64),
                entropy_budget_bits: None,
                timing_class: None,
                metadata: serde_json::Value::Null,
                model_profile_id: None,
                model_profile_hash: None,
                enforcement_policy_hash: None,
                output_schema_hash: None,
                model_constraints: None,
                max_completion_tokens: None,
                session_ttl_secs: None,
                invite_ttl_secs: None,
                entropy_enforcement: None,
                relay_verifying_key_hex: None,
            },
            contract_hash: "c".repeat(64),
            provider: "anthropic".to_string(),
            purpose_code: "COMPATIBILITY".to_string(),
            status: InviteStatus::Pending,
            created_at: now,
            updated_at: now,
            expires_at: now + chrono::Duration::days(7),
            session_id: None,
            session_tokens: None,
            decline_reason_code: None,
        }
    }

    // ── Serde round-trip ─────────────────────────────────────────────────

    #[test]
    fn test_invite_status_serde() {
        let json = serde_json::to_string(&InviteStatus::Pending).unwrap();
        assert_eq!(json, "\"PENDING\"");

        let parsed: InviteStatus = serde_json::from_str("\"CANCELED\"").unwrap();
        assert_eq!(parsed, InviteStatus::Canceled);

        // Unknown variant fails
        let result = serde_json::from_str::<InviteStatus>("\"UNKNOWN\"");
        assert!(result.is_err());
    }

    #[test]
    fn test_inbox_event_type_serde() {
        let json = serde_json::to_string(&InboxEventType::InviteCreated).unwrap();
        assert_eq!(json, "\"INVITE_CREATED\"");

        let parsed: InboxEventType = serde_json::from_str("\"INVITE_ACCEPTED\"").unwrap();
        assert_eq!(parsed, InboxEventType::InviteAccepted);
    }

    #[test]
    fn test_decline_reason_code_serde() {
        let json = serde_json::to_string(&DeclineReasonCode::NotInterested).unwrap();
        assert_eq!(json, "\"NOT_INTERESTED\"");

        let parsed: DeclineReasonCode = serde_json::from_str("\"BUSY\"").unwrap();
        assert_eq!(parsed, DeclineReasonCode::Busy);
    }

    #[test]
    fn test_invite_summary_serialization() {
        let invite = test_invite();
        let summary = invite.to_summary();
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["invite_id"], "inv_test123");
        assert_eq!(json["from_agent_id"], "alice");
        assert_eq!(json["status"], "PENDING");
        assert_eq!(json["purpose_code"], "COMPATIBILITY");
        // No contract body in summary
        assert!(json.get("contract").is_none());
        // No session tokens in summary
        assert!(json.get("session_id").is_none());
    }

    #[test]
    fn test_inbox_event_serialization() {
        let event = InboxEvent {
            event_id: 42,
            event_type: InboxEventType::InviteCreated,
            invite_id: "inv_test".to_string(),
            from_agent_id: "alice".to_string(),
            timestamp: Utc::now(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["event_id"], 42);
        assert_eq!(json["event_type"], "INVITE_CREATED");
    }

    #[test]
    fn test_inbox_response_serialization() {
        let response = InboxResponse {
            invites: vec![],
            latest_event_id: 100,
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["latest_event_id"], 100);
        assert!(json["invites"].as_array().unwrap().is_empty());
    }

    // ── State machine ────────────────────────────────────────────────────

    #[test]
    fn test_pending_can_transition_to_all_terminals() {
        let invite = test_invite();
        assert!(invite.can_transition_to(InviteStatus::Accepted));
        assert!(invite.can_transition_to(InviteStatus::Declined));
        assert!(invite.can_transition_to(InviteStatus::Canceled));
        assert!(invite.can_transition_to(InviteStatus::Expired));
    }

    #[test]
    fn test_terminal_cannot_transition_to_other() {
        let mut invite = test_invite();
        invite.status = InviteStatus::Accepted;
        // Cannot go to other terminal states
        assert!(!invite.can_transition_to(InviteStatus::Declined));
        assert!(!invite.can_transition_to(InviteStatus::Canceled));
        assert!(!invite.can_transition_to(InviteStatus::Pending));
        // Idempotent: same state is OK
        assert!(invite.can_transition_to(InviteStatus::Accepted));
    }

    #[test]
    fn test_all_terminal_states_are_idempotent() {
        for status in [
            InviteStatus::Accepted,
            InviteStatus::Declined,
            InviteStatus::Canceled,
            InviteStatus::Expired,
        ] {
            let mut invite = test_invite();
            invite.status = status;
            assert!(
                invite.can_transition_to(status),
                "{status:?} should be idempotent"
            );
        }
    }

    #[test]
    fn test_conflict_accepted_cannot_cancel() {
        let mut invite = test_invite();
        invite.status = InviteStatus::Accepted;
        assert!(!invite.can_transition_to(InviteStatus::Canceled));
    }

    #[test]
    fn test_conflict_canceled_cannot_accept() {
        let mut invite = test_invite();
        invite.status = InviteStatus::Canceled;
        assert!(!invite.can_transition_to(InviteStatus::Accepted));
    }

    #[test]
    fn test_is_terminal() {
        assert!(!InviteStatus::Pending.is_terminal());
        assert!(InviteStatus::Accepted.is_terminal());
        assert!(InviteStatus::Declined.is_terminal());
        assert!(InviteStatus::Expired.is_terminal());
        assert!(InviteStatus::Canceled.is_terminal());
    }

    // ── Token redaction ──────────────────────────────────────────────────

    #[test]
    fn test_detail_pre_accept_no_tokens() {
        let invite = test_invite();
        let detail = invite.to_detail_response("alice");
        assert!(detail.session_id.is_none());
        assert!(detail.submit_token.is_none());
        assert!(detail.read_token.is_none());

        let detail = invite.to_detail_response("bob");
        assert!(detail.session_id.is_none());
        assert!(detail.submit_token.is_none());
        assert!(detail.read_token.is_none());
    }

    #[test]
    fn test_detail_sender_sees_initiator_tokens_only() {
        let mut invite = test_invite();
        invite.status = InviteStatus::Accepted;
        invite.session_id = Some("sess_123".to_string());
        invite.session_tokens = Some(SessionTokens {
            initiator_submit: "is_token".to_string(),
            initiator_read: "ir_token".to_string(),
            responder_submit: "rs_token".to_string(),
            responder_read: "rr_token".to_string(),
        });

        let detail = invite.to_detail_response("alice"); // sender
        assert_eq!(detail.session_id.as_deref(), Some("sess_123"));
        assert_eq!(detail.submit_token.as_deref(), Some("is_token"));
        assert_eq!(detail.read_token.as_deref(), Some("ir_token"));
    }

    #[test]
    fn test_detail_recipient_sees_responder_tokens_only() {
        let mut invite = test_invite();
        invite.status = InviteStatus::Accepted;
        invite.session_id = Some("sess_123".to_string());
        invite.session_tokens = Some(SessionTokens {
            initiator_submit: "is_token".to_string(),
            initiator_read: "ir_token".to_string(),
            responder_submit: "rs_token".to_string(),
            responder_read: "rr_token".to_string(),
        });

        let detail = invite.to_detail_response("bob"); // recipient
        assert_eq!(detail.session_id.as_deref(), Some("sess_123"));
        assert_eq!(detail.submit_token.as_deref(), Some("rs_token"));
        assert_eq!(detail.read_token.as_deref(), Some("rr_token"));
    }

    #[test]
    fn test_detail_third_party_sees_no_tokens() {
        let mut invite = test_invite();
        invite.status = InviteStatus::Accepted;
        invite.session_id = Some("sess_123".to_string());
        invite.session_tokens = Some(SessionTokens {
            initiator_submit: "is_token".to_string(),
            initiator_read: "ir_token".to_string(),
            responder_submit: "rs_token".to_string(),
            responder_read: "rr_token".to_string(),
        });

        let detail = invite.to_detail_response("charlie"); // third party
        assert!(detail.session_id.is_none());
        assert!(detail.submit_token.is_none());
        assert!(detail.read_token.is_none());
    }

    #[test]
    fn test_detail_recipient_cannot_see_initiator_tokens() {
        let mut invite = test_invite();
        invite.status = InviteStatus::Accepted;
        invite.session_id = Some("sess_123".to_string());
        invite.session_tokens = Some(SessionTokens {
            initiator_submit: "is_secret".to_string(),
            initiator_read: "ir_secret".to_string(),
            responder_submit: "rs_token".to_string(),
            responder_read: "rr_token".to_string(),
        });

        let detail = invite.to_detail_response("bob"); // recipient
                                                       // Must NOT contain initiator tokens
        assert_ne!(detail.submit_token.as_deref(), Some("is_secret"));
        assert_ne!(detail.read_token.as_deref(), Some("ir_secret"));
    }

    #[test]
    fn test_detail_sender_cannot_see_responder_tokens() {
        let mut invite = test_invite();
        invite.status = InviteStatus::Accepted;
        invite.session_id = Some("sess_123".to_string());
        invite.session_tokens = Some(SessionTokens {
            initiator_submit: "is_token".to_string(),
            initiator_read: "ir_token".to_string(),
            responder_submit: "rs_secret".to_string(),
            responder_read: "rr_secret".to_string(),
        });

        let detail = invite.to_detail_response("alice"); // sender
                                                         // Must NOT contain responder tokens
        assert_ne!(detail.submit_token.as_deref(), Some("rs_secret"));
        assert_ne!(detail.read_token.as_deref(), Some("rr_secret"));
    }

    // ── Structured confirmation: contract_json ───────────────────────────

    #[test]
    fn test_detail_includes_contract_json() {
        let invite = test_invite();
        let detail = invite.to_detail_response("bob"); // recipient
                                                       // contract_json must be a non-null object matching the contract
        assert!(
            detail.contract_json.is_object(),
            "contract_json must be an object"
        );
        let obj = detail.contract_json.as_object().unwrap();
        assert_eq!(obj["purpose_code"], "COMPATIBILITY");
        assert!(obj["participants"].is_array());
        let participants = obj["participants"].as_array().unwrap();
        assert_eq!(participants.len(), 2);
        assert_eq!(participants[0], "alice");
        assert_eq!(participants[1], "bob");
    }

    #[test]
    fn test_detail_contract_json_serialization_roundtrip() {
        let invite = test_invite();
        let detail = invite.to_detail_response("alice");
        // Serialize to JSON string and back
        let json_str = serde_json::to_string(&detail).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        // contract_json field must be present and be an object
        assert!(parsed["contract_json"].is_object());
        assert_eq!(parsed["contract_json"]["purpose_code"], "COMPATIBILITY");
    }

    #[test]
    fn test_detail_contract_json_present_for_both_sender_and_recipient() {
        let invite = test_invite();
        let sender_detail = invite.to_detail_response("alice");
        let recipient_detail = invite.to_detail_response("bob");
        // Both should have the same contract_json
        assert_eq!(sender_detail.contract_json, recipient_detail.contract_json);
        assert!(sender_detail.contract_json.is_object());
    }
}
