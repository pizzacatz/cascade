use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::cli::ReplyEndpoint;

/// A command handed to the frontend from the command line, either at startup
/// or forwarded by a second instance through the single-instance plugin.
///
/// Serialized camelCase: `{ argv, cwd, source, requestId? }`. `argv` holds the
/// user's arguments (the executable path and internal flags removed); the
/// frontend interprets the command grammar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliPayload {
    pub argv: Vec<String>,
    pub cwd: String,
    /// `"initial-process"` or `"single-instance"`.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Process-wide backend state shared across command invocations.
pub struct AppState {
    /// The payload built from the initial process argv. Taken once by
    /// `get_startup_payload`.
    pub startup_payload: Mutex<Option<CliPayload>>,
    /// Whether the frontend has registered its `cli-command` listener.
    pub cli_ready: AtomicBool,
    /// Payloads forwarded before the frontend was ready; drained by
    /// `mark_cli_ready`.
    pub pending: Mutex<Vec<CliPayload>>,
    /// Reply endpoints of waiting CLI clients, keyed by request id.
    pub replies: Mutex<HashMap<String, ReplyEndpoint>>,
}

impl AppState {
    pub fn new(startup_payload: Option<CliPayload>, endpoint: Option<ReplyEndpoint>) -> Self {
        let mut replies = HashMap::new();
        if let Some(ep) = endpoint {
            replies.insert(ep.request_id.clone(), ep);
        }
        Self {
            startup_payload: Mutex::new(startup_payload),
            cli_ready: AtomicBool::new(false),
            pending: Mutex::new(Vec::new()),
            replies: Mutex::new(replies),
        }
    }
}
