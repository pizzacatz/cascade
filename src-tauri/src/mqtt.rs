//! MQTT receipt printing: publish rendered tickets (JSON messages carrying a
//! base64 PNG, built by the frontend) to a broker topic.
//!
//! Each call opens a fresh connection, waits for the broker's ConnAck,
//! publishes every message, waits for QoS 1/2 acknowledgements, and
//! disconnects. No state is kept between calls.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS, TlsConfiguration, Transport};
use serde::Deserialize;
use tokio::sync::{oneshot, Notify};

const CONNACK_TIMEOUT: Duration = Duration::from_secs(5);
const ACK_TIMEOUT: Duration = Duration::from_secs(10);
const JOIN_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PACKET: usize = 256 * 1024;

#[derive(Debug, Default, Deserialize)]
pub struct Auth {
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct BrokerTarget {
    pub host: String,
    pub port: u16,
    pub tls: bool,
}

/// Parse a broker URL. `mqtts://`, `ssl://` and `tls://` use TLS (default
/// port 8883); anything else is plain TCP (default port 1883).
pub fn parse_broker_url(url: &str) -> Result<BrokerTarget, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid broker URL: {e}"))?;
    let host = parsed
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "Broker URL must include host".to_string())?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let tls = matches!(parsed.scheme(), "mqtts" | "ssl" | "tls");
    let port = parsed.port().unwrap_or(if tls { 8883 } else { 1883 });
    Ok(BrokerTarget { host, port, tls })
}

pub fn qos_from(level: u8) -> QoS {
    match level {
        0 => QoS::AtMostOnce,
        2 => QoS::ExactlyOnce,
        _ => QoS::AtLeastOnce,
    }
}

/// Install the ring crypto provider as the process default (once). Avoids a
/// panic when rustls cannot pick a provider on its own.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// A TLS configuration from the system trust store that skips unparsable
/// certificates instead of panicking.
fn tls_config() -> Result<TlsConfiguration, String> {
    let mut roots = rustls::RootCertStore::empty();
    let loaded = rustls_native_certs::load_native_certs();
    for e in &loaded.errors {
        log::warn!("skipping system certificate source: {e}");
    }
    let (added, skipped) = roots.add_parsable_certificates(loaded.certs);
    if skipped > 0 {
        log::warn!("skipped {skipped} unparsable system certificates");
    }
    if added == 0 {
        return Err("No usable TLS root certificates found on this system".into());
    }
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("TLS configuration failed: {e}"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(TlsConfiguration::Rustls(Arc::new(config)))
}

fn client_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("cascade-{}-{}", std::process::id(), ms)
}

/// Decrement without underflowing.
fn saturating_dec(counter: &AtomicUsize) {
    let _ = counter.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| Some(v.saturating_sub(1)));
}

