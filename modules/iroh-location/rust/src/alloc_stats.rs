//! How much of the native heap is Rust's — a counting wrapper around the system allocator.
//!
//! ## The hole this fills
//! On 2026-10-22/23 a Pixel 10 ran 36 h on the map-leak fix without a low-memory kill, but
//! `memory.native_heap_bytes` still climbed 417 → 645 MB, about 5 MB/h with the app in the
//! background. That number is Bionic's whole malloc heap: Rust (iroh, the docs engine, the OTLP
//! exporter), Hermes, Skia and React Native all allocate from it, and nothing on the span could say
//! whose the growth was. Counting Rust's own allocations splits it in two: if
//! `memory.rust_live_bytes` climbs with the native heap the growth is in this crate's process
//! (follow it with heapprofd), and if it stays flat the growth is everyone else's.
//!
//! Two relaxed atomic adds per allocation. Only compiled with the `otel` feature, so a store build
//! keeps the plain system allocator and [`snapshot`] answers `None`.

#[cfg(feature = "otel")]
mod imp {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

    /// Bytes currently allocated and not yet freed.
    static LIVE: AtomicU64 = AtomicU64::new(0);
    /// Every allocation since the process started, and their bytes. A climbing count with a flat
    /// `LIVE` is churn, not a leak; both climbing is the leak.
    static ALLOCS: AtomicU64 = AtomicU64::new(0);
    static ALLOCATED: AtomicU64 = AtomicU64::new(0);

    struct Counting;

    #[inline]
    fn grew(bytes: usize) {
        LIVE.fetch_add(bytes as u64, Relaxed);
        ALLOCS.fetch_add(1, Relaxed);
        ALLOCATED.fetch_add(bytes as u64, Relaxed);
    }

    // SAFETY: every method forwards to `System` with the caller's arguments unchanged; the
    // counters are side effects that never touch the memory.
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let ptr = unsafe { System.alloc(layout) };
            if !ptr.is_null() {
                grew(layout.size());
            }
            ptr
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let ptr = unsafe { System.alloc_zeroed(layout) };
            if !ptr.is_null() {
                grew(layout.size());
            }
            ptr
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) };
            LIVE.fetch_sub(layout.size() as u64, Relaxed);
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let new = unsafe { System.realloc(ptr, layout, new_size) };
            if !new.is_null() {
                // The old block is gone and the new one is live, whichever way it moved.
                LIVE.fetch_sub(layout.size() as u64, Relaxed);
                grew(new_size);
            }
            new
        }
    }

    #[global_allocator]
    static GLOBAL: Counting = Counting;

    pub(super) fn snapshot() -> Option<super::AllocSnapshot> {
        Some(super::AllocSnapshot {
            live_bytes: LIVE.load(Relaxed),
            allocs_total: ALLOCS.load(Relaxed),
            allocated_total_bytes: ALLOCATED.load(Relaxed),
        })
    }
}

#[cfg(not(feature = "otel"))]
mod imp {
    pub(super) fn snapshot() -> Option<super::AllocSnapshot> {
        None
    }
}

/// Rust's share of the process heap, as of now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AllocSnapshot {
    pub live_bytes: u64,
    pub allocs_total: u64,
    pub allocated_total_bytes: u64,
}

/// `None` when the counting allocator is compiled out.
pub(crate) fn snapshot() -> Option<AllocSnapshot> {
    imp::snapshot()
}

#[cfg(all(test, feature = "otel"))]
mod tests {
    use super::*;

    #[test]
    fn counts_a_live_allocation_and_its_release() {
        let before = snapshot().unwrap();
        let block = vec![0u8; 8 << 20];
        let during = snapshot().unwrap();
        assert!(during.allocs_total > before.allocs_total);
        assert!(during.allocated_total_bytes >= before.allocated_total_bytes + (8 << 20));
        // Other test threads allocate concurrently, so only a lower bound on `live` is exact.
        assert!(during.live_bytes >= 8 << 20);
        drop(block);
    }
}
