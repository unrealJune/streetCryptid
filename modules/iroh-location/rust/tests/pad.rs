//! Tests for constant-length payload padding (`src/pad.rs`).
//!
//! The headline property is the one FORWARD-SECRECY.md §4.1 needs: **a null fix and a real fix
//! must be indistinguishable by ciphertext length**, or symmetric lanes announce which edges are
//! watchers and which are sharers to anyone counting bytes — the stash included.
//!
//! These also discharge the §4.7 **[MUST VERIFY]** on the size class by measuring the real
//! payload distribution rather than assuming it.

use iroh_location::pad::{self, PadError, MAX_PAYLOAD, PADDED_LEN};
use iroh_location::{LocationFix, MotionState};

fn encoded(ts: u64) -> Vec<u8> {
    encoded_with(ts, Some(MotionState::Parked))
}

fn encoded_with(ts: u64, motion: Option<MotionState>) -> Vec<u8> {
    let fix = LocationFix {
        lat: -122.419416,
        lon: 37.774929,
        accuracy_m: 65.5,
        heading_deg: 359.9,
        ts,
        motion,
    };
    postcard::to_allocvec(&fix).unwrap()
}

#[test]
fn the_size_class_actually_fits_a_real_fix() {
    // §4.7 [MUST VERIFY]: "the real fix payload distribution fits one bucket". Measured, not
    // assumed — and asserted here so the class cannot silently become too small if a field is
    // added to LocationFix.
    let now = encoded(1_786_000_000_000);
    assert_eq!(now.len(), 40, "a present-day fix");
    assert_eq!(
        encoded(4_102_444_800_000).len(),
        40,
        "still 40 in the year 2100"
    );

    // `motion` is the first optional field on the wire, and `None` is a real value an Android
    // author publishes for the life of the install — so the cheap case is measured too. It must
    // not be mistaken for the size class shrinking back: padding hides the difference, and this
    // asserts the pair rather than either alone.
    assert_eq!(
        encoded_with(1_786_000_000_000, None).len(),
        39,
        "an author with no motion state machine"
    );

    // The absolute bound: a varint ts cannot exceed this however far the clock runs.
    let worst = encoded(u64::MAX);
    assert_eq!(worst.len(), 44);
    assert!(
        worst.len() <= MAX_PAYLOAD,
        "the worst-case fix ({}) must fit the class ({MAX_PAYLOAD})",
        worst.len()
    );
    // Headroom is deliberate: changing the class is a wire break.
    assert!(
        MAX_PAYLOAD - worst.len() >= 16,
        "too little headroom for future fields"
    );
}

#[test]
fn a_null_fix_and_a_real_fix_are_the_same_length() {
    // The property symmetric lanes depend on.
    let null = pad::pad(&[]).unwrap();
    let real = pad::pad(&encoded(1_786_000_000_000)).unwrap();
    assert_eq!(null.len(), real.len());
    assert_eq!(null.len(), PADDED_LEN);
}

#[test]
fn every_payload_size_pads_to_the_same_length() {
    for len in 0..=MAX_PAYLOAD {
        let frame = pad::pad(&vec![0xab; len]).unwrap();
        assert_eq!(frame.len(), PADDED_LEN, "payload of {len} bytes");
    }
}

#[test]
fn padding_round_trips() {
    for len in [0usize, 1, 39, 40, 44, MAX_PAYLOAD] {
        let payload = vec![0x5a; len];
        let frame = pad::pad(&payload).unwrap();
        assert_eq!(pad::unpad(&frame).unwrap(), &payload[..], "len {len}");
    }
}

#[test]
fn a_real_fix_survives_the_round_trip() {
    let payload = encoded(1_786_000_000_000);
    let frame = pad::pad(&payload).unwrap();
    let back: LocationFix = postcard::from_bytes(pad::unpad(&frame).unwrap()).unwrap();
    assert_eq!(back.ts, 1_786_000_000_000);
    assert_eq!(back.accuracy_m, 65.5);
}

#[test]
fn a_null_fix_is_recognisable_as_one() {
    let null = pad::pad(&[]).unwrap();
    let real = pad::pad(&encoded(1)).unwrap();
    assert!(pad::is_null(&null).unwrap());
    assert!(!pad::is_null(&real).unwrap());
    assert!(pad::unpad(&null).unwrap().is_empty());
}

#[test]
fn an_oversized_payload_is_refused_not_silently_grown() {
    // Growing the frame would leak the payload size after all, which is the thing being hidden.
    let err = pad::pad(&vec![0u8; MAX_PAYLOAD + 1]).unwrap_err();
    assert_eq!(err, PadError::TooLong(MAX_PAYLOAD + 1));
}

#[test]
fn non_zero_padding_is_rejected() {
    // Padding that may carry arbitrary bytes is a covert channel out of the device. One
    // comparison closes it, so it is checked rather than ignored.
    let mut frame = pad::pad(b"hello").unwrap();
    let last = frame.len() - 1;
    frame[last] = 0x01;
    assert_eq!(pad::unpad(&frame).unwrap_err(), PadError::DirtyPadding);
}

#[test]
fn a_malformed_frame_is_rejected() {
    let frame = pad::pad(b"hello").unwrap();

    assert_eq!(
        pad::unpad(&frame[..PADDED_LEN - 1]).unwrap_err(),
        PadError::BadLength
    );
    assert_eq!(pad::unpad(&[]).unwrap_err(), PadError::BadLength);

    let mut lying = frame.clone();
    lying[..2].copy_from_slice(&(MAX_PAYLOAD as u16 + 1).to_le_bytes());
    assert_eq!(pad::unpad(&lying).unwrap_err(), PadError::BadPrefix);
}

#[test]
fn the_frame_does_not_leak_the_payload_length_in_its_shape() {
    // Beyond equal length: two different payloads must not differ anywhere except where their
    // own bytes differ — i.e. the fill is identical, so a diff cannot reveal a boundary.
    let a = pad::pad(&[]).unwrap();
    let b = pad::pad(&encoded(1_786_000_000_000)).unwrap();
    // Both are zero from (2 + their own length) onward; the tail they share is all zero.
    let tail = 2 + 44;
    assert!(a[tail..].iter().all(|&x| x == 0));
    assert!(b[tail..].iter().all(|&x| x == 0));
    assert_eq!(a[tail..], b[tail..]);
}
