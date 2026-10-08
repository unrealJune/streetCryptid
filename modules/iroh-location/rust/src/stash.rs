//! Granting the trail stash replication of our namespaces, from Rust.
//!
//! The stash only reconciles namespaces it has been told about (`POST /v1/namespaces` with a read
//! ticket), and it keeps that list in memory: a stash restart forgets every namespace, and from
//! then on it answers each sync with `NotFound` until someone registers them again. It restarted on
//! 2026-10-03 at 18:39 and on 2026-10-06 at 03:56, and both times the namespaces stayed dark until a
//! phone's JS re-registered them — which `location-sharing.ts` does only on a foreground launch
//! (`syncStashGrants`). A phone driven by the native runtime alone never re-registered at all.
//!
//! This is that grant, owned by the node. It runs:
//!
//! * on every node start — every process, app or background;
//! * when the delivery config changes, since it carries the stash opt-in;
//! * for one ticket, when a friend namespace is imported;
//! * when an upload reports the stash is not tracking our slots — the visible symptom of a stash
//!   that has restarted — floored by [`REGRANT_FLOOR_MS`].
//!
//! It sends exactly what the JS client sends: the read ticket and nothing else. No device push
//! token, deliberately (ARCHITECTURE.md §10). Best-effort throughout: a failed grant degrades
//! offline delivery to peer-only until the next trigger, and must never fail the caller.

use std::time::Duration;

/// How long one registration may take. The grant runs off the caller's path, so this bounds
/// only how long a dead stash can hold a spawned task, not anything a user waits on.
pub const REGISTER_TIMEOUT: Duration = Duration::from_secs(15);

/// The least time between two re-grants triggered by the stash reporting untracked slots. That
/// signal repeats on every upload until the stash catches up, so it needs a floor; a start, a
/// config change or a new friend is a real event and bypasses it.
pub const REGRANT_FLOOR_MS: u64 = 10 * 60 * 1000;

/// The request body. The read ticket is the only field, on purpose: the server still accepts
/// `push_token` / `platform`, and they are never sent (ARCHITECTURE.md §10).
#[derive(serde::Serialize)]
struct Registration<'a> {
    read_ticket: &'a str,
}

/// What one grant achieved.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GrantReport {
    pub registered: u32,
    pub failed: u32,
}

/// Register every ticket with the stash at `base_url`. Never fails as a whole: each ticket is
/// counted as registered or failed, and the caller records the report.
pub async fn register(base_url: &str, psk: Option<&str>, tickets: &[String]) -> GrantReport {
    let client = match reqwest::Client::builder().timeout(REGISTER_TIMEOUT).build() {
        Ok(client) => client,
        Err(err) => {
            tracing::warn!(error = %err, "stash grant: could not build an HTTP client");
            return GrantReport {
                registered: 0,
                failed: tickets.len() as u32,
            };
        }
    };
    let url = format!("{}/v1/namespaces", base_url.trim_end_matches('/'));
    let results = n0_future::join_all(tickets.iter().map(|ticket| {
        let client = &client;
        let url = &url;
        async move {
            let mut request = client.post(url).json(&Registration {
                read_ticket: ticket,
            });
            if let Some(psk) = psk {
                request = request.bearer_auth(psk);
            }
            match request.send().await {
                Ok(response) if response.status() == reqwest::StatusCode::CREATED => true,
                Ok(response) => {
                    tracing::warn!(
                        status = response.status().as_u16(),
                        "stash grant: the stash refused a namespace"
                    );
                    false
                }
                Err(err) => {
                    tracing::warn!(error = %err, "stash grant: request failed");
                    false
                }
            }
        }
    }))
    .await;
    let registered = results.iter().filter(|ok| **ok).count() as u32;
    GrantReport {
        registered,
        failed: results.len() as u32 - registered,
    }
}

/// Whether a floored re-grant may run now, given when the last full grant ran.
pub fn regrant_due(last_ms: u64, now_ms: u64) -> bool {
    last_ms == 0 || now_ms.saturating_sub(last_ms) >= REGRANT_FLOOR_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A stash stand-in: answers every request with `status`, and hands back each request's text.
    async fn fake_stash(status: u16) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16 * 1024];
                    let mut read = 0;
                    // Headers, then as much body as Content-Length says.
                    loop {
                        let n = socket.read(&mut buf[read..]).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        read += n;
                        let text = String::from_utf8_lossy(&buf[..read]).to_string();
                        if let Some(split) = text.find("\r\n\r\n") {
                            let len = text
                                .lines()
                                .find_map(|l| {
                                    l.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                                })
                                .unwrap_or(0);
                            if read >= split + 4 + len {
                                break;
                            }
                        }
                    }
                    let _ = tx.send(String::from_utf8_lossy(&buf[..read]).to_string());
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        (url, rx)
    }

    #[tokio::test]
    async fn registers_each_ticket_with_the_read_ticket_and_the_psk_only() {
        let (url, mut seen) = fake_stash(201).await;
        let tickets = vec!["docaaa".to_string(), "docbbb".to_string()];
        let report = register(&url, Some("sekrit"), &tickets).await;
        assert_eq!(
            report,
            GrantReport {
                registered: 2,
                failed: 0
            }
        );
        let mut bodies = Vec::new();
        for _ in 0..2 {
            let request = seen.recv().await.unwrap();
            assert!(request.starts_with("POST /v1/namespaces "), "{request}");
            assert!(
                request.contains("authorization: Bearer sekrit"),
                "{request}"
            );
            bodies.push(request[request.find("\r\n\r\n").unwrap() + 4..].to_string());
        }
        bodies.sort();
        // The read ticket and NOTHING else — no push token, no platform (ARCHITECTURE.md §10).
        assert_eq!(
            bodies,
            vec![
                r#"{"read_ticket":"docaaa"}"#.to_string(),
                r#"{"read_ticket":"docbbb"}"#.to_string()
            ]
        );
    }

    #[tokio::test]
    async fn a_refusing_or_absent_stash_is_counted_not_raised() {
        let (url, _seen) = fake_stash(401).await;
        let report = register(&url, None, &["docaaa".to_string()]).await;
        assert_eq!(
            report,
            GrantReport {
                registered: 0,
                failed: 1
            }
        );
        // Nothing listening at all.
        let report = register("http://127.0.0.1:9", None, &["docaaa".to_string()]).await;
        assert_eq!(report.failed, 1);
    }

    #[test]
    fn the_untracked_signal_is_floored() {
        assert!(regrant_due(0, 5));
        assert!(!regrant_due(1_000, 1_000 + REGRANT_FLOOR_MS - 1));
        assert!(regrant_due(1_000, 1_000 + REGRANT_FLOOR_MS));
    }
}
