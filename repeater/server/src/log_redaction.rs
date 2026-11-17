//! Last-line protection against network addresses and stable identifiers reaching logs.

use std::net::{IpAddr, SocketAddr};

const REDACTED: &str = "[REDACTED]";

/// Redact IP addresses and long identity-like tokens from a fully formatted log event.
pub fn redact_log_line(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        if is_network_char(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_network_char(bytes[i]) {
                i += 1;
            }
            let candidate = &input[start..i];
            if candidate.parse::<IpAddr>().is_ok() || candidate.parse::<SocketAddr>().is_ok() {
                ranges.push((start, i));
            }
        } else {
            i += 1;
        }
    }

    i = 0;
    while i < bytes.len() {
        if is_opaque_char(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_opaque_char(bytes[i]) {
                i += 1;
            }
            let candidate = &input[start..i];
            if candidate.len() >= 32
                && (candidate.bytes().any(|b| b.is_ascii_digit())
                    || candidate.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                ranges.push((start, i));
            }
        } else {
            i += 1;
        }
    }

    if ranges.is_empty() {
        return input.to_owned();
    }

    ranges.sort_unstable();
    let mut output = String::with_capacity(input.len());
    let mut copied = 0;
    for (start, end) in ranges {
        if end <= copied {
            continue;
        }
        let start = start.max(copied);
        output.push_str(&input[copied..start]);
        output.push_str(REDACTED);
        copied = end;
    }
    output.push_str(&input[copied..]);
    output
}

fn is_network_char(byte: u8) -> bool {
    byte.is_ascii_hexdigit() || matches!(byte, b'.' | b':')
}

fn is_opaque_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'+' | b'/' | b'=')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_ipv4_and_ports() {
        let line = "peer=192.0.2.44 remote=198.51.100.8:443";
        let redacted = redact_log_line(line);
        assert_eq!(redacted, "peer=[REDACTED] remote=[REDACTED]");
    }

    #[test]
    fn redacts_ipv6_addresses() {
        let line = "direct=2001:db8::8 relay=[2001:db8::9]:443";
        let redacted = redact_log_line(line);
        assert!(!redacted.contains("2001:db8"));
    }

    #[test]
    fn redacts_identity_like_values() {
        let line = "node=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef token=AbCdEfGhIjKlMnOpQrStUvWxYz012345";
        let redacted = redact_log_line(line);
        assert_eq!(redacted.matches(REDACTED).count(), 2);
        assert!(!redacted.contains("0123456789abcdef"));
        assert!(!redacted.contains("AbCdEfGh"));
    }

    #[test]
    fn preserves_normal_diagnostics() {
        let line = "2026-07-12T19:07:49Z stash: pruned 12 expired entries";
        assert_eq!(redact_log_line(line), line);
    }
}
