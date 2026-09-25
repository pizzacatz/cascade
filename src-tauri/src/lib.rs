//! Cascade's Tauri backend: a thin OS-integration layer. The frontend owns the
//! document model, rendering, and printer encoding; the backend forwards the
//! command line, talks to CUPS, Bluetooth LE printers and MQTT brokers, and
//! shows the window once the UI has painted.

mod bluetooth;
mod cli;
mod mqtt;
mod printing;
mod state;

use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager, WebviewWindow};

use state::AppState;

/// Reveal and focus the main window. It starts hidden; the frontend calls this
/// after its first paint. Focus can be refused (e.g. on Wayland) — ignore that.
#[tauri::command]
fn show_window(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    if let Err(e) = window.set_focus() {
        log::warn!("could not focus the window: {e}");
    }
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Work around WebKitGTK rendering issues (blank windows with the DMA-BUF
/// renderer on some GPU/compositor combinations). Users can override it.
fn apply_linux_workarounds() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

pub fn run() {
    // Answers --help/--version and waiting CLI commands; returns only when the
    // GUI should start.
    cli::run_client_role_if_requested();
    apply_linux_workarounds();
    mqtt::install_crypto_provider();

    let argv: Vec<String> = std::env::args().collect();
    let (startup_payload, startup_endpoint) = cli::payload_from_argv(
        &argv,
        cli::current_dir_string(),
        cli::SOURCE_INITIAL,
        cli::now_ms(),
    );

    let mut builder = tauri::Builder::default();

    // Must be registered first. A second launch (e.g. double-clicking another
    // .col file) forwards its argv here instead of opening another window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            focus_main_window(app);
            let (payload, endpoint) =
                cli::payload_from_argv(&argv, cwd, cli::SOURCE_SINGLE_INSTANCE, cli::now_ms());
            let st = app.state::<AppState>();
            if let Some(ep) = endpoint {
                st.replies.lock().unwrap().insert(ep.request_id.clone(), ep);
            }
            let Some(payload) = payload else { return };
            if st.cli_ready.load(Ordering::SeqCst) {
                let _ = app.emit("cli-command", payload);
            } else {
                st.pending.lock().unwrap().push(payload);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(AppState::new(startup_payload, startup_endpoint))
        .manage(bluetooth::BluetoothState::default())
        .invoke_handler(tauri::generate_handler![
            show_window,
            cli::get_startup_payload,
            cli::mark_cli_ready,
            cli::normalize_path,
            cli::validate_cli_request,
            cli::complete_cli_request,
            printing::get_all_printers,
            printing::print_raw,
            printing::print_image,
            bluetooth::scan_bluetooth_printers,
            bluetooth::connect_bluetooth_printer,
            bluetooth::disconnect_bluetooth_printer,
            bluetooth::get_bluetooth_connection_status,
            bluetooth::print_bluetooth,
            mqtt::send_mqtt_message,
            mqtt::send_mqtt_messages_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cascade");
}
