/// Generates relay_policies.lock for a given directory.
/// Usage: cargo run --example gen_enforcement_lockfile -- <relay_policies_dir>
fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("Usage: gen_enforcement_lockfile <relay_policies_dir>");
    agentvault_relay::enforcement_policy::generate_enforcement_lockfile(&dir)
        .expect("failed to generate enforcement lockfile");
}
