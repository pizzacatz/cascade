//! Cascade's Tauri backend: a thin OS-integration layer. The frontend owns the
//! document model, rendering, and printer encoding; the backend forwards the
//! command line, talks to CUPS, Bluetooth LE printers and MQTT brokers, and
//! shows the window once the UI has painted.

mod bluetooth;
mod cli;
mod mqtt;
mod portable;
mod printing;
mod remote;
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
    // Before anything reads the XDG directories (GTK, WebKit, Tauri paths).
    if let Some(dir) = portable::init() {
        eprintln!("Cascade portable mode: data in {}", dir.display());
    }
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

    let context = tauri::generate_context!();
    let portable_data = portable::app_data_dir(&context.config().identifier);

    // Logs default to the OS log dir, which only follows the portable folder
    // on Linux; elsewhere write them into it directly.
    let mut log_plugin = tauri_plugin_log::Builder::new().level(log::LevelFilter::Info);
    if let Some(dir) = &portable_data {
        use tauri_plugin_log::{Target, TargetKind};
        log_plugin = log_plugin.clear_targets().targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::Folder { path: dir.join("logs"), file_name: None }),
        ]);
    }

    builder
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(log_plugin.build())
        .setup(move |app| {
            // The main window is created here rather than from the config
            // (`create: false`) so its webview data can follow portable mode.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("no main window in tauri.conf.json")?;
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
            if let Some(dir) = &portable_data {
                window = window.data_directory(dir.join("webview"));
                // Backups are read and written through the fs plugin, whose
                // scope only covers the usual per-user folders.
                use tauri_plugin_fs::FsExt;
                app.fs_scope().allow_directory(dir, true)?;
            }
            window.build()?;
            Ok(())
        })
        .manage(AppState::new(startup_payload, startup_endpoint))
        .manage(bluetooth::BluetoothState::default())
        .manage(remote::RemoteState::default())
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
            portable::portable_status,
            portable::enable_portable_mode,
            remote::remote_stack_start,
            remote::remote_stack_stop,
            remote::remote_stack_update,
        ])
        .run(context)
        .expect("error while running Cascade");
}
