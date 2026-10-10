use super::{
    store::{Cursor, Pending},
    verify, Indexer,
};
use crate::error::AppError;
use serde_json::json;
use std::collections::{HashMap, HashSet};

// Recent hashes are accepted for 150 blocks. Keep the full 300-hash queue as
// a conservative discovery allowance; do not compare slots to expiry heights.
const HISTORY_ALLOWANCE: u64 = 300;
pub(super) const FINALITY_GRACE: u64 = 150;

impl Indexer {
    pub(super) async fn discover(
        &self,
        wallet: &str,
        pending: &[&Pending],
        durable: bool,
    ) -> Result<(), AppError> {
        let cursor = if durable {
            self.store.scan(wallet).await?
        } else {
            Cursor::default()
        };
        let resumed = cursor.before.is_some();
        self.scan_history(wallet, pending, durable, cursor).await?;
        if resumed {
            // Catch payments that appeared above the saved head during downtime.
            self.scan_history(wallet, pending, durable, Cursor::default())
                .await?;
        }
        Ok(())
    }

    async fn scan_history(
        &self,
        wallet: &str,
        pending: &[&Pending],
        durable: bool,
        cursor: Cursor,
    ) -> Result<(), AppError> {
        let floor = pending
            .iter()
            .map(|p| p.last_valid_block_height.saturating_sub(HISTORY_ALLOWANCE))
            .min()
            .ok_or(AppError::StorageUnavailable)?;
        let Cursor {
            mut head,
            mut before,
        } = cursor;
        let mut seen = HashSet::new();
        if let Some(before) = &before {
            seen.insert(before.clone());
        }
        let mut heights = HashMap::new();
        let mut previous_slot = u64::MAX;
        'pages: loop {
            let mut config = json!({"commitment":"finalized","limit":1000});
            if let Some(before) = &before {
                config["before"] = json!(before);
            }
            let result = self
                .rpc
                .call("getSignaturesForAddress", json!([wallet, config]))
                .await?;
            let entries = result.as_array().ok_or(AppError::RpcUnavailable)?;
            if entries.is_empty() {
                break;
            }
            for entry in entries {
                let signature = entry["signature"]
                    .as_str()
                    .ok_or(AppError::RpcUnavailable)?;
                let slot = entry["slot"].as_u64().ok_or(AppError::RpcUnavailable)?;
                if !seen.insert(signature.to_owned()) || slot > previous_slot {
                    return Err(AppError::RpcUnavailable);
                }
                previous_slot = slot;
                if head.is_none() {
                    head = Some(signature.to_owned());
                }
                let height = if let Some(height) = heights.get(&slot) {
                    *height
                } else {
                    let height = self.history_height(slot, floor).await?;
                    heights.insert(slot, height);
                    height
                };
                if height < floor {
                    break 'pages;
                }
                if !pending.iter().any(|p| {
                    height >= p.last_valid_block_height.saturating_sub(HISTORY_ALLOWANCE)
                        && height <= p.last_valid_block_height.saturating_add(FINALITY_GRACE)
                }) {
                    continue;
                }
                let result = self.rpc.finalized_transaction(signature).await?;
                // Relevant missing history is still unknown, never proof of failure.
                if result.is_null() {
                    return Err(AppError::Conflict("transaction_history_unavailable"));
                }
                match verify::discovered(&result) {
                    Ok((id, actual)) => {
                        if actual != signature || result["slot"] != slot {
                            return Err(AppError::RpcUnavailable);
                        }
                        for p in self.store.find(&id, wallet).await? {
                            self.record(&p, signature, &result).await?;
                        }
                    }
                    Err(AppError::Conflict("transaction_mismatch")) => {}
                    Err(error) => return Err(error),
                }
            }
            before = Some(
                entries.last().unwrap()["signature"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
            if durable {
                self.store
                    .checkpoint(wallet, head.as_ref().unwrap(), before.as_ref().unwrap())
                    .await?;
            }
            // Short pages are not a reliable end-of-history signal.
        }
        if durable {
            if let Some(head) = head {
                self.store.cursor(wallet, &head).await?;
            }
        }
        Ok(())
    }

    async fn history_height(&self, slot: u64, floor: u64) -> Result<u64, AppError> {
        // Height cannot exceed slot, even when earlier slots were skipped.
        if slot < floor {
            return Ok(0);
        }
        if let Some(height) = self.rpc.finalized_height_at(slot).await? {
            return Ok(height);
        }
        let first = self
            .rpc
            .call("getFirstAvailableBlock", json!([]))
            .await?
            .as_u64()
            .ok_or(AppError::RpcUnavailable)?;
        if slot < first
            && self
                .rpc
                .finalized_height_at(first)
                .await?
                .is_some_and(|height| height < floor)
        {
            return Ok(0);
        }
        Err(AppError::Conflict("transaction_history_unavailable"))
    }
}
