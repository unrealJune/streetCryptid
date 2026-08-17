//! Constant-length payload padding, so ciphertext length leaks nothing.
//!
//! See `docs/social/FORWARD-SECRECY.md` §4.1 and §4.7. Under symmetric lanes every edge publishes
//! on cadence, including a watcher who has nothing to say — those are **null fixes**, ordinary
//! signed envelopes whose plaintext is empty. That only buys traffic-shape privacy if the stash
//! cannot tell a null fix from a real one by looking at the ciphertext, and ChaCha20-Poly1305 is
//! length-preserving, so the plaintext has to be padded to a fixed size before it is sealed.
//!
//! ```text
//! padded = len: u16 LE || payload || zero fill        (always PADDED_LEN bytes)
//! len == 0  ⇒  a null fix
//! ```
//!
//! The size class is measured, not guessed — §4.7 marks it **[MUST VERIFY]**. A postcard-encoded
//! `LocationFix` is 38 bytes at present-day timestamps and 42 at the `u64::MAX` bound (see
//! `tests/pad.rs`, which asserts both so the class cannot silently become too small). With the
//! 2-byte length prefix that is 44 of [`PADDED_LEN`], leaving room for a couple of future fields
//! before the class has to change — and changing it is a wire break, so the headroom is the point.
//!
//! The fill must be **zero**. It is checked on unpad rather than ignored: padding that is allowed
//! to carry arbitrary bytes is a covert channel out of a device, and it costs one comparison to
//! close it.
//!
//! Deliberately payload-agnostic — it pads bytes, not fixes — so the mobile crate and the wasm
//! crate can share it (`#[path]`, like `crypto.rs`) despite having different fix types.

/// Every sealed fix payload is exactly this long, before encryption.
pub const PADDED_LEN: usize = 64;

/// The largest payload that fits a padded frame.
pub const MAX_PAYLOAD: usize = PADDED_LEN - 2;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PadError {
    /// The payload does not fit the size class. Changing the class is a wire break, so this is a
    /// hard error rather than a silent upgrade to a larger frame.
    #[error("payload is {0} bytes, over the {MAX_PAYLOAD}-byte class")]
    TooLong(usize),
    /// Not a padded frame: wrong length.
    #[error("padded frame must be exactly {PADDED_LEN} bytes")]
    BadLength,
    /// The length prefix points past the end of the frame.
    #[error("padded frame declares a length it does not contain")]
    BadPrefix,
    /// The fill was not zero — a covert channel, or a corrupt frame.
    #[error("padding is not zero-filled")]
    DirtyPadding,
}

/// Wrap `payload` in a constant-length frame. An empty payload is the null fix.
pub fn pad(payload: &[u8]) -> Result<Vec<u8>, PadError> {
    if payload.len() > MAX_PAYLOAD {
        return Err(PadError::TooLong(payload.len()));
    }
    let mut out = vec![0u8; PADDED_LEN];
    out[..2].copy_from_slice(&(payload.len() as u16).to_le_bytes());
    out[2..2 + payload.len()].copy_from_slice(payload);
    Ok(out)
}

/// Unwrap a frame produced by [`pad`]. Returns an empty slice for a null fix.
pub fn unpad(frame: &[u8]) -> Result<&[u8], PadError> {
    if frame.len() != PADDED_LEN {
        return Err(PadError::BadLength);
    }
    let len = u16::from_le_bytes([frame[0], frame[1]]) as usize;
    if len > MAX_PAYLOAD {
        return Err(PadError::BadPrefix);
    }
    let (payload, fill) = frame[2..].split_at(len);
    if fill.iter().any(|&b| b != 0) {
        return Err(PadError::DirtyPadding);
    }
    Ok(payload)
}

/// Whether a frame carries a null fix — a watcher's keep-alive rather than a position.
pub fn is_null(frame: &[u8]) -> Result<bool, PadError> {
    Ok(unpad(frame)?.is_empty())
}
