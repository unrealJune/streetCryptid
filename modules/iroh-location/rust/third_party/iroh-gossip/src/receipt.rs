//! Optional local receive observations; not part of the gossip wire or RPC API.

use iroh::endpoint::Connection;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock, Weak,
    },
};

/// Observes decoded payloads before protocol acceptance. The application must still validate them.
pub trait ReceiveObserver: std::fmt::Debug + Send + Sync {
    /// The actual receiving connection, not another connection to the same peer.
    fn received(&self, connection: &Connection, content: &[u8]);
}

type Observers = HashMap<usize, (u64, Weak<dyn ReceiveObserver>)>;

fn observers() -> &'static Mutex<Observers> {
    static OBSERVERS: OnceLock<Mutex<Observers>> = OnceLock::new();
    OBSERVERS.get_or_init(Mutex::default)
}

/// Drop when the weak connection's close notification resolves.
#[derive(Debug)]
pub struct Registration {
    id: usize,
    generation: u64,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut observers = observers().lock().expect("gossip observers poisoned");
        if observers
            .get(&self.id)
            .is_some_and(|(generation, _)| *generation == self.generation)
        {
            observers.remove(&self.id);
        }
    }
}

/// Register from an endpoint handshake hook. Neither the observer nor the connection is retained.
pub fn register(connection: &Connection, observer: Weak<dyn ReceiveObserver>) -> Registration {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let registration = Registration {
        id: connection.stable_id(),
        generation: NEXT.fetch_add(1, Ordering::Relaxed),
    };
    observers()
        .lock()
        .expect("gossip observers poisoned")
        .insert(registration.id, (registration.generation, observer));
    registration
}

pub(crate) fn received(connection: &Connection, content: &[u8]) {
    let observer = observers()
        .lock()
        .expect("gossip observers poisoned")
        .get(&connection.stable_id())
        .and_then(|(_, observer)| observer.upgrade());
    if let Some(observer) = observer {
        observer.received(connection, content);
    }
}
