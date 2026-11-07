//! The namespace book: which namespaces a **persistent** node (a repeater) has been granted, kept on
//! disk so a restart reopens every one of them.
//!
//! The hosted stash keeps its grant list in memory on purpose (nothing user-derived at rest), and
//! paid for it twice: it restarted on 2026-10-03 and 2026-10-06 and answered every sync with
//! `NotFound` until a phone happened to re-register. The phones' own node learned the same lesson
//! in `ns_book.rs`. A repeater is a daemon on a laptop or a Pi — it restarts all the time, and the
//! phones that granted it may not be awake to grant it again — so it records each grant the moment
//! it is accepted, and reopens from the book rather than from whatever the docs store happens to
//! hold.
//!
//! Pure: no iroh, no tokio. The node keys entries by the namespace id (hex) and stores the read
//! ticket it was granted with, because the ticket is what re-importing needs and the id is what
//! makes a second grant of the same namespace (with fresher addresses) a replacement rather than a
//! duplicate.
//!
//! Rules, each with a test:
//! * a missing book is an empty one (first boot);
//! * a book that exists but cannot be read or decoded **fails the load** rather than starting over
//!   — starting over would silently drop every grant, which is the outage this file exists to end;
//! * every change is written atomically (temp file + rename), so a crash mid-write leaves the old
//!   book, never a torn one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The on-disk format version. Bump only with a migration.
const VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum BookError {
    #[error("namespace book io at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("namespace book at {path} is unreadable: {reason}")]
    Corrupt { path: PathBuf, reason: String },
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct OnDisk {
    version: u32,
    /// Namespace id (lowercase hex) → the read ticket it was granted with.
    namespaces: BTreeMap<String, String>,
}

/// The persisted set of granted namespaces.
#[derive(Debug)]
pub struct NamespaceBook {
    path: PathBuf,
    data: OnDisk,
}

impl NamespaceBook {
    /// Load the book at `path`, or start an empty one if there is no file yet.
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, BookError> {
        let path = path.into();
        let data = match std::fs::read(&path) {
            Ok(bytes) => {
                let data: OnDisk =
                    serde_json::from_slice(&bytes).map_err(|e| BookError::Corrupt {
                        path: path.clone(),
                        reason: e.to_string(),
                    })?;
                if data.version != VERSION {
                    return Err(BookError::Corrupt {
                        path,
                        reason: format!("unknown version {}", data.version),
                    });
                }
                data
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => OnDisk {
                version: VERSION,
                namespaces: BTreeMap::new(),
            },
            Err(source) => return Err(BookError::Io { path, source }),
        };
        Ok(Self { path, data })
    }

    /// Record a grant. Returns whether the book changed (a new namespace, or a new ticket for a
    /// known one); an identical re-grant writes nothing.
    pub fn insert(&mut self, namespace_hex: &str, read_ticket: &str) -> Result<bool, BookError> {
        if self.data.namespaces.get(namespace_hex).map(String::as_str) == Some(read_ticket) {
            return Ok(false);
        }
        let mut next = self.data.clone();
        next.namespaces
            .insert(namespace_hex.to_string(), read_ticket.to_string());
        write_atomic(&self.path, &next)?;
        self.data = next;
        Ok(true)
    }

    /// Every granted namespace's read ticket, in a stable order.
    pub fn tickets(&self) -> Vec<String> {
        self.data.namespaces.values().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.data.namespaces.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.namespaces.is_empty()
    }
}

fn write_atomic(path: &Path, data: &OnDisk) -> Result<(), BookError> {
    let io = |source| BookError::Io {
        path: path.to_path_buf(),
        source,
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    let bytes = serde_json::to_vec_pretty(data).expect("the book always serializes");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory per test, without pulling in a tempdir crate for the pure core.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "trail-stash-book-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_book_is_empty() {
        let book = NamespaceBook::load(scratch("missing").join("namespaces.json")).unwrap();
        assert!(book.is_empty());
    }

    #[test]
    fn grants_survive_a_reload() {
        let path = scratch("reload").join("namespaces.json");
        let mut book = NamespaceBook::load(&path).unwrap();
        assert!(book.insert("aa", "docaaa").unwrap());
        assert!(book.insert("bb", "docbbb").unwrap());
        let book = NamespaceBook::load(&path).unwrap();
        assert_eq!(book.tickets(), vec!["docaaa", "docbbb"]);
    }

    #[test]
    fn a_regrant_replaces_and_an_identical_one_writes_nothing() {
        let path = scratch("regrant").join("namespaces.json");
        let mut book = NamespaceBook::load(&path).unwrap();
        assert!(book.insert("aa", "docold").unwrap());
        assert!(!book.insert("aa", "docold").unwrap());
        assert!(book.insert("aa", "docnew").unwrap());
        assert_eq!(book.len(), 1);
        assert_eq!(
            NamespaceBook::load(&path).unwrap().tickets(),
            vec!["docnew"]
        );
    }

    #[test]
    fn a_corrupt_book_fails_the_load_instead_of_starting_over() {
        let path = scratch("corrupt").join("namespaces.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(matches!(
            NamespaceBook::load(&path),
            Err(BookError::Corrupt { .. })
        ));
    }

    #[test]
    fn an_unknown_version_fails_the_load() {
        let path = scratch("version").join("namespaces.json");
        std::fs::write(&path, br#"{"version":99,"namespaces":{}}"#).unwrap();
        assert!(matches!(
            NamespaceBook::load(&path),
            Err(BookError::Corrupt { .. })
        ));
    }
}
