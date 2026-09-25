//! Bluetooth LE receipt printers (btleplug; BlueZ over D-Bus on Linux).
//!
//! One printer connection is kept in memory. Devices are recognised through a
//! small table of printer profiles that decide the command language, the
//! codepage mapping handed to the frontend encoder, and the GATT
//! characteristic that receives print data.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use btleplug::api::{Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;

const SCAN_DURATION: Duration = Duration::from_secs(5);

/// Microchip/ISSC transparent UART service and its write characteristic.
const ISSC_SERVICE: Uuid = Uuid::from_u128(0x49535343_fe7d_4ae5_8fa9_9fafd205e455);
const ISSC_WRITE: Uuid = Uuid::from_u128(0x49535343_8841_43f4_a8d4_ecbe34729bb3);
/// Service 0x18F0 / characteristic 0x2AF1 used by many generic ESC/POS printers.
const GENERIC_SERVICE: Uuid = Uuid::from_u128(0x000018f0_0000_1000_8000_00805f9b34fb);
const GENERIC_WRITE: Uuid = Uuid::from_u128(0x00002af1_0000_1000_8000_00805f9b34fb);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Match {
    NamePrefix(&'static str),
    ExactName(&'static str),
    Service,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PrinterProfile {
    pub matcher: Match,
    pub service_uuid: Uuid,
    pub characteristic_uuid: Uuid,
    /// esc-pos | star-line | star-prnt
    pub language: &'static str,
    /// A codepage mapping known to the frontend's receipt encoder.
    pub codepage_mapping: &'static str,
    pub chunk_size: usize,
}

/// Name-based profiles come first; service-based fallbacks last. First match wins.
pub static PROFILES: &[PrinterProfile] = &[
    PrinterProfile {
        matcher: Match::NamePrefix("TM-P"),
        service_uuid: ISSC_SERVICE,
        characteristic_uuid: ISSC_WRITE,
        language: "esc-pos",
        codepage_mapping: "epson",
        chunk_size: 100,
    },
    PrinterProfile {
        matcher: Match::NamePrefix("STAR L"),
        service_uuid: ISSC_SERVICE,
        characteristic_uuid: ISSC_WRITE,
        language: "star-line",
        codepage_mapping: "star",
        chunk_size: 100,
    },
    PrinterProfile {
        matcher: Match::ExactName("BlueTooth Printer"),
        service_uuid: GENERIC_SERVICE,
        characteristic_uuid: GENERIC_WRITE,
        language: "esc-pos",
        codepage_mapping: "pos-5890",
        chunk_size: 100,
    },
    PrinterProfile {
        matcher: Match::ExactName("Printer001"),
        service_uuid: GENERIC_SERVICE,
        characteristic_uuid: GENERIC_WRITE,
        language: "esc-pos",
        codepage_mapping: "xprinter",
        chunk_size: 100,
    },
    PrinterProfile {
        matcher: Match::ExactName("MPT-II"),
        service_uuid: GENERIC_SERVICE,
        characteristic_uuid: GENERIC_WRITE,
        language: "esc-pos",
        codepage_mapping: "mpt",
        chunk_size: 100,
    },
    PrinterProfile {
        matcher: Match::Service,
        service_uuid: GENERIC_SERVICE,
        characteristic_uuid: GENERIC_WRITE,
        language: "esc-pos",
        codepage_mapping: "epson",
        chunk_size: 100,
    },
    PrinterProfile {
        matcher: Match::Service,
        service_uuid: ISSC_SERVICE,
        characteristic_uuid: ISSC_WRITE,
        language: "esc-pos",
        codepage_mapping: "epson",
        chunk_size: 100,
    },
];

pub fn find_profile(name: &str, services: &[Uuid]) -> Option<&'static PrinterProfile> {
    PROFILES.iter().find(|p| match p.matcher {
        Match::NamePrefix(prefix) => name.starts_with(prefix),
        Match::ExactName(exact) => name == exact,
        Match::Service => services.contains(&p.service_uuid),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BluetoothPrinterInfo {
    pub id: String,
    pub name: String,
    pub language: String,
    pub codepage_mapping: String,
    pub rssi: Option<i16>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BluetoothConnectionStatus {
    pub is_connected: bool,
    pub connected_device: Option<BluetoothPrinterInfo>,
    pub is_scanning: bool,
}

#[derive(Default)]
struct Connection {
    peripheral: Option<Peripheral>,
    characteristic: Option<Characteristic>,
    profile: Option<&'static PrinterProfile>,
    device: Option<BluetoothPrinterInfo>,
}

impl Connection {
    fn clear(&mut self) {
        *self = Connection::default();
    }
}

/// Managed Tauri state for the Bluetooth subsystem.
#[derive(Default)]
pub struct BluetoothState {
    conn: Mutex<Connection>,
    scanning: AtomicBool,
}

/// Resets the scanning flag on every exit path.
struct ScanGuard<'a>(&'a AtomicBool);
impl Drop for ScanGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn adapter() -> Result<Adapter, String> {
    let manager = Manager::new()
        .await
        .map_err(|e| format!("Bluetooth is unavailable (is BlueZ running?): {e}"))?;
    manager
        .adapters()
        .await
        .map_err(|e| format!("Failed to get Bluetooth adapters: {e}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "No Bluetooth adapter found".to_string())
}

fn info_for(p: &Peripheral, name: String, rssi: Option<i16>, profile: &PrinterProfile) -> BluetoothPrinterInfo {
    BluetoothPrinterInfo {
        id: p.id().to_string(),
        name,
        language: profile.language.to_string(),
        codepage_mapping: profile.codepage_mapping.to_string(),
        rssi,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn scan_bluetooth_printers(
    state: State<'_, BluetoothState>,
) -> Result<Vec<BluetoothPrinterInfo>, String> {
    if state
        .scanning
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Scan already in progress".into());
    }
    let _guard = ScanGuard(&state.scanning);

    let adapter = adapter().await?;
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| format!("Failed to start scan: {e}"))?;
    tokio::time::sleep(SCAN_DURATION).await;
    if let Err(e) = adapter.stop_scan().await {
        log::warn!("failed to stop Bluetooth scan: {e}");
    }
    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|e| format!("Failed to get peripherals: {e}"))?;

    let mut found = Vec::new();
    for p in peripherals {
        let Ok(Some(props)) = p.properties().await else {
            continue;
        };
        let Some(name) = props.local_name.or(props.advertisement_name) else {
            continue;
        };
        if let Some(profile) = find_profile(&name, &props.services) {
            found.push(info_for(&p, name, props.rssi, profile));
        }
    }
    // Strongest signal first; cached out-of-range devices (no RSSI) last.
    found.sort_by_key(|i| std::cmp::Reverse(i.rssi.unwrap_or(i16::MIN)));
    Ok(found)
}

#[tauri::command]
pub async fn connect_bluetooth_printer(
    state: State<'_, BluetoothState>,
    device_id: String,
) -> Result<BluetoothPrinterInfo, String> {
    let mut conn = state.conn.lock().await;
    if let Some(prev) = conn.peripheral.take() {
        let _ = prev.disconnect().await;
    }
    conn.clear();

    let adapter = adapter().await?;
    let peripheral = adapter
        .peripherals()
        .await
        .map_err(|e| format!("Failed to get peripherals: {e}"))?
        .into_iter()
        .find(|p| p.id().to_string() == device_id)
        .ok_or_else(|| format!("Device {device_id} not found"))?;

    peripheral
        .connect()
        .await
        .map_err(|e| format!("Failed to connect: {e}"))?;
    let setup = async {
        peripheral
            .discover_services()
            .await
            .map_err(|e| format!("Failed to discover services: {e}"))?;
        let props = peripheral
            .properties()
            .await
            .map_err(|e| format!("Failed to get properties: {e}"))?
            .ok_or_else(|| "No properties available".to_string())?;
        let name = props
            .local_name
            .or(props.advertisement_name)
            .unwrap_or_else(|| "Unknown".to_string());
        let mut services = props.services.clone();
        services.extend(peripheral.services().iter().map(|s| s.uuid));
        let profile = find_profile(&name, &services)
            .ok_or_else(|| "No compatible profile found for this device".to_string())?;
        let characteristic = peripheral
            .characteristics()
            .into_iter()
            .find(|c| c.uuid == profile.characteristic_uuid)
            .ok_or_else(|| "Print characteristic not found".to_string())?;
        Ok::<_, String>((info_for(&peripheral, name, props.rssi, profile), profile, characteristic))
    };
    match setup.await {
        Ok((info, profile, characteristic)) => {
            conn.peripheral = Some(peripheral);
            conn.characteristic = Some(characteristic);
            conn.profile = Some(profile);
            conn.device = Some(info.clone());
            Ok(info)
        }
        Err(e) => {
            let _ = peripheral.disconnect().await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn disconnect_bluetooth_printer(state: State<'_, BluetoothState>) -> Result<(), String> {
    let mut conn = state.conn.lock().await;
    if let Some(p) = conn.peripheral.as_ref() {
        if p.is_connected().await.unwrap_or(false) {
            p.disconnect()
                .await
                .map_err(|e| format!("Failed to disconnect: {e}"))?;
        }
    }
    conn.clear();
    Ok(())
}

#[tauri::command]
pub async fn get_bluetooth_connection_status(
    state: State<'_, BluetoothState>,
) -> Result<BluetoothConnectionStatus, String> {
    let conn = state.conn.lock().await;
    let is_connected = match conn.peripheral.as_ref() {
        Some(p) => p.is_connected().await.unwrap_or(false),
        None => false,
    };
    Ok(BluetoothConnectionStatus {
        is_connected,
        connected_device: conn.device.clone(),
        is_scanning: state.scanning.load(Ordering::SeqCst),
    })
}

#[tauri::command]
pub async fn print_bluetooth(state: State<'_, BluetoothState>, data: Vec<u8>) -> Result<(), String> {
    let conn = state.conn.lock().await;
    let peripheral = conn.peripheral.as_ref().ok_or("No printer connected")?;
    let profile = conn.profile.ok_or("Profile not available")?;
    let characteristic = conn
        .characteristic
        .as_ref()
        .ok_or("Print characteristic not available")?;
    if !peripheral.is_connected().await.unwrap_or(false) {
        return Err("Printer is disconnected".into());
    }
    for (i, chunk) in data.chunks(profile.chunk_size).enumerate() {
        peripheral
            .write(characteristic, chunk, WriteType::WithResponse)
            .await
            .map_err(|e| format!("Failed to write chunk {i}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_profiles_win_over_services() {
        let p = find_profile("TM-P20II", &[GENERIC_SERVICE]).unwrap();
        assert_eq!((p.language, p.codepage_mapping), ("esc-pos", "epson"));
        let p = find_profile("STAR L200", &[ISSC_SERVICE]).unwrap();
        assert_eq!((p.language, p.codepage_mapping), ("star-line", "star"));
        assert_eq!(find_profile("MPT-II", &[]).unwrap().codepage_mapping, "mpt");
        assert_eq!(find_profile("Printer001", &[]).unwrap().codepage_mapping, "xprinter");
        assert_eq!(find_profile("BlueTooth Printer", &[]).unwrap().codepage_mapping, "pos-5890");
    }

    #[test]
    fn exact_names_are_exact() {
        // "MPT-II X" is not the MPT-II profile; with no known service it's unknown.
        assert!(find_profile("MPT-II X", &[]).is_none());
    }

    #[test]
    fn service_fallbacks() {
        let p = find_profile("Some Printer", &[GENERIC_SERVICE]).unwrap();
        assert_eq!(p.characteristic_uuid, GENERIC_WRITE);
        let p = find_profile("Other", &[ISSC_SERVICE]).unwrap();
        assert_eq!(p.characteristic_uuid, ISSC_WRITE);
        assert!(find_profile("Headphones", &[Uuid::from_u128(1)]).is_none());
    }

    #[test]
    fn every_profile_uses_known_encoder_values() {
        let mappings = ["epson", "star", "pos-5890", "xprinter", "mpt"];
        for p in PROFILES {
            assert!(mappings.contains(&p.codepage_mapping));
            assert!(["esc-pos", "star-line", "star-prnt"].contains(&p.language));
            assert_eq!(p.chunk_size, 100);
        }
    }

    #[test]
    fn dto_shapes_are_snake_case() {
        let status = BluetoothConnectionStatus {
            is_connected: false,
            connected_device: Some(BluetoothPrinterInfo {
                id: "hci0/dev_AA".into(),
                name: "MPT-II".into(),
                language: "esc-pos".into(),
                codepage_mapping: "mpt".into(),
                rssi: None,
            }),
            is_scanning: false,
        };
        let v = serde_json::to_value(status).unwrap();
        assert_eq!(v["connected_device"]["codepage_mapping"], "mpt");
        assert!(v["connected_device"]["rssi"].is_null());
        assert_eq!(v["is_scanning"], false);
    }
}
