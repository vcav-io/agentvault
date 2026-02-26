use std::process::Command;

fn main() {
    // Rerun if the git HEAD changes (e.g. new commit, branch switch).
    // Path is relative to this package directory, pointing to the repo root .git.
    println!("cargo:rerun-if-changed=../../.git/HEAD");

    let sha = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=VCAV_GIT_SHA={sha}");
}
