//! Command-line handling.
//!
//! The binary plays two roles:
//!
//! * **Client role** — for "waiting" commands (`prepare-calendar ...`, or
//!   `print ... --wait`) the process that the user started binds a loopback
//!   socket, respawns itself as the GUI with a hidden `--cascade-cli-reply`
//!   argument describing that socket, waits for the GUI to report the result,
//!   prints it as JSON and exits with a meaningful status code. `--help` and
//!   `--version` are also answered here without starting the GUI.
//! * **App role** — the GUI turns its argv (or a second instance's forwarded
//!   argv) into a [`CliPayload`] for the frontend, and remembers any reply
//!   endpoint so `complete_cli_request` can answer the waiting client.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::{AppState, CliPayload};

/// Hidden flag carrying a JSON [`ReplyEndpoint`]. Internal to the binary.
pub const CLI_REPLY_FLAG: &str = "--cascade-cli-reply";

/// How long a waiting client waits for the GUI, and how long an endpoint lives.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(120);

/// Largest reply the client accepts.
const MAX_REPLY_BYTES: u64 = 16 * 1024 * 1024;

pub const SOURCE_INITIAL: &str = "initial-process";
pub const SOURCE_SINGLE_INSTANCE: &str = "single-instance";

/// Where a waiting CLI client listens for its result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyEndpoint {
    /// Loopback socket address, e.g. `127.0.0.1:54123`.
    pub address: String,
    /// Shared secret the reply must echo back.
    pub token: String,
    pub request_id: String,
    /// Expiry as Unix time in milliseconds.
    pub expires_at: u64,
}

/// The single message sent from the GUI back to the waiting client.
#[derive(Debug, Serialize, Deserialize)]
struct ReplyMessage {
    token: String,
    result: serde_json::Value,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// argv handling
// ---------------------------------------------------------------------------

/// Split raw user arguments (argv without the executable path) into the
/// arguments to hand to the frontend and the raw reply-endpoint JSON, if any.
///
/// Only internal tokens are removed: macOS `-psn_*` process serial numbers and
/// the reply flag together with its value (both `--flag value` and
/// `--flag=value`). Every other argument, including user flags such as
/// `--file` or `--date`, is preserved in order.
pub fn split_args(args: &[String]) -> (Vec<String>, Option<String>) {
    let mut out = Vec::new();
    let mut reply = None;
    let mut iter = args.iter();
    while let Some(a) = iter.next() {
        if a == CLI_REPLY_FLAG {
            if let Some(v) = iter.next() {
                reply = Some(v.clone());
            }
            continue;
        }
        if let Some(v) = a.strip_prefix(CLI_REPLY_FLAG).and_then(|r| r.strip_prefix('=')) {
            reply = Some(v.to_string());
            continue;
        }
        if a.starts_with("-psn_") {
            continue;
        }
        out.push(a.clone());
    }
    (out, reply)
}

/// Whether these user arguments are a command that must wait for a result.
pub fn is_waiting_command(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("prepare-calendar") => true,
        Some("print") => args.iter().any(|a| a == "--wait"),
        _ => false,
    }
}

/// Parse and validate a reply endpoint: it must be loopback and unexpired.
pub fn parse_endpoint(json: &str, now: u64) -> Result<ReplyEndpoint, String> {
    let ep: ReplyEndpoint =
        serde_json::from_str(json).map_err(|e| format!("Invalid reply endpoint: {e}"))?;
    let addr: SocketAddr = ep
        .address
        .parse()
        .map_err(|e| format!("Invalid reply address: {e}"))?;
    if !addr.ip().is_loopback() {
        return Err("Reply address must be loopback.".into());
    }
    if ep.token.is_empty() || ep.request_id.is_empty() {
        return Err("Reply endpoint is incomplete.".into());
    }
    if ep.expires_at <= now {
        return Err("Reply endpoint has expired.".into());
    }
    Ok(ep)
}

/// Build the frontend payload (and a validated reply endpoint) from a full
/// argv including the executable path. Returns `None` for the payload when
/// there are no user arguments.
pub fn payload_from_argv(
    argv: &[String],
    cwd: String,
    source: &str,
    now: u64,
) -> (Option<CliPayload>, Option<ReplyEndpoint>) {
    let (args, reply) = split_args(argv.get(1..).unwrap_or(&[]));
    let endpoint = reply.and_then(|json| match parse_endpoint(&json, now) {
        Ok(ep) => Some(ep),
        Err(e) => {
            log::warn!("ignoring CLI reply endpoint: {e}");
            None
        }
    });
    if args.is_empty() {
        return (None, endpoint);
    }
    let payload = CliPayload {
        argv: args,
        cwd,
        source: source.to_string(),
        request_id: endpoint.as_ref().map(|e| e.request_id.clone()),
    };
    (Some(payload), endpoint)
}

