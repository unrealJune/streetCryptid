//! Moving a repeater's identity between a person's own state directory and the system service's —
//! the Windows `StateMigration`, step for step, because the guarantees are the same ones:
//!
//! - the move copies into a staging directory beside the destination, swaps it into place with the
//!   key last, and only then deletes the source, the key last again; so a directory is never left
//!   with a roster and no key, and a staging directory with a key in it is always complete;
//! - an interrupted move is finished by running it again;
//! - two different identities are never merged or overwritten: the move stops and says so.
//!
//! The caller marks the source (`moved-to-service`) so a per-user daemon there refuses to mint a
//! second identity for a machine whose owner already claimed the first.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use streetcryptid_repeater_host::SERVICE_MARKER;

pub const IDENTITY_FILE: &str = "secret.key";

/// The daemon's own transient files, which belong to whichever directory they are in.
const NOT_NODE_STATE: &[&str] = &["host.lock", SERVICE_MARKER, crate::paths::SOCKET_NAME];

pub fn is_node_state(name: &str) -> bool {
    !NOT_NODE_STATE.contains(&name) && !name.ends_with(".tmp")
}

pub fn has_identity(dir: &Path) -> bool {
    dir.join(IDENTITY_FILE).is_file()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Moved {
    /// The source held no identity: nothing to do.
    Nothing,
    /// The identity is now in the destination and gone from the source.
    Moved,
}

fn staging_for(destination: &Path) -> PathBuf {
    let mut name = destination
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".incoming");
    destination.with_file_name(name)
}

/// Move node state from `source` into `destination`.
pub fn move_state(source: &Path, destination: &Path) -> Result<Moved> {
    create_private_dir(destination)?;
    let staging = staging_for(destination);
    let conflict = || {
        anyhow::anyhow!(
            "{} and {} hold different repeater identities; neither was changed. \
             Keep the one the owner claimed and move the other aside by hand.",
            source.display(),
            destination.display()
        )
    };
    // A staging directory holding a key is a complete copy whose swap was interrupted.
    if staging.is_dir() && has_identity(&staging) {
        if has_identity(source) && !same_identity(source, &staging)? {
            return Err(conflict());
        }
        if has_identity(destination) {
            return Err(conflict());
        }
        swap(&staging, destination)?;
        if has_identity(source) {
            delete_node_state(source)?;
        }
        return Ok(Moved::Moved);
    }
    if !has_identity(source) {
        return Ok(Moved::Nothing);
    }
    if has_identity(destination) {
        // A finished move whose source was not yet deleted: same identity, finish it.
        if !same_identity(source, destination)? {
            return Err(conflict());
        }
        delete_node_state(source)?;
        return Ok(Moved::Moved);
    }
    for entry in std::fs::read_dir(destination)? {
        if is_node_state(&entry?.file_name().to_string_lossy()) {
            bail!(
                "{} already holds repeater state without an identity; it was not changed",
                destination.display()
            );
        }
    }
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    create_private_dir(&staging)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !is_node_state(&name_str) || name_str == IDENTITY_FILE {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &staging.join(&name))?;
        } else if kind.is_file() {
            copy_file(&entry.path(), &staging.join(&name))?;
        }
    }
    // The key last, so a staging directory with a key in it is always complete.
    copy_file(&source.join(IDENTITY_FILE), &staging.join(IDENTITY_FILE))?;
    swap(&staging, destination)?;
    delete_node_state(source)?;
    Ok(Moved::Moved)
}

fn same_identity(a: &Path, b: &Path) -> Result<bool> {
    Ok(std::fs::read(a.join(IDENTITY_FILE))? == std::fs::read(b.join(IDENTITY_FILE))?)
}

/// Move a complete staging copy into place, the key last, then drop the staging directory.
fn swap(staging: &Path, destination: &Path) -> Result<()> {
    for entry in std::fs::read_dir(staging)? {
        let entry = entry?;
        if entry.file_name() == IDENTITY_FILE {
            continue;
        }
        std::fs::rename(entry.path(), destination.join(entry.file_name()))?;
    }
    std::fs::rename(staging.join(IDENTITY_FILE), destination.join(IDENTITY_FILE))?;
    sync_dir(destination);
    std::fs::remove_dir_all(staging)?;
    Ok(())
}

