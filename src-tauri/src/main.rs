// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // git/ssh start rugitg as GIT_ASKPASS/SSH_ASKPASS to ask for credentials.
    if let Some(code) = rugitg_lib::askpass_helper() {
        std::process::exit(code);
    }
    rugitg_lib::run()
}