pub fn current_dir_string() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Lexically normalize a path (resolve `.` and `..`) without touching disk.
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Turn a CLI-supplied path into a deterministic absolute path: `file://` URLs
/// become paths, relative paths are joined to `cwd` (or the process working
/// directory), and existing files are canonicalized.
pub fn normalize_path_impl(path: &str, cwd: Option<&str>) -> String {
    let mut p = if path.starts_with("file://") {
        match url::Url::parse(path).ok().and_then(|u| u.to_file_path().ok()) {
            Some(p) => p,
            None => PathBuf::from(path),
        }
    } else {
        PathBuf::from(path)
    };
    if p.is_relative() {
        let base = cwd
            .filter(|c| !c.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_default();
        p = base.join(p);
    }
    match std::fs::canonicalize(&p) {
        Ok(c) => c.to_string_lossy().into_owned(),
        Err(_) => lexical_normalize(&p).to_string_lossy().into_owned(),
    }
}

// ---------------------------------------------------------------------------
// Client role
// ---------------------------------------------------------------------------

pub const USAGE: &str = "\
Cascade — a horizontal, column-based nested to-do list.

Usage:
  cascade [FILE.col]
  cascade open FILE [--target ID]
  cascade print <calendar|space|item> --file FILE [--date YYYY-MM-DD | -d N]
                [--id ID] [--option task_tickets|task_tickets_recursive|
                selection_tickets|selection_tickets_recursive] [--wait]
  cascade prepare-calendar --file FILE (--date YYYY-MM-DD | -d N)
  cascade --help | --version

Waiting commands (prepare-calendar, print --wait) block until the app has
finished, print a JSON result on stdout and exit with 0 (success), 2 (no
matching recurrence rule) or 1 (error or timeout).
";

/// Map a result object to a process exit code.
pub fn exit_code_for(result: &serde_json::Value) -> i32 {
    match result.get("status").and_then(|s| s.as_str()) {
        Some("prepared" | "already_prepared" | "printed") => 0,
        Some("no_matching_rule") => 2,
        _ => 1,
    }
}

/// Handle `--help`/`--version` and waiting commands before the GUI starts.
/// Returns normally only when the process should go on to start the GUI.
pub fn run_client_role_if_requested() {
    let raw: Vec<String> = std::env::args().collect();
    let user_args = raw.get(1..).unwrap_or(&[]);
    let (args, reply) = split_args(user_args);

    if reply.is_none() {
        match args.first().map(String::as_str) {
            Some("--help" | "-h" | "help") => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            Some("--version" | "-V") => {
                println!("cascade {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            _ => {}
        }
    }

    if reply.is_some() || !is_waiting_command(&args) {
        return;
    }

    let code = match wait_for_gui(user_args) {
        Ok(result) => {
            println!("{result}");
            exit_code_for(&result)
        }
        Err(msg) => {
            let result = serde_json::json!({ "status": "error", "message": msg });
            println!("{result}");
            1
        }
    };
    std::process::exit(code);
}

fn spawn_gui(user_args: &[String], endpoint_json: &str) -> std::io::Result<()> {
    // Inside an AppImage, current_exe() points into a FUSE mount that goes away
    // when this process exits, so relaunch the AppImage itself.
    let exe = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(std::env::current_exe)?;
    let mut cmd = std::process::Command::new(exe);
    cmd.args(user_args)
        .arg(CLI_REPLY_FLAG)
        .arg(endpoint_json)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ())
}

fn wait_for_gui(user_args: &[String]) -> Result<serde_json::Value, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Cannot open reply socket: {e}"))?;
    let address = listener
        .local_addr()
        .map_err(|e| format!("Cannot read reply socket address: {e}"))?
        .to_string();
    let endpoint = ReplyEndpoint {
        address,
        token: uuid::Uuid::new_v4().to_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        expires_at: now_ms() + REPLY_TIMEOUT.as_millis() as u64,
    };
    let json = serde_json::to_string(&endpoint).map_err(|e| e.to_string())?;
    spawn_gui(user_args, &json).map_err(|e| format!("Cannot start Cascade: {e}"))?;
    accept_reply(&listener, &endpoint.token, REPLY_TIMEOUT)
}

/// Accept connections until one delivers a message with the right token, or
/// the deadline passes.
pub fn accept_reply(
    listener: &TcpListener,
    token: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Cannot configure reply socket: {e}"))?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(result) = read_reply(stream, token) {
                    return Ok(result);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Reply socket failed: {e}")),
        }
    }
    Err(format!(
        "CLI request timed out after {} seconds. The outcome is unknown.",
        timeout.as_secs()
    ))
}

