//! `process.memory` — where a phone's memory is going, sampled by the native runtime.
//!
//! ## The hole this fills
//! On 2026-10-21 a Pixel 10's process was killed by the low-memory killer at 3.5 GB RSS, and the
//! next one reached 3.0 GB within 5.5 hours — from ~350 MB with the app loaded. Nothing in the
//! telemetry said so: the only record was Android's `exit-info`, which gives one number at death
//! and nothing about which allocator grew or when. A release build can't be heap-dumped either.
//!
//! So the platform runtimes sample their own process on the location-runtime pulse and hand the
//! numbers here, which stamps them on a span next to everything else that phone reported. Plot
//! `memory.native_heap_bytes` against `memory.rss_anon_bytes` and `memory.rss_file_bytes` over a
//! day and the growing one names the culprit: the native heap is Rust (and Hermes' malloc), the
//! Java heap is Kotlin/React Native, a growing file RSS is mapped files (tiles, databases), and
//! climbing `threads` / `fds` / `maps` is a handle leak rather than a heap one.
//!
//! ## Splitting the native heap
//! The first Pixel run on the map-leak fix (2026-10-22/23, 36 h, no kill) still grew
//! `memory.native_heap_bytes` ~5 MB/h in the background, and that number is everyone's malloc.
//! So the span also carries what this side can measure about whose it is:
//! - `memory.rust_live_bytes` (and the cumulative `rust_allocs_total` / `rust_allocated_total_bytes`)
//!   from the counting allocator in `alloc_stats` — Rust's exact share. Growing with the native
//!   heap: it is ours. Flat: it is Hermes, Skia or React Native.
//! - `memory.open_spans` / `memory.open_span_events` / `memory.heaviest_open_span` from the
//!   telemetry ledger — events buffered on spans that never end, a growth that is no leak at all
//!   (see `telemetry::ledger`).
//! - `memory.native_heap_size_bytes` / `_free_bytes` from the platform: a heap whose free share
//!   climbs is fragmenting, not leaking.
//! - The `Debug.MemoryInfo` summary on Android (`graphics`, `code`, `stack`, `private_other`,
//!   `system`, and `pss_bytes`), sampled at a slower cadence because it walks every mapping.
//!
//! Strippable the same way as the rest of the telemetry: with no endpoint configured the span goes
//! nowhere, and with the `otel` feature off there is no exporter at all. Nothing here carries user
//! content — byte counts and handle counts only.

/// One sample. Every field is optional because each platform can read a different subset.
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct ProcessMemorySample {
    /// What took the sample (`pulse`, `started`, ...).
    pub trigger: String,
    /// `/proc/self/status` (Linux/Android).
    pub rss_bytes: Option<u64>,
    pub rss_anon_bytes: Option<u64>,
    pub rss_file_bytes: Option<u64>,
    pub swap_bytes: Option<u64>,
    /// The platform's malloc heap, allocated (Android: `Debug.getNativeHeapAllocatedSize`).
    pub native_heap_bytes: Option<u64>,
    /// The managed heap in use (Android: `Runtime.totalMemory - freeMemory`).
    pub java_heap_bytes: Option<u64>,
    /// Proportional set size, when the platform can afford to compute it.
    pub pss_bytes: Option<u64>,
    pub threads: Option<u32>,
    /// Open file descriptors (sockets included).
    pub fds: Option<u32>,
    /// Memory mappings (`/proc/self/maps` lines).
    pub maps: Option<u32>,
    /// Since the process started.
    pub uptime_ms: Option<u64>,
    /// Whether an app UI is mounted in this process right now.
    pub app_wired: Option<bool>,
    /// The malloc heap's mapped size and its free part (Android: `Debug.getNativeHeapSize` /
    /// `getNativeHeapFreeSize`). Free climbing with size is fragmentation, not a leak.
    #[uniffi(default = None)]
    pub native_heap_size_bytes: Option<u64>,
    #[uniffi(default = None)]
    pub native_heap_free_bytes: Option<u64>,
    /// `Debug.MemoryInfo` summary stats (PSS), sampled less often than the rest. `graphics` is GPU
    /// and gralloc memory — where Skia's textures land.
    #[uniffi(default = None)]
    pub graphics_bytes: Option<u64>,
    #[uniffi(default = None)]
    pub code_bytes: Option<u64>,
    #[uniffi(default = None)]
    pub stack_bytes: Option<u64>,
    #[uniffi(default = None)]
    pub private_other_bytes: Option<u64>,
    #[uniffi(default = None)]
    pub system_bytes: Option<u64>,
}

