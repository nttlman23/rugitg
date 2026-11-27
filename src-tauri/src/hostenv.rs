//! Environment for child processes when rugitg runs from an AppImage.
//!
//! The AppImage's AppRun points LD_LIBRARY_PATH, PATH, XDG_DATA_DIRS, GTK_*,
//! GIO_*, … into the mounted image so that rugitg finds its bundled libraries.
//! Programs started by rugitg (git and its helpers, ssh, xdg-open, the updated
//! AppImage after an update) must not inherit that: the host's git, for
//! example, then loads the image's older libraries and fails
//! ("symbol lookup error … libcurl"). Child processes therefore get the host
//! environment back: every entry pointing into the image is removed.

use std::ffi::{OsStr, OsString};
use std::process::Command;
use std::sync::OnceLock;

/// Variables set by the AppImage runtime / AppRun hooks that describe the
/// image itself or force settings meant for rugitg only.
const IMAGE_ONLY: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD", "GTK_THEME"];

static HOST_ENV: OnceLock<Option<Vec<(OsString, OsString)>>> = OnceLock::new();

/// Computes the host environment from `vars`: drops image-only variables and
/// every path entry under `appdir`.
pub fn sanitize<I>(vars: I, appdir: &str) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let appdir = appdir.trim_end_matches('/');
    let mut out = Vec::new();
    for (k, v) in vars {
        if IMAGE_ONLY.iter().any(|n| OsStr::new(n) == k) {
            continue;
        }
        let Some(s) = v.to_str() else {
            out.push((k, v));
            continue;
        };
        if appdir.is_empty() || !s.contains(appdir) {
            out.push((k, v));
            continue;
        }
        // A list of paths: keep only the host's entries.
        let kept: Vec<&str> = s.split(':').filter(|p| !p.is_empty() && !p.starts_with(appdir)).collect();
        if !kept.is_empty() {
            out.push((k, OsString::from(kept.join(":"))));
        }
    }
    out
}

fn host_env() -> &'static Option<Vec<(OsString, OsString)>> {
    HOST_ENV.get_or_init(|| {
        std::env::var_os("APPIMAGE")?;
        let appdir = std::env::var("APPDIR").ok()?;
        Some(sanitize(std::env::vars_os(), &appdir))
    })
}

/// True when running from an AppImage.
pub fn in_appimage() -> bool {
    host_env().is_some()
}

/// Gives a child process the host environment (no-op outside an AppImage).
/// Call it before setting the command's own variables.
pub fn apply(cmd: &mut Command) {
    if let Some(env) = host_env() {
        cmd.env_clear();
        cmd.envs(env.iter().map(|(k, v)| (k, v)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    fn get<'a>(e: &'a [(OsString, OsString)], k: &str) -> Option<&'a str> {
        e.iter().find(|(n, _)| n == k).and_then(|(_, v)| v.to_str())
    }

    #[test]
    fn removes_image_paths() {
        let m = "/tmp/.mount_rugitgAB12";
        let e = sanitize(
            env(&[
                ("LD_LIBRARY_PATH", &format!("{m}/usr/lib/:{m}/usr/lib/x86_64-linux-gnu/:")),
                ("PATH", &format!("{m}/usr/bin/:{m}/bin/:/usr/local/bin:/usr/bin:/bin")),
                ("XDG_DATA_DIRS", &format!("{m}/usr/share/:/usr/share:/usr/local/share/")),
                ("GTK_PATH", &format!("{m}//usr/lib/gtk-3.0")),
                ("GTK_THEME", "Adwaita:light"),
                ("APPDIR", m),
                ("APPIMAGE", "/home/me/rugitg.AppImage"),
                ("OWD", "/home/me"),
                ("HOME", "/home/me"),
                ("LANG", "ru_RU.UTF-8"),
            ]),
            m,
        );
        assert_eq!(get(&e, "LD_LIBRARY_PATH"), None);
        assert_eq!(get(&e, "PATH"), Some("/usr/local/bin:/usr/bin:/bin"));
        assert_eq!(get(&e, "XDG_DATA_DIRS"), Some("/usr/share:/usr/local/share/"));
        assert_eq!(get(&e, "GTK_PATH"), None);
        for k in ["GTK_THEME", "APPDIR", "APPIMAGE", "OWD"] {
            assert_eq!(get(&e, k), None, "{k}");
        }
        assert_eq!(get(&e, "HOME"), Some("/home/me"));
        assert_eq!(get(&e, "LANG"), Some("ru_RU.UTF-8"));
    }

    #[test]
    fn keeps_unrelated_values() {
        let e = sanitize(env(&[("PATH", "/usr/bin:/bin"), ("EDITOR", "vim")]), "/tmp/.mount_x");
        assert_eq!(get(&e, "PATH"), Some("/usr/bin:/bin"));
        assert_eq!(get(&e, "EDITOR"), Some("vim"));
    }
}
