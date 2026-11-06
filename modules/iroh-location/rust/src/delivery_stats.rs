//! Local-only receipt counts. Never stores coordinates, peer ids, envelopes or exact timestamps.
//! Dedup tokens are keyed, per UPDATE (not per friend), and expire with the 30-day window.

use std::{collections::BTreeMap, path::Path, sync::Mutex};

use anyhow::{bail, Result};
use chrono::{Datelike, Local, Timelike};
use redb::{Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, TableDefinition};

const META: TableDefinition<&str, i32> = TableDefinition::new("meta");
const COUNTS: TableDefinition<&[u8], u64> = TableDefinition::new("counts");
const SEEN: TableDefinition<&[u8], i32> = TableDefinition::new("seen");
const MAX_TOKENS: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Author,
    Friend,
    Other,
    Stash,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathKind {
    Bluetooth,
    LocalIp,
    DirectIp,
    Relay,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelaySetup {
    Yes,
    No,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mechanism {
    Gossip,
    Sync,
}

const SOURCES: &[&str] = &["author", "friend", "other", "stash", "unknown"];
const PATHS: &[&str] = &["bluetooth", "local-ip", "direct-ip", "relay", "unknown"];
const SETUPS: &[&str] = &["yes", "no", "unknown"];
const MECHANISMS: &[&str] = &["gossip", "sync"];

#[derive(Clone, Copy, Debug)]
pub struct Receipt {
    pub day: i32,
    pub hour: u8,
    pub source: Source,
    pub path: PathKind,
    pub relay_setup: RelaySetup,
    pub mechanism: Mechanism,
}

pub fn local_hour() -> (i32, u8) {
    let now = Local::now();
    (now.num_days_from_ce(), now.hour() as u8)
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct DeliveryCount {
    pub hour: u8,
    pub source: String,
    pub path: String,
    pub relay_setup: String,
    pub mechanism: String,
    pub count: u64,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct DeliveryStatistics {
    pub recorded_days: u32,
    pub counts: Vec<DeliveryCount>,
    pub incomplete: bool,
}

pub struct Store {
    db: Database,
    key: zeroize::Zeroizing<[u8; 32]>,
    error: Mutex<Option<i32>>,
}

impl Store {
    pub fn open(root: &Path, identity: &[u8; 32], today: i32) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        let db = Database::create(root.join("delivery-statistics.redb"))?;
        let transaction = db.begin_write()?;
        {
            let mut meta = transaction.open_table(META)?;
            if meta.get("first_day")?.is_none() {
                meta.insert("first_day", today)?;
                meta.insert("pruned_day", today)?;
            }
            transaction.open_table(COUNTS)?;
            transaction.open_table(SEEN)?;
        }
        transaction.commit()?;
        let store = Self {
            db,
            key: zeroize::Zeroizing::new(blake3::derive_key(
                "streetcryptid/delivery-statistics/v1",
                identity,
            )),
            error: Mutex::new(None),
        };
        store.prune(today)?;
        Ok(store)
    }

    fn token(&self, author: &[u8], seq: u64) -> [u8; 32] {
        let mut hash = blake3::Hasher::new_keyed(&self.key);
        hash.update(author);
        hash.update(&seq.to_le_bytes());
        *hash.finalize().as_bytes()
    }

    /// Counter and replay protection commit together. No individually attributable receipt log.
    pub fn record(&self, author: &[u8], seq: u64, receipt: Receipt) -> Result<bool> {
        let result = self.record_inner(&self.token(author, seq), receipt);
        if result.is_err() {
            self.mark_incomplete(receipt.day);
        }
        result
    }

    pub fn mark_incomplete(&self, day: i32) {
        {
            let mut last = self.error.lock().expect("statistics error poisoned");
            *last = Some(last.unwrap_or(day).max(day));
        }
        let persist = || -> Result<()> {
            let transaction = self.db.begin_write()?;
            {
                let mut meta = transaction.open_table(META)?;
                let last = meta
                    .get("incomplete_day")?
                    .map(|n| n.value())
                    .unwrap_or(day);
                meta.insert("incomplete_day", last.max(day))?;
            }
            transaction.commit()?;
            Ok(())
        };
        if let Err(error) = persist() {
            tracing::warn!(%error, "delivery statistics could not persist collection gap");
        }
    }

    fn record_inner(&self, token: &[u8; 32], receipt: Receipt) -> Result<bool> {
        if receipt.hour >= 24 {
            bail!("invalid receipt hour");
        }
        self.prune(receipt.day)?;
        let transaction = self.db.begin_write()?;
        {
            let mut seen = transaction.open_table(SEEN)?;
            if seen.get(token.as_slice())?.is_some() {
                return Ok(false);
            }
            if seen.len()? >= MAX_TOKENS {
                bail!(
                    "delivery statistics capacity reached; collection resumes as history expires"
                );
            }
            let mut key = receipt.day.to_be_bytes().to_vec();
            key.extend([
                receipt.hour,
                receipt.source as u8,
                receipt.path as u8,
                receipt.relay_setup as u8,
                receipt.mechanism as u8,
            ]);
            let mut counts = transaction.open_table(COUNTS)?;
            let previous = counts.get(key.as_slice())?.map(|n| n.value()).unwrap_or(0);
            counts.insert(
                key.as_slice(),
                previous
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("receipt counter overflow"))?,
            )?;
            seen.insert(token.as_slice(), receipt.day)?;
            let mut meta = transaction.open_table(META)?;
            let first = meta
                .get("first_day")?
                .map(|n| n.value())
                .unwrap_or(receipt.day);
            if receipt.day < first {
                meta.insert("first_day", receipt.day)?;
            }
        }
        transaction.commit()?;
        Ok(true)
    }

    fn prune(&self, today: i32) -> Result<()> {
        let read = self.db.begin_read()?;
        let last = read.open_table(META)?.get("pruned_day")?.map(|n| n.value());
        if last.is_some_and(|last| last >= today) {
            return Ok(());
        }
        drop(read);
        let transaction = self.db.begin_write()?;
        {
            // Today is retained but excluded from the average until its local calendar day ends.
            let floor = today.saturating_sub(30);
            let mut counts = transaction.open_table(COUNTS)?;
            for entry in counts.iter()? {
                if entry?.0.value().len() != 9 {
                    bail!("invalid delivery statistics bucket");
                }
            }
            counts.retain(|key, _| {
                i32::from_be_bytes(key[..4].try_into().expect("length checked")) >= floor
            })?;
            transaction
                .open_table(SEEN)?
                .retain(|_, day| day >= floor)?;
            transaction.open_table(META)?.insert("pruned_day", today)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn snapshot(&self, today: i32) -> Result<DeliveryStatistics> {
        self.prune(today)?;
        let transaction = self.db.begin_read()?;
        let failed_day = transaction
            .open_table(META)?
            .get("incomplete_day")?
            .map(|n| n.value());
        let incomplete = failed_day
            .into_iter()
            .chain(*self.error.lock().expect("statistics error poisoned"))
            .any(|day| day >= today.saturating_sub(30));
        let first = transaction
            .open_table(META)?
            .get("first_day")?
            .ok_or_else(|| anyhow::anyhow!("missing collection start"))?
            .value();
        let recorded_days = today.saturating_sub(first).clamp(0, 30) as u32;
        let mut totals: BTreeMap<[u8; 5], u64> = BTreeMap::new();
        for row in transaction.open_table(COUNTS)?.iter()? {
            let (key, count) = row?;
            let key = key.value();
            if key.len() != 9 {
                bail!("invalid delivery statistics bucket");
            }
            let day = i32::from_be_bytes(key[..4].try_into()?);
            if day < today && day >= today.saturating_sub(recorded_days as i32) {
                let dimensions: [u8; 5] = key[4..].try_into()?;
                *totals.entry(dimensions).or_default() += count.value();
            }
        }
        let mut counts = Vec::new();
        for ([hour, source, path, setup, mechanism], count) in totals {
            if hour >= 24 {
                bail!("invalid delivery statistics hour");
            }
            let label = |values: &[&str], value: u8| -> Result<String> {
                values
                    .get(value as usize)
                    .map(|s| s.to_string())
                    .ok_or_else(|| anyhow::anyhow!("invalid delivery statistics dimension"))
            };
            counts.push(DeliveryCount {
                hour,
                source: label(SOURCES, source)?,
                path: label(PATHS, path)?,
                relay_setup: label(SETUPS, setup)?,
                mechanism: label(MECHANISMS, mechanism)?,
                count,
            });
        }
        Ok(DeliveryStatistics {
            recorded_days,
            counts,
            incomplete,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(day: i32) -> Receipt {
        Receipt {
            day,
            hour: 9,
            source: Source::Friend,
            path: PathKind::Bluetooth,
            relay_setup: RelaySetup::No,
            mechanism: Mechanism::Gossip,
        }
    }

    #[test]
    fn counters_and_dedup_survive_restart_without_friend_records() {
        let root = std::env::temp_dir().join(format!("sc-receipts-{}", rand::random::<u64>()));
        let identity = [7; 32];
        {
            let store = Store::open(&root, &identity, 100).unwrap();
            assert!(store.record(&[42; 32], 1, receipt(100)).unwrap());
            assert!(!store
                .record(
                    &[42; 32],
                    1,
                    Receipt {
                        mechanism: Mechanism::Sync,
                        ..receipt(100)
                    }
                )
                .unwrap());
            assert!(store.record(&[42; 32], 2, receipt(100)).unwrap());
            assert_eq!(store.snapshot(100).unwrap().recorded_days, 0);
        }
        {
            let store = Store::open(&root, &identity, 101).unwrap();
            assert!(!store.record(&[42; 32], 2, receipt(101)).unwrap());
            let report = store.snapshot(103).unwrap();
            assert_eq!(report.recorded_days, 3); // Includes two zero-receipt days.
            assert_eq!(report.counts[0].count, 2);
            assert_eq!(report.counts[0].hour, 9);
            assert_eq!(store.snapshot(131).unwrap().recorded_days, 30);
            assert!(store.snapshot(131).unwrap().counts.is_empty());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_dimension_remains_independent_and_today_is_not_averaged() {
        let root = std::env::temp_dir().join(format!("sc-receipts-{}", rand::random::<u64>()));
        {
            let store = Store::open(&root, &[8; 32], 1).unwrap();
            for (seq, r) in [
                receipt(1),
                Receipt {
                    source: Source::Author,
                    ..receipt(1)
                },
                Receipt {
                    path: PathKind::Relay,
                    ..receipt(1)
                },
                Receipt {
                    relay_setup: RelaySetup::Yes,
                    ..receipt(1)
                },
                Receipt {
                    mechanism: Mechanism::Sync,
                    ..receipt(1)
                },
                receipt(2),
            ]
            .into_iter()
            .enumerate()
            {
                store.record(&[42; 32], seq as u64, r).unwrap();
            }
            let report = store.snapshot(2).unwrap();
            assert_eq!(report.recorded_days, 1);
            assert_eq!(report.counts.len(), 5);
            assert_eq!(report.counts.iter().map(|row| row.count).sum::<u64>(), 5);
            assert_eq!(store.snapshot(40).unwrap().recorded_days, 30);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn collection_gaps_survive_restart_and_expire_with_the_window() {
        let root = std::env::temp_dir().join(format!("sc-receipt-gap-{}", rand::random::<u64>()));
        {
            let store = Store::open(&root, &[8; 32], 1).unwrap();
            store.mark_incomplete(1);
            store.record(&[42; 32], 1, receipt(2)).unwrap();
            assert!(store.snapshot(2).unwrap().incomplete);
        }
        {
            let store = Store::open(&root, &[8; 32], 2).unwrap();
            assert!(store.snapshot(31).unwrap().incomplete);
            assert!(!store.snapshot(32).unwrap().incomplete);
            let transaction = store.db.begin_read().unwrap();
            assert_eq!(transaction.open_table(SEEN).unwrap().len().unwrap(), 1);
            let token = store.token(&[42; 32], 1);
            assert_ne!(token, [42; 32]);
            assert_ne!(token, store.token(&[42; 32], 2));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn travelling_back_a_calendar_day_does_not_hide_those_receipts() {
        let root =
            std::env::temp_dir().join(format!("sc-receipt-local-day-{}", rand::random::<u64>()));
        {
            let store = Store::open(&root, &[8; 32], 100).unwrap();
            store.record(&[42; 32], 1, receipt(99)).unwrap();
            let report = store.snapshot(101).unwrap();
            assert_eq!(report.recorded_days, 2);
            assert_eq!(report.counts[0].count, 1);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
