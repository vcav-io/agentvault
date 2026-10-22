# Heartbeat checklist

1. Check for in-progress Selkey sessions: read `.selkey/active_sessions.json`.
   Skip entries where `due_at` is more than 30 seconds in the future — they're not
   ready yet. From the remaining entries, pick the most urgent and call
   `selkey.relay_signal` with `{ "resume_token": "<value>" }`. Follow
   `resume_strategy` in the response.

2. Check for pending Selkey invites: call `selkey.get_identity`. If
   `pending_invites > 0`, follow `next_action` (call `selkey.relay_signal`
   in RESPOND mode with your private context).

3. If nothing to do: HEARTBEAT_OK
