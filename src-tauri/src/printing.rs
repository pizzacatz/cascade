//! Desktop printing through CUPS (`lpstat` / `lp`).
//!
//! The frontend renders and encodes everything; these commands only list
//! queues and hand raw bytes (ESC/POS, StarPRNT…) or a PNG to the spooler.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

const JOB_TITLE: &str = "Cascade";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrinterDto {
    pub name: String,
    /// READY | OFFLINE | PAUSED | PRINTING | UNKNOWN
    pub state: String,
    pub is_default: bool,
}

/// Run a CUPS client tool with the C locale so its output is parseable.
fn run_lpstat(args: &[&str]) -> Option<String> {
    let out = Command::new("lpstat")
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parse `lpstat -p` output into (name, state) pairs.
pub fn parse_lpstat_p(output: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("printer ") {
            let Some(name) = rest.split_whitespace().next() else {
                continue;
            };
            let state = if rest.contains("now printing") {
                "PRINTING"
            } else if rest.contains("disabled") {
                "PAUSED"
            } else if rest.contains("is idle") {
                "READY"
            } else {
                "UNKNOWN"
            };
            out.push((name.to_string(), state.to_string()));
        } else if line.starts_with(|c: char| c.is_whitespace()) {
            // Indented detail lines describe the previous printer.
            let l = line.to_ascii_lowercase();
            if l.contains("offline") || l.contains("not responding") || l.contains("not connected") {
                if let Some(last) = out.last_mut() {
                    last.1 = "OFFLINE".to_string();
                }
            }
        }
    }
    out
}

/// Parse `lpstat -d` output into the default destination name.
pub fn parse_lpstat_d(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|l| l.strip_prefix("system default destination:"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Parse `lpstat -e` output (one destination per line).
pub fn parse_lpstat_e(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn list_printers() -> Vec<PrinterDto> {
    let default = run_lpstat(&["-d"]).and_then(|o| parse_lpstat_d(&o));
    let mut printers: Vec<PrinterDto> = run_lpstat(&["-p"])
        .map(|o| parse_lpstat_p(&o))
        .unwrap_or_default()
        .into_iter()
        .map(|(name, state)| PrinterDto {
            is_default: default.as_deref() == Some(name.as_str()),
            name,
            state,
        })
        .collect();
    // Destinations such as network-discovered queues may only show up in -e.
    if let Some(e) = run_lpstat(&["-e"]) {
        for name in parse_lpstat_e(&e) {
            if !printers.iter().any(|p| p.name == name) {
                printers.push(PrinterDto {
                    is_default: default.as_deref() == Some(name.as_str()),
                    name,
                    state: "UNKNOWN".into(),
                });
            }
        }
    }
    printers
}

fn ensure_printer_exists(name: &str) -> Result<(), String> {
    let Some(e) = run_lpstat(&["-e"]) else {
        return Ok(()); // cannot check; let lp report the problem
    };
    let names = parse_lpstat_e(&e);
    if names.is_empty() || names.iter().any(|n| n == name) {
        Ok(())
    } else {
        Err(format!(
            "Printer '{name}' not found. Available printers: {}",
            names.join(", ")
        ))
    }
}

fn lp_error(output: std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let msg = stderr.trim();
    if msg.is_empty() {
        format!("lp exited with status {}", output.status)
    } else {
        format!("lp failed: {msg}")
    }
}

fn print_raw_blocking(printer: &str, data: &[u8]) -> Result<(), String> {
    ensure_printer_exists(printer)?;
    let mut child = Command::new("lp")
        .args(["-d", printer, "-o", "raw", "-t", JOB_TITLE])
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run lp (is CUPS installed?): {e}"))?;
    child
        .stdin
        .take()
        .ok_or("Failed to open lp stdin")?
        .write_all(data)
        .map_err(|e| format!("Failed to send data to lp: {e}"))?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(lp_error(output))
    }
}

pub fn media_option(width_mm: u32, height_mm: u32) -> String {
    format!("media=Custom.{width_mm}x{height_mm}mm")
}

fn print_image_blocking(printer: &str, png: &[u8], width_mm: u32, height_mm: u32) -> Result<(), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    ensure_printer_exists(printer)?;
    let mut tmp = std::env::temp_dir();
    tmp.push(format!(
        "cascade-print-{}-{}.png",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, png).map_err(|e| format!("Failed to write temporary image: {e}"))?;
    let result = Command::new("lp")
        .args(["-d", printer, "-t", JOB_TITLE, "-o"])
        .arg(media_option(width_mm, height_mm))
        .args(["-o", "orientation-requested=3", "-o", "fit-to-page"])
        .arg(&tmp)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output();
    let _ = std::fs::remove_file(&tmp);
    match result {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(lp_error(o)),
        Err(e) => Err(format!("Failed to run lp (is CUPS installed?): {e}")),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// List installed CUPS destinations. Empty when CUPS is unavailable.
#[tauri::command]
pub async fn get_all_printers() -> Vec<PrinterDto> {
    tauri::async_runtime::spawn_blocking(list_printers)
        .await
        .unwrap_or_default()
}

/// Send raw printer-language bytes to a CUPS queue unchanged.
#[tauri::command]
pub async fn print_raw(printer: String, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || print_raw_blocking(&printer, &data))
        .await
        .map_err(|e| e.to_string())?
}

/// Print a PNG on custom media of the given size (millimetres).
#[tauri::command]
pub async fn print_image(
    printer_name: String,
    png_data: Vec<u8>,
    width_mm: u32,
    height_mm: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        print_image_blocking(&printer_name, &png_data, width_mm, height_mm)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "\
printer Office is idle.  enabled since Thu 01 Jan 2026 10:00:00 AM
printer Receipt now printing Receipt-42.  enabled since Thu 01 Jan 2026
printer Label disabled since Thu 01 Jan 2026 -
\treason unknown
printer Remote is idle.  enabled since Thu 01 Jan 2026
\tThe printer is not responding.
printer Odd state
";

    #[test]
    fn parses_lpstat_p() {
        let v = parse_lpstat_p(P);
        let states: Vec<_> = v.iter().map(|(n, s)| format!("{n}={s}")).collect();
        assert_eq!(
            states,
            vec!["Office=READY", "Receipt=PRINTING", "Label=PAUSED", "Remote=OFFLINE", "Odd=UNKNOWN"]
        );
    }

    #[test]
    fn parses_default_and_e() {
        assert_eq!(
            parse_lpstat_d("system default destination: Office\n").as_deref(),
            Some("Office")
        );
        assert_eq!(parse_lpstat_d("no system default destination\n"), None);
        assert_eq!(parse_lpstat_e("A\n\n B \n"), vec!["A", "B"]);
    }

    #[test]
    fn media_string() {
        assert_eq!(media_option(58, 120), "media=Custom.58x120mm");
    }

    #[test]
    fn printer_dto_shape() {
        let v = serde_json::to_value(PrinterDto {
            name: "x".into(),
            state: "READY".into(),
            is_default: true,
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({"name": "x", "state": "READY", "is_default": true}));
    }
}