pub async fn publish_batch(
    broker_url: &str,
    topic: &str,
    messages: Vec<String>,
    qos: u8,
    retain: bool,
    auth: Option<Auth>,
    delay_ms: Option<u64>,
) -> Result<(), String> {
    let target = parse_broker_url(broker_url)?;
    let mut opts = MqttOptions::new(client_id(), target.host.clone(), target.port);
    opts.set_keep_alive(Duration::from_secs(30))
        .set_inflight(messages.len().clamp(20, 50) as u16)
        .set_clean_session(true)
        .set_max_packet_size(MAX_PACKET, MAX_PACKET);
    if let Some(Auth {
        username: Some(u),
        password: Some(p),
    }) = auth
    {
        opts.set_credentials(u, p);
    }
    if target.tls {
        opts.set_transport(Transport::tls_with_config(tls_config()?));
    }
    let qos = qos_from(qos);
    let needs_ack = qos != QoS::AtMostOnce;

    let (client, mut eventloop) = AsyncClient::new(opts, messages.len().clamp(50, 200));
    let pending = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let acked = Arc::new(Notify::new());
    let (connack_tx, connack_rx) = oneshot::channel::<()>();

    let task = {
        let (pending, failed, acked) = (pending.clone(), failed.clone(), acked.clone());
        tokio::spawn(async move {
            let mut connack_tx = Some(connack_tx);
            loop {
                match eventloop.poll().await {
                    Ok(Event::Incoming(Packet::ConnAck(_))) => {
                        if let Some(tx) = connack_tx.take() {
                            let _ = tx.send(());
                        }
                    }
                    Ok(Event::Incoming(Packet::PubAck(_) | Packet::PubComp(_))) => {
                        saturating_dec(&pending);
                        acked.notify_waiters();
                    }
                    Ok(Event::Incoming(Packet::Disconnect)) => break,
                    Ok(Event::Outgoing(rumqttc::Outgoing::Disconnect)) => break,
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("MQTT event loop error: {e}");
                        failed.store(true, Ordering::SeqCst);
                        // Wake any ack waiter so it re-checks the failure flag.
                        acked.notify_waiters();
                        break;
                    }
                }
            }
        })
    };

    let mut errors: Vec<String> = Vec::new();
    match tokio::time::timeout(CONNACK_TIMEOUT, connack_rx).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => errors.push("Connection task finished before ConnAck".into()),
        Err(_) => errors.push("Timed out waiting for ConnAck from broker".into()),
    }

    if errors.is_empty() {
        let delay = Duration::from_millis(match (delay_ms, qos) {
            (Some(d), QoS::AtMostOnce) => d.max(50),
            (Some(d), _) => d,
            (None, _) => 0,
        });
        let count = messages.len();
        for (i, msg) in messages.into_iter().enumerate() {
            if failed.load(Ordering::SeqCst) {
                errors.push("EventLoop failed during publishing".into());
                break;
            }
            if needs_ack {
                pending.fetch_add(1, Ordering::SeqCst);
            }
            if let Err(e) = client.publish(topic, qos, retain, msg.into_bytes()).await {
                if needs_ack {
                    saturating_dec(&pending);
                }
                errors.push(format!("Message {} enqueue failed: {e}", i + 1));
            }
            if i + 1 < count && !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
        }

        if needs_ack && errors.is_empty() {
            let wait = async {
                loop {
                    let notified = acked.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if pending.load(Ordering::SeqCst) == 0 || failed.load(Ordering::SeqCst) {
                        break;
                    }
                    notified.await;
                }
            };
            if tokio::time::timeout(ACK_TIMEOUT, wait).await.is_err() {
                errors.push("Timed out waiting for MQTT acknowledgements".into());
            } else if failed.load(Ordering::SeqCst) && pending.load(Ordering::SeqCst) > 0 {
                errors.push("EventLoop failed during publishing".into());
            }
        }
    }

    let _ = client.disconnect().await;
    if tokio::time::timeout(JOIN_TIMEOUT, task).await.is_err() {
        log::warn!("MQTT event loop did not stop within {JOIN_TIMEOUT:?}");
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Failed to publish {} message(s): {}",
            errors.len(),
            errors.join("; ")
        ))
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_mqtt_messages_batch(
    broker_url: String,
    topic: String,
    messages: Vec<String>,
    qos: u8,
    retain: bool,
    auth: Option<Auth>,
    delay_ms: Option<u64>,
) -> Result<(), String> {
    publish_batch(&broker_url, &topic, messages, qos, retain, auth, delay_ms).await
}

#[tauri::command]
pub async fn send_mqtt_message(
    broker_url: String,
    topic: String,
    message: String,
    qos: u8,
    retain: bool,
    auth: Option<Auth>,
) -> Result<(), String> {
    publish_batch(&broker_url, &topic, vec![message], qos, retain, auth, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_urls() {
        assert_eq!(
            parse_broker_url("mqtt://broker.local").unwrap(),
            BrokerTarget { host: "broker.local".into(), port: 1883, tls: false }
        );
        assert_eq!(
            parse_broker_url("mqtts://b.example:9999").unwrap(),
            BrokerTarget { host: "b.example".into(), port: 9999, tls: true }
        );
        for scheme in ["ssl", "tls"] {
            let t = parse_broker_url(&format!("{scheme}://h")).unwrap();
            assert!(t.tls);
            assert_eq!(t.port, 8883);
        }
        // Websocket schemes are treated as plain TCP.
        assert!(!parse_broker_url("ws://h:8080").unwrap().tls);
        assert_eq!(parse_broker_url("mqtt://[::1]:1884").unwrap().host, "::1");
        assert!(parse_broker_url("not a url").unwrap_err().starts_with("Invalid broker URL"));
        assert_eq!(parse_broker_url("mqtt:///x").unwrap_err(), "Broker URL must include host");
    }

    #[test]
    fn qos_mapping() {
        assert_eq!(qos_from(0), QoS::AtMostOnce);
        assert_eq!(qos_from(1), QoS::AtLeastOnce);
        assert_eq!(qos_from(2), QoS::ExactlyOnce);
        assert_eq!(qos_from(7), QoS::AtLeastOnce);
    }

    #[test]
    fn counter_never_underflows() {
        let c = AtomicUsize::new(0);
        saturating_dec(&c);
        assert_eq!(c.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn auth_deserializes_partially() {
        let a: Auth = serde_json::from_str(r#"{"username":"u"}"#).unwrap();
        assert_eq!(a.username.as_deref(), Some("u"));
        assert!(a.password.is_none());
    }

    #[test]
    fn tls_config_builds_without_panicking() {
        install_crypto_provider();
        // Either a config or a clean error — never a panic.
        let _ = tls_config();
    }

    #[tokio::test]
    async fn unreachable_broker_reports_an_error() {
        install_crypto_provider();
        // Port 9 (discard) on loopback is almost never an MQTT broker.
        let err = publish_batch("mqtt://127.0.0.1:9", "t", vec!["{}".into()], 1, false, None, Some(100))
            .await
            .unwrap_err();
        assert!(err.starts_with("Failed to publish"), "{err}");
    }
}