fn delete_node_state(dir: &Path) -> Result<()> {
    // Everything but the key first: a directory left with only a key is still a valid (if
    // empty) repeater, never a keyless one with a roster.
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !is_node_state(&name_str) || name_str == IDENTITY_FILE {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    std::fs::remove_file(dir.join(IDENTITY_FILE))?;
    sync_dir(dir);
    Ok(())
}

fn copy_file(from: &Path, to: &Path) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let bytes = std::fs::read(from).with_context(|| format!("reading {}", from.display()))?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(to)
        .with_context(|| format!("writing {}", to.display()))?;
    std::io::Write::write_all(&mut file, &bytes)?;
    file.sync_all()?;
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    create_private_dir(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &to.join(entry.file_name()))?;
        } else if kind.is_file() {
            copy_file(&entry.path(), &to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

pub fn create_private_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .with_context(|| format!("creating {}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn sync_dir(dir: &Path) {
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

/// Hand a directory and everything in it to `uid:gid` (the service account, or the person a
/// state directory is moved back to).
pub fn chown_tree(dir: &Path, uid: u32, gid: u32) -> Result<()> {
    std::os::unix::fs::lchown(dir, Some(uid), Some(gid))
        .with_context(|| format!("handing {} to its owner", dir.display()))?;
    if std::fs::symlink_metadata(dir)?.is_dir() {
        for entry in std::fs::read_dir(dir)? {
            chown_tree(&entry?.path(), uid, gid)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repeater(dir: &Path, key: &[u8]) {
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join(IDENTITY_FILE), key).unwrap();
        std::fs::write(dir.join("roster.bin"), b"roster").unwrap();
        std::fs::write(dir.join("namespaces.json"), b"{}").unwrap();
        std::fs::write(dir.join("docs/inner"), b"nested").unwrap();
        std::fs::write(dir.join("host.lock"), b"").unwrap();
    }

    #[test]
    fn moves_everything_and_leaves_the_source_without_an_identity() {
        let root = tempfile::tempdir().unwrap();
        let (from, to) = (root.path().join("user"), root.path().join("service"));
        repeater(&from, &[7; 32]);
        assert_eq!(move_state(&from, &to).unwrap(), Moved::Moved);
        assert_eq!(std::fs::read(to.join(IDENTITY_FILE)).unwrap(), [7; 32]);
        assert_eq!(std::fs::read(to.join("roster.bin")).unwrap(), b"roster");
        assert_eq!(std::fs::read(to.join("docs/inner")).unwrap(), b"nested");
        assert!(!to.join("host.lock").exists());
        assert!(!has_identity(&from));
        assert!(!from.join("roster.bin").exists());
        assert!(from.join("host.lock").exists());
        assert!(!staging_for(&to).exists());
        // Running it again is a no-op.
        assert_eq!(move_state(&from, &to).unwrap(), Moved::Nothing);
    }

    #[test]
    fn never_merges_two_identities() {
        let root = tempfile::tempdir().unwrap();
        let (from, to) = (root.path().join("user"), root.path().join("service"));
        repeater(&from, &[1; 32]);
        repeater(&to, &[2; 32]);
        assert!(move_state(&from, &to).is_err());
        assert_eq!(std::fs::read(from.join(IDENTITY_FILE)).unwrap(), [1; 32]);
        assert_eq!(std::fs::read(to.join(IDENTITY_FILE)).unwrap(), [2; 32]);
    }

    #[test]
    fn never_lands_on_a_keyless_roster() {
        let root = tempfile::tempdir().unwrap();
        let (from, to) = (root.path().join("user"), root.path().join("service"));
        repeater(&from, &[1; 32]);
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(to.join("roster.bin"), b"someone else's").unwrap();
        assert!(move_state(&from, &to).is_err());
        assert!(has_identity(&from));
    }

    #[test]
    fn finishes_a_move_interrupted_before_the_source_was_deleted() {
        let root = tempfile::tempdir().unwrap();
        let (from, to) = (root.path().join("user"), root.path().join("service"));
        repeater(&from, &[3; 32]);
        repeater(&to, &[3; 32]);
        assert_eq!(move_state(&from, &to).unwrap(), Moved::Moved);
        assert!(!has_identity(&from));
        assert!(has_identity(&to));
    }

    #[test]
    fn finishes_a_move_interrupted_during_the_swap() {
        let root = tempfile::tempdir().unwrap();
        let (from, to) = (root.path().join("user"), root.path().join("service"));
        repeater(&from, &[4; 32]);
        let staging = staging_for(&to);
        repeater(&staging, &[4; 32]);
        std::fs::create_dir_all(&to).unwrap();
        assert_eq!(move_state(&from, &to).unwrap(), Moved::Moved);
        assert_eq!(std::fs::read(to.join(IDENTITY_FILE)).unwrap(), [4; 32]);
        assert!(!staging.exists());
        assert!(!has_identity(&from));
    }

    #[test]
    fn an_incomplete_staging_copy_is_started_over() {
        let root = tempfile::tempdir().unwrap();
        let (from, to) = (root.path().join("user"), root.path().join("service"));
        repeater(&from, &[5; 32]);
        let staging = staging_for(&to);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("roster.bin"), b"partial").unwrap();
        assert_eq!(move_state(&from, &to).unwrap(), Moved::Moved);
        assert_eq!(std::fs::read(to.join("roster.bin")).unwrap(), b"roster");
    }
}
