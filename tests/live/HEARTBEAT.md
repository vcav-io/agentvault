# Heartbeat checklist

- Check for pending AgentVault invites: call `agentvault.get_identity`. If `pending_invites > 0`, follow `next_action` (call `agentvault.relay_signal` in RESPOND mode).