/// Record one sample as a `process.memory` span. Cheap and synchronous, like `location.runtime`.
#[uniffi::export]
pub fn record_process_memory(sample: ProcessMemorySample) {
    let span = tracing::info_span!(
        "process.memory",
        memory.trigger = sample.trigger.as_str(),
        memory.rss_bytes = tracing::field::Empty,
        memory.rss_anon_bytes = tracing::field::Empty,
        memory.rss_file_bytes = tracing::field::Empty,
        memory.swap_bytes = tracing::field::Empty,
        memory.native_heap_bytes = tracing::field::Empty,
        memory.java_heap_bytes = tracing::field::Empty,
        memory.pss_bytes = tracing::field::Empty,
        memory.threads = tracing::field::Empty,
        memory.fds = tracing::field::Empty,
        memory.maps = tracing::field::Empty,
        memory.uptime_ms = tracing::field::Empty,
        memory.app_wired = tracing::field::Empty,
        memory.native_heap_size_bytes = tracing::field::Empty,
        memory.native_heap_free_bytes = tracing::field::Empty,
        memory.graphics_bytes = tracing::field::Empty,
        memory.code_bytes = tracing::field::Empty,
        memory.stack_bytes = tracing::field::Empty,
        memory.private_other_bytes = tracing::field::Empty,
        memory.system_bytes = tracing::field::Empty,
        memory.rust_live_bytes = tracing::field::Empty,
        memory.rust_allocs_total = tracing::field::Empty,
        memory.rust_allocated_total_bytes = tracing::field::Empty,
        memory.open_spans = tracing::field::Empty,
        memory.open_span_events = tracing::field::Empty,
        memory.heaviest_open_span = tracing::field::Empty,
        telemetry.backlog_batches = tracing::field::Empty,
        telemetry.backlog_bytes = tracing::field::Empty,
        telemetry.spooled_total = tracing::field::Empty,
        telemetry.replayed_total = tracing::field::Empty,
        telemetry.dropped_total = tracing::field::Empty,
    );
    let rust = crate::alloc_stats::snapshot();
    let ledger = crate::telemetry::ledger::snapshot();
    // The core's own export backlog (`telemetry_spool`). A batch replayed late keeps its original
    // timestamps, so a backlog that drains is invisible in the spans themselves; this is where it
    // shows.
    let spool = crate::telemetry_spool::snapshot();
    let u64s = [
        ("memory.rss_bytes", sample.rss_bytes),
        ("memory.rss_anon_bytes", sample.rss_anon_bytes),
        ("memory.rss_file_bytes", sample.rss_file_bytes),
        ("memory.swap_bytes", sample.swap_bytes),
        ("memory.native_heap_bytes", sample.native_heap_bytes),
        ("memory.java_heap_bytes", sample.java_heap_bytes),
        ("memory.pss_bytes", sample.pss_bytes),
        ("memory.uptime_ms", sample.uptime_ms),
        (
            "memory.native_heap_size_bytes",
            sample.native_heap_size_bytes,
        ),
        (
            "memory.native_heap_free_bytes",
            sample.native_heap_free_bytes,
        ),
        ("memory.graphics_bytes", sample.graphics_bytes),
        ("memory.code_bytes", sample.code_bytes),
        ("memory.stack_bytes", sample.stack_bytes),
        ("memory.private_other_bytes", sample.private_other_bytes),
        ("memory.system_bytes", sample.system_bytes),
        ("memory.rust_live_bytes", rust.map(|r| r.live_bytes)),
        ("memory.rust_allocs_total", rust.map(|r| r.allocs_total)),
        (
            "memory.rust_allocated_total_bytes",
            rust.map(|r| r.allocated_total_bytes),
        ),
        ("memory.open_spans", Some(ledger.open_spans)),
        ("memory.open_span_events", Some(ledger.open_span_events)),
        ("telemetry.backlog_batches", Some(spool.backlog_batches)),
        ("telemetry.backlog_bytes", Some(spool.backlog_bytes)),
        ("telemetry.spooled_total", Some(spool.spooled_total)),
        ("telemetry.replayed_total", Some(spool.replayed_total)),
        ("telemetry.dropped_total", Some(spool.dropped_total)),
    ];
    for (field, value) in u64s {
        if let Some(value) = value {
            span.record(field, value);
        }
    }
    let u32s = [
        ("memory.threads", sample.threads),
        ("memory.fds", sample.fds),
        ("memory.maps", sample.maps),
    ];
    for (field, value) in u32s {
        if let Some(value) = value {
            span.record(field, value);
        }
    }
    if let Some(wired) = sample.app_wired {
        span.record("memory.app_wired", wired);
    }
    if let Some(heaviest) = &ledger.heaviest {
        span.record("memory.heaviest_open_span", heaviest.as_str());
    }
    drop(span.entered());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_a_partial_sample_without_panicking() {
        record_process_memory(ProcessMemorySample {
            trigger: "pulse".into(),
            rss_bytes: Some(3_500_000_000),
            threads: Some(77),
            app_wired: Some(false),
            ..Default::default()
        });
    }
}