fn read_reply(stream: TcpStream, token: &str) -> Option<serde_json::Value> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    let mut buf = Vec::new();
    stream.take(MAX_REPLY_BYTES).read_to_end(&mut buf).ok()?;
    let msg: ReplyMessage = serde_json::from_slice(&buf).ok()?;
    (msg.token == token).then_some(msg.result)
}

/// Send a result to a waiting client (GUI side).
pub fn send_reply(endpoint: &ReplyEndpoint, result: serde_json::Value) -> Result<(), String> {
    let addr: SocketAddr = endpoint
        .address
        .parse()
        .map_err(|e| format!("Invalid reply address: {e}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("Cannot reach the waiting command: {e}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let msg = ReplyMessage {
        token: endpoint.token.clone(),
        result,
    };
    let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
    stream
        .write_all(&bytes)
        .map_err(|e| format!("Cannot send the result: {e}"))?;
    let _ = stream.shutdown(std::net::Shutdown::Write);
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The payload built from the initial process argv, if any (consumed).
#[tauri::command]
pub fn get_startup_payload(state: State<'_, AppState>) -> Option<CliPayload> {
    state.startup_payload.lock().unwrap().take()
}

/// Mark the frontend's `cli-command` listener as ready and return any payloads
/// forwarded before it was. Always returns an array.
#[tauri::command]
pub fn mark_cli_ready(state: State<'_, AppState>) -> Vec<CliPayload> {
    state.cli_ready.store(true, Ordering::SeqCst);
    std::mem::take(&mut *state.pending.lock().unwrap())
}

/// Resolve a CLI-supplied path to an absolute path (see [`normalize_path_impl`]).
#[tauri::command]
pub fn normalize_path(path: String, cwd: Option<String>) -> String {
    normalize_path_impl(&path, cwd.as_deref())
}

fn check_request(state: &AppState, request_id: &str) -> Result<(), String> {
    let replies = state.replies.lock().unwrap();
    match replies.get(request_id) {
        None => Err("Unknown CLI request.".into()),
        Some(ep) if ep.expires_at <= now_ms() => {
            Err("CLI request expired. No action was started.".into())
        }
        Some(_) => Ok(()),
    }
}

/// Check that a waiting CLI request is known and still live. Idempotent.
#[tauri::command]
pub fn validate_cli_request(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    check_request(&state, &request_id)
}

/// Deliver a waiting CLI request's result to its client.
#[tauri::command]
pub async fn complete_cli_request(
    state: State<'_, AppState>,
    request_id: String,
    result: serde_json::Value,
) -> Result<(), String> {
    let endpoint = state
        .replies
        .lock()
        .unwrap()
        .remove(&request_id)
        .ok_or_else(|| "Unknown CLI request.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || send_reply(&endpoint, result))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn split_keeps_user_flags_and_drops_internal_ones() {
        let (args, reply) = split_args(&s(&[
            "print",
            "calendar",
            "--file",
            "a.col",
            "-psn_0_123",
            CLI_REPLY_FLAG,
            "{json}",
            "--wait",
        ]));
        assert_eq!(args, s(&["print", "calendar", "--file", "a.col", "--wait"]));
        assert_eq!(reply.as_deref(), Some("{json}"));
    }

    #[test]
    fn split_accepts_equals_form_and_trailing_flag() {
        let (args, reply) = split_args(&s(&["x.col", "--cascade-cli-reply={j}"]));
        assert_eq!(args, s(&["x.col"]));
        assert_eq!(reply.as_deref(), Some("{j}"));
        let (args, reply) = split_args(&s(&["x.col", CLI_REPLY_FLAG]));
        assert_eq!(args, s(&["x.col"]));
        assert_eq!(reply, None);
    }

    #[test]
    fn detects_waiting_commands() {
        assert!(is_waiting_command(&s(&["prepare-calendar", "--file", "a", "-d", "1"])));
        assert!(is_waiting_command(&s(&["print", "calendar", "--file", "a", "--wait"])));
        assert!(!is_waiting_command(&s(&["print", "calendar", "--file", "a"])));
        assert!(!is_waiting_command(&s(&["open", "a.col"])));
        assert!(!is_waiting_command(&s(&["a.col"])));
        assert!(!is_waiting_command(&[]));
    }

    fn endpoint(addr: &str, expires_at: u64) -> String {
        serde_json::to_string(&ReplyEndpoint {
            address: addr.into(),
            token: "t".into(),
            request_id: "r".into(),
            expires_at,
        })
        .unwrap()
    }

    #[test]
    fn endpoint_validation() {
        assert!(parse_endpoint(&endpoint("127.0.0.1:5000", 2000), 1000).is_ok());
        assert!(parse_endpoint(&endpoint("[::1]:5000", 2000), 1000).is_ok());
        assert!(parse_endpoint(&endpoint("127.0.0.1:5000", 1000), 1000).is_err());
        assert!(parse_endpoint(&endpoint("192.168.1.2:5000", 2000), 1000).is_err());
        assert!(parse_endpoint("not json", 0).is_err());
        let json = endpoint("127.0.0.1:1", 5);
        assert!(json.contains("requestId") && json.contains("expiresAt"));
    }

    #[test]
    fn payload_carries_request_id_and_all_args() {
        let argv = s(&[
            "/usr/bin/cascade",
            "prepare-calendar",
            "--file",
            "t.col",
            "-d",
            "1",
            CLI_REPLY_FLAG,
            &endpoint("127.0.0.1:9", now_ms() + 60_000),
        ]);
        let (payload, ep) = payload_from_argv(&argv, "/home".into(), SOURCE_INITIAL, now_ms());
        let payload = payload.unwrap();
        assert_eq!(payload.argv, s(&["prepare-calendar", "--file", "t.col", "-d", "1"]));
        assert_eq!(payload.request_id.as_deref(), Some("r"));
        assert_eq!(ep.unwrap().token, "t");
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["requestId"], "r");
        assert_eq!(json["source"], "initial-process");
    }

    #[test]
    fn empty_argv_has_no_payload() {
        let (payload, ep) = payload_from_argv(&s(&["/usr/bin/cascade"]), String::new(), SOURCE_INITIAL, 0);
        assert!(payload.is_none() && ep.is_none());
    }

    #[test]
    fn expired_endpoint_is_dropped_but_args_kept() {
        let argv = s(&["cascade", "print", "space", CLI_REPLY_FLAG, &endpoint("127.0.0.1:9", 10)]);
        let (payload, ep) = payload_from_argv(&argv, String::new(), SOURCE_INITIAL, 20);
        assert!(ep.is_none());
        assert_eq!(payload.unwrap().request_id, None);
    }

    #[test]
    fn normalize_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("doc.col");
        std::fs::write(&file, "{}").unwrap();
        let canon = std::fs::canonicalize(&file).unwrap().to_string_lossy().into_owned();
        let cwd = dir.path().to_string_lossy().into_owned();
        assert_eq!(normalize_path_impl("doc.col", Some(&cwd)), canon);
        assert_eq!(normalize_path_impl("./sub/../doc.col", Some(&cwd)), canon);
        let url = url::Url::from_file_path(&file).unwrap().to_string();
        assert_eq!(normalize_path_impl(&url, None), canon);
        assert_eq!(normalize_path_impl("/no/such/./x/../y.col", None), "/no/such/y.col");
        assert_eq!(
            normalize_path_impl("missing.col", Some("/base/dir")),
            "/base/dir/missing.col"
        );
    }

    #[test]
    fn exit_codes() {
        use serde_json::json;
        assert_eq!(exit_code_for(&json!({"status": "prepared"})), 0);
        assert_eq!(exit_code_for(&json!({"status": "already_prepared"})), 0);
        assert_eq!(exit_code_for(&json!({"status": "printed"})), 0);
        assert_eq!(exit_code_for(&json!({"status": "no_matching_rule"})), 2);
        assert_eq!(exit_code_for(&json!({"status": "error"})), 1);
        assert_eq!(exit_code_for(&json!({})), 1);
    }

    #[test]
    fn reply_round_trip_over_loopback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let ep = ReplyEndpoint {
            address: listener.local_addr().unwrap().to_string(),
            token: "secret".into(),
            request_id: "req".into(),
            expires_at: now_ms() + 10_000,
        };
        let bad = ReplyEndpoint { token: "wrong".into(), ..ep.clone() };
        let good = ep.clone();
        let sender = std::thread::spawn(move || {
            send_reply(&bad, serde_json::json!({"status": "error"})).unwrap();
            send_reply(&good, serde_json::json!({"status": "printed"})).unwrap();
        });
        let result = accept_reply(&listener, "secret", Duration::from_secs(5)).unwrap();
        sender.join().unwrap();
        assert_eq!(result["status"], "printed");
    }

    #[test]
    fn reply_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let err = accept_reply(&listener, "x", Duration::from_millis(100)).unwrap_err();
        assert!(err.contains("timed out"));
    }
}
