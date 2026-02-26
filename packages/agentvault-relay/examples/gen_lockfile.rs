/// Generates model_profiles.lock for a given directory.
/// Usage: cargo run --example gen_lockfile -- <dir>
fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("Usage: gen_lockfile <prompt_programs_dir>");
    agentvault_relay::prompt_program::generate_model_profile_lockfile(&dir)
        .expect("failed to generate lockfile");
}
