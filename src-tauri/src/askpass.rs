//! Credential prompts for git and ssh.
//!
//! rugitg registers its own executable as `GIT_ASKPASS` and `SSH_ASKPASS` for
//! every git command it runs. When git or ssh needs a username, password,
//! key passphrase or host key confirmation, it starts that executable with
//! the prompt as argument. In that "helper" mode rugitg does not open a
//! window: it connects to the running application over a loopback socket
//! (authenticated with a random token), the application shows a dialog, and
//! the helper prints the answer to stdout for git/ssh to read.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, LazyLock, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const ENV_PORT: &str = "RUGITG_ASKPASS_PORT";
const ENV_TOKEN: &str = "RUGITG_ASKPASS_TOKEN";
/// Identifies the git command a prompt belongs to.
const ENV_SESSION: &str = "RUGITG_ASKPASS_SESSION";
/// How long a prompt may stay unanswered before the helper gives up.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15 * 60);

struct Server {
    port: u16,
    token: String,
    exe: PathBuf,
}

static SERVER: OnceLock<Server> = OnceLock::new();
static PENDING: LazyLock<Mutex<HashMap<u64, mpsc::Sender<Option<String>>>>> = LazyLock::new(Default::default);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
/// Git commands whose prompt the user cancelled: later prompts of the same
/// command (ssh asks up to three times) are refused without a dialog.
static CANCELLED: LazyLock<Mutex<HashSet<u64>>> = LazyLock::new(Default::default);

#[derive(Serialize, Deserialize)]
struct Request {
    token: String,
    #[serde(default)]
    session: u64,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Reply {
    value: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AskpassEvent {
    pub id: u64,
    pub prompt: String,
    /// "confirm" (yes/no question), "username", "passphrase" or "password".
    pub kind: &'static str,
}

fn classify(prompt: &str) -> &'static str {
    let p = prompt.to_ascii_lowercase();
    if p.contains("(yes/no") {
        "confirm"
    } else if p.starts_with("username") {
        "username"
    } else if p.contains("passphrase") {
        "passphrase"
    } else {
        "password"
    }
}

// ------------------------------------------------------------------ helper side

/// When rugitg was started by git/ssh as an askpass program, answers the
/// prompt and returns the process exit code. Returns None for a normal start.
pub fn helper_main() -> Option<i32> {
    let port: u16 = std::env::var(ENV_PORT).ok()?.parse().ok()?;
    let token = std::env::var(ENV_TOKEN).ok()?;
    let session = std::env::var(ENV_SESSION).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let prompt = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    Some(match ask(port, Request { token, session, prompt }) {
        Ok(Some(value)) => {
            let mut out = std::io::stdout();
            let _ = out.write_all(value.as_bytes());
            let _ = out.write_all(b"\n");
            let _ = out.flush();
            0
        }
        // Cancelled by the user or the application is gone: fail the prompt.
        _ => 1,
    })
}

fn ask(port: u16, req: Request) -> std::io::Result<Option<String>> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))?;
    stream.set_read_timeout(Some(ANSWER_TIMEOUT + Duration::from_secs(30)))?;
    let mut line = serde_json::to_vec(&req)?;
    line.push(b'\n');
    stream.write_all(&line)?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply)?;
    let reply: Reply = serde_json::from_str(&reply)?;
    Ok(reply.value)
}

// ------------------------------------------------------------------ application side

/// Starts the loopback server that receives prompts from helper processes.
pub fn start(app: AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    let token: String = raw.iter().map(|b| format!("{:02x}", b)).collect();
    // In an AppImage the binary lives inside the mounted image and needs the
    // image's environment, so git must start the AppImage file itself.
    let exe = match std::env::var_os("APPIMAGE").filter(|_| crate::hostenv::in_appimage()) {
        Some(image) => PathBuf::from(image),
        None => std::env::current_exe().map_err(|e| e.to_string())?,
    };
    SERVER
        .set(Server { port, token, exe })
        .map_err(|_| "askpass server already started".to_string())?;
    std::thread::Builder::new()
        .name("askpass".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = handle(app, stream);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn handle(app: AppHandle, stream: TcpStream) -> std::io::Result<()> {
    let server = SERVER.get().ok_or(std::io::ErrorKind::NotConnected)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let req: Request = serde_json::from_str(&line)?;
    if !constant_time_eq(req.token.as_bytes(), server.token.as_bytes()) {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    let value = if req.session != 0 && CANCELLED.lock().contains(&req.session) {
        None
    } else {
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        PENDING.lock().insert(id, tx);
        let prompt = req.prompt.trim_end().to_string();
        let kind = classify(&prompt);
        let _ = app.emit("askpass-request", AskpassEvent { id, prompt, kind });
        let value = rx.recv_timeout(ANSWER_TIMEOUT).unwrap_or(None);
        PENDING.lock().remove(&id);
        let _ = app.emit("askpass-done", id);
        // "no" to a host key question is an answer; only a dismissed dialog cancels.
        if value.is_none() && req.session != 0 {
            CANCELLED.lock().insert(req.session);
        }
        value
    };
    let mut out = serde_json::to_vec(&Reply { value })?;
    out.push(b'\n');
    let mut stream = stream;
    stream.write_all(&out)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Delivers the user's answer (None = cancelled) to a waiting prompt.
pub fn reply(id: u64, value: Option<String>) {
    if let Some(tx) = PENDING.lock().remove(&id) {
        let _ = tx.send(value);
    }
}

/// Makes a git command use rugitg for credential prompts. An askpass program
/// the user already configured through the environment is left in place.
pub fn configure(cmd: &mut Command) {
    let Some(s) = SERVER.get() else { return };
    cmd.env(ENV_PORT, s.port.to_string());
    cmd.env(ENV_TOKEN, &s.token);
    cmd.env(ENV_SESSION, NEXT_SESSION.fetch_add(1, Ordering::SeqCst).to_string());
    if std::env::var_os("GIT_ASKPASS").is_none() {
        cmd.env("GIT_ASKPASS", &s.exe);
    }
    if std::env::var_os("SSH_ASKPASS").is_none() {
        cmd.env("SSH_ASKPASS", &s.exe);
        // Use askpass even without $DISPLAY (Wayland, Windows) or with a terminal.
        cmd.env("SSH_ASKPASS_REQUIRE", "force");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_prompts() {
        assert_eq!(classify("Username for 'https://github.com': "), "username");
        assert_eq!(classify("Password for 'https://me@github.com': "), "password");
        assert_eq!(classify("Enter passphrase for key '/home/me/.ssh/id_ed25519': "), "passphrase");
        assert_eq!(
            classify("Are you sure you want to continue connecting (yes/no/[fingerprint])? "),
            "confirm"
        );
        assert_eq!(classify("me@host's password: "), "password");
    }

    #[test]
    fn token_compare() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
