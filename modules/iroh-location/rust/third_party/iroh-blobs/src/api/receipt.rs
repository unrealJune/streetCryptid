//! Optional local observations of completed downloads. No changes to the blob protocol.

use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock, Weak,
    },
};

use iroh::endpoint::Connection;

use super::Store;
use crate::Hash;

/// Observes a request before any of its response can arrive.
pub trait DownloadObserver: std::fmt::Debug + Send + Sync {
    /// Begin observing one request on this connection.
    fn begin(&self, connection: &Connection) -> Box<dyn PendingReceipt>;
}

/// The request's local observation, not retained beyond completion.
pub trait PendingReceipt: Send {
    /// Called only after a successful transfer. `previous_bytes` includes partial downloads
    /// from earlier attempts; their provenance must not be attributed to this supplier.
    fn complete(
        self: Box<Self>,
        store: Store,
        hash: Hash,
        previous_bytes: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

type Observers = HashMap<usize, (u64, Weak<dyn DownloadObserver>)>;

fn observers() -> &'static Mutex<Observers> {
    static OBSERVERS: OnceLock<Mutex<Observers>> = OnceLock::new();
    OBSERVERS.get_or_init(Mutex::default)
}

/// Removes an observer when the registering endpoint releases the connection.
#[derive(Debug)]
pub struct Registration {
    id: usize,
    generation: u64,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut observers = observers().lock().expect("receipt observers poisoned");
        if observers
            .get(&self.id)
            .is_some_and(|(generation, _)| *generation == self.generation)
        {
            observers.remove(&self.id);
        }
    }
}

/// Register from an endpoint's handshake hook. Keep the guard until the connection closes,
/// but retain only a weak connection handle while waiting.
pub fn register(connection: &Connection, observer: Weak<dyn DownloadObserver>) -> Registration {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let registration = Registration {
        id: connection.stable_id(),
        generation: NEXT.fetch_add(1, Ordering::Relaxed),
    };
    observers()
        .lock()
        .expect("receipt observers poisoned")
        .insert(registration.id, (registration.generation, observer));
    registration
}

pub(crate) fn begin(connection: &Connection) -> Option<Box<dyn PendingReceipt>> {
    let observer = observers()
        .lock()
        .expect("receipt observers poisoned")
        .get(&connection.stable_id())
        .and_then(|(_, observer)| observer.upgrade());
    observer.map(|observer| observer.begin(connection))
}
