//! Real iroh endpoints talking over nothing but the BLE transport, on a simulated radio.
//!
//! Added by the streetCryptid project (2026-10). The traffic is shaped like streetCryptid's
//! pairing handshake, because that is the traffic that broke: every message is its own short QUIC
//! connection (dial, one request, one reply, close), the next one follows within milliseconds,
//! and the last one follows after the humans have compared figures. On 2026-10-29 a Pixel 10 and
//! an iPhone 14 failed seven nearby pairings in a row because each message's close tore down the
//! BLE pipe the next message was being dialled over. See `PIPE_IDLE_LINGER` in `hook.rs`.

#![cfg(feature = "testing")]
#![allow(clippy::unwrap_used)]

use std::time::{Duration, Instant};

use iroh::endpoint::{Connection, presets};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, SecretKey};
use iroh_ble_transport::transport::sim::{SimNodeConfig, SimRadio};

const ALPN: &[u8] = b"streetcryptid/sim-pair/0";

/// What one message may take end to end. Generous for a simulated radio; a pipe torn down under
/// a dial blows straight through it (the app's own budget is 15 s to connect, 25 s to answer).
const MESSAGE_BUDGET: Duration = Duration::from_secs(10);

/// Answers one request per connection, the way `PairProtocol` does: read it, reply, and linger
/// briefly for the dialler to close.
#[derive(Debug, Clone)]
struct Echo;

impl ProtocolHandler for Echo {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let (mut send, mut recv) = conn.accept_bi().await.map_err(AcceptError::from_err)?;
        let request = recv
            .read_to_end(64 * 1024)
            .await
            .map_err(AcceptError::from_err)?;
        let mut reply = b"re:".to_vec();
        reply.extend_from_slice(&request);
        send.write_all(&reply)
            .await
            .map_err(AcceptError::from_err)?;
        send.finish()?;
        let _ = tokio::time::timeout(Duration::from_secs(5), conn.closed()).await;
        Ok(())
    }
}

/// A phone: an endpoint whose ONLY transport is BLE, answering pairing-shaped requests.
struct Phone {
    router: Router,
}

impl Phone {
    fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    fn id(&self) -> iroh::EndpointId {
        self.endpoint().id()
    }
}

async fn phone(radio: &SimRadio, device: &str, config: SimNodeConfig) -> Phone {
    let secret_key = SecretKey::generate();
    let ble = radio.transport(device, secret_key.public(), config);
    let endpoint = Endpoint::builder(presets::Minimal)
        .clear_ip_transports()
        .secret_key(secret_key)
        .hooks(ble.dedup_hook())
        .add_custom_transport(ble.as_custom_transport())
        .address_lookup(ble.address_lookup())
        .bind()
        .await
        .expect("bind a BLE-only endpoint");
    let router = Router::builder(endpoint).accept(ALPN, Echo).spawn();
    Phone { router }
}

/// One pairing-shaped message: its own connection, one request, one reply, closed at once.
async fn message(from: &Phone, to: &Phone, body: &[u8]) -> Duration {
    let started = Instant::now();
    let reply = tokio::time::timeout(MESSAGE_BUDGET, async {
        let conn = from.endpoint().connect(to.id(), ALPN).await?;
        let (mut send, mut recv) = conn.open_bi().await?;
        send.write_all(body).await?;
        send.finish()?;
        let reply = recv.read_to_end(64 * 1024).await?;
        conn.close(0u32.into(), b"pair-done");
        anyhow::Ok(reply)
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "{} did not get through in {MESSAGE_BUDGET:?}",
            String::from_utf8_lossy(body)
        )
    })
    .unwrap_or_else(|e| panic!("{} failed: {e:#}", String::from_utf8_lossy(body)));
    let mut expected = b"re:".to_vec();
    expected.extend_from_slice(body);
    assert_eq!(reply, expected);
    started.elapsed()
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "iroh_ble_transport=info".into()),
        )
        .with_test_writer()
        .try_init();
}

/// The 2026-10-29 sequence, on one pipe: Hello and Reveal back to back, then Accept from both
/// sides once the figures have been compared. Before the linger, Reveal was dialled over a pipe
/// already being torn down; now every message rides the link Hello opened.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pairing_handshake_rides_one_pipe() {
    init_tracing();
    let radio = SimRadio::new();
    radio.set_latency(Duration::from_millis(15));
    radio.set_connect_delay(Duration::from_millis(300));
    let pixel = phone(&radio, "pixel", SimNodeConfig::default()).await;
    let iphone = phone(&radio, "iphone", SimNodeConfig::default()).await;
    radio.discover_both("pixel", "iphone").await;

    message(&pixel, &iphone, b"hello").await;
    message(&pixel, &iphone, b"reveal").await;
    // The humans compare figures.
    tokio::time::sleep(Duration::from_secs(3)).await;
    message(&iphone, &pixel, b"accept from iphone").await;
    message(&pixel, &iphone, b"accept from pixel").await;

    assert_eq!(
        radio.connects_between("pixel", "iphone"),
        1,
        "every message should ride the first pipe; link log: {:?}",
        radio.log()
    );
    assert!(radio.linked("pixel", "iphone"));
}

/// Messages fired with no gap at all — the tightest form of the race.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn back_to_back_messages_all_get_through() {
    init_tracing();
    let radio = SimRadio::new();
    radio.set_latency(Duration::from_millis(5));
    let a = phone(&radio, "a", SimNodeConfig::default()).await;
    let b = phone(&radio, "b", SimNodeConfig::default()).await;
    radio.discover_both("a", "b").await;

    for i in 0..8 {
        message(&a, &b, format!("message {i}").as_bytes()).await;
    }
    assert_eq!(radio.connects_between("a", "b"), 1, "{:?}", radio.log());
}

/// The linger is a delay, not a leak: a pipe nobody uses is still released.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unused_pipe_is_released_after_the_linger() {
    init_tracing();
    let radio = SimRadio::new();
    let config = SimNodeConfig {
        idle_linger: Duration::from_millis(500),
    };
    let a = phone(&radio, "a", config.clone()).await;
    let b = phone(&radio, "b", config).await;
    radio.discover_both("a", "b").await;

    message(&a, &b, b"only message").await;
    assert!(
        radio.linked("a", "b"),
        "the pipe should outlive the message"
    );

    let deadline = Instant::now() + Duration::from_secs(10);
    while radio.linked("a", "b") {
        assert!(
            Instant::now() < deadline,
            "an idle pipe was never released; link log: {:?}",
            radio.log()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // And the next pairing simply opens a new one.
    message(&a, &b, b"after release").await;
    assert_eq!(radio.connects_between("a", "b"), 2, "{:?}", radio.log());
}

/// A phone that walks out of range mid-session, and back: the next message must find a new pipe
/// rather than wait on the dead one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lost_link_is_replaced_by_the_next_message() {
    init_tracing();
    let radio = SimRadio::new();
    let a = phone(&radio, "a", SimNodeConfig::default()).await;
    let b = phone(&radio, "b", SimNodeConfig::default()).await;
    radio.discover_both("a", "b").await;

    message(&a, &b, b"before").await;
    radio.take_out_of_range("a", "b");
    tokio::time::sleep(Duration::from_millis(200)).await;
    radio.bring_in_range("a", "b");
    radio.discover_both("a", "b").await;

    message(&a, &b, b"after").await;
    assert!(radio.connects_between("a", "b") >= 2, "{:?}", radio.log());
}
