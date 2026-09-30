//! The local record of this device's own publishes — what the app's trail and exploration map are
//! drawn from once publishing happens with no JS alive. See `own_log.rs`.

use iroh_location::own_log::{OwnLog, MAX_ITEMS};
use iroh_location::LocationFix;

struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sc-own-log-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fix(ts: u64) -> LocationFix {
    LocationFix {
        lat: 47.6062,
        lon: -122.3321,
        accuracy_m: 12.0,
        heading_deg: 0.0,
        ts,
        state: Some(1),
        published_delta_s: Some(0),
    }
}

#[test]
fn records_survive_a_restart_and_are_taken_once() {
    let dir = Scratch::new("restart");
    {
        let log = OwnLog::open(dir.path()).unwrap();
        log.record(7, &fix(1_000));
        log.record(8, &fix(2_000));
    }
    let log = OwnLog::open(dir.path()).unwrap();
    let taken = log.take().unwrap();
    assert_eq!(
        taken.iter().map(|p| (p.seq, p.fix.ts)).collect::<Vec<_>>(),
        vec![(7, 1_000), (8, 2_000)],
        "oldest first, with the seq that went on the wire"
    );
    assert!(log.take().unwrap().is_empty(), "taken means gone");
    drop(log);
    assert!(
        OwnLog::open(dir.path()).unwrap().take().unwrap().is_empty(),
        "durably gone"
    );
}

#[test]
fn the_bound_drops_the_oldest() {
    let dir = Scratch::new("bound");
    let log = OwnLog::open(dir.path()).unwrap();
    for i in 0..(MAX_ITEMS as u64 + 5) {
        log.record(i, &fix(i));
    }
    let taken = log.take().unwrap();
    assert_eq!(taken.len(), MAX_ITEMS);
    assert_eq!(taken[0].seq, 5);
}

#[test]
fn only_one_writer_per_directory() {
    let dir = Scratch::new("writer");
    let _first = OwnLog::open(dir.path()).unwrap();
    assert!(OwnLog::open(dir.path()).is_err());
}
