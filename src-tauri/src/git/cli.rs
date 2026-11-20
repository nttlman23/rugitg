//! Running the `git` command line tool for operations that modify the
//! repository. Using the real git guarantees identical semantics to the
//! command line: hooks, filters (LFS), credential helpers, GPG signing, etc.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

pub fn command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir);
    // Never block waiting for input on a terminal that does not exist;
    // credentials are asked for in a dialog through GIT_ASKPASS/SSH_ASKPASS.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    crate::askpass::configure(&mut cmd);
    cmd.env("GIT_EDITOR", "true");
    cmd.env("GIT_MERGE_AUTOEDIT", "no");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs git and returns stdout. On failure returns stderr (or stdout).
pub fn run(dir: &Path, args: &[String], stdin: Option<&[u8]>) -> Result<String, String> {
    let mut cmd = command(dir);
    cmd.args(args);
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Не найден исполняемый файл git. Установите Git и добавьте его в PATH. / git executable not found in PATH.".to_string()
        } else {
            e.to_string()
        }
    })?;
    if let Some(data) = stdin {
        if let Some(mut si) = child.stdin.take() {
            si.write_all(data).map_err(|e| e.to_string())?;
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if out.status.success() {
        Ok(if stdout.trim().is_empty() { stderr } else { stdout })
    } else {
        let msg = if stderr.trim().is_empty() { stdout } else { stderr };
        Err(if msg.trim().is_empty() {
            format!("git {} failed ({})", args.first().map(|s| s.as_str()).unwrap_or(""), out.status)
        } else {
            msg.trim_end().to_string()
        })
    }
}
