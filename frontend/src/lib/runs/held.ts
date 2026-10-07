import { readBlockHeight } from "@/lib/solana/block-height"
import { isSignatureRejection } from "./errors"
import type { Signable } from "./executor"

// The prepared transactions of a run that are still to be signed, kept in memory for as
// long as the page is open. A signature the person cancels sends nothing and stops the
// run there, so the same transactions can be signed again, from that one on, without
// asking the service to prepare new ones. A reload forgets them, and nothing returns a
// transaction a second time: a payment whose transaction is gone was not paid, and cannot
// be any more.

// A held transaction is signed again only while the chain leaves it time to land: its
// `last_valid_block_height` must be at least this many blocks above the finalized height.
// The finalized height trails the tip by about 32 blocks (13 s), and the rest (about 17 s
// at 400 ms a block) is for the person to sign and the network to take it. Letting go of
// one that was still live costs nothing, since it was never sent and cannot land; one sent
// too late is refused by the network after the submit, which is handled as any failure
// after a submit: never answered with a new transaction.
export const heldMarginBlocks = 75

export type Held = { prepared: Signable }

// "ready": the transaction to sign again. "stale": its blockhash is past, or too close to
// it, so it can no longer land. "gone": this page does not hold it.
export type HeldLookup =
  | { status: "ready"; prepared: Signable }
  | { status: "stale" }
  | { status: "gone" }

// `height` is the finalized block height, or null when it could not be read: then nothing
// says the blockhash is live, and it is let go of.
export function lookupHeld(
  held: Held | undefined,
  height: number | null,
): HeldLookup {
  if (!held) return { status: "gone" }
  return height === null ||
    height + heldMarginBlocks > held.prepared.last_valid_block_height
    ? { status: "stale" }
    : { status: "ready", prepared: held.prepared }
}

// Whether a payment's failure leaves its transaction held to sign again: only a refused
// signature does. Anything that came after the submit arrives wrapped in a
// `SentPaymentError`, so it is never a refusal, and the transaction is dropped.
export const keepsHeld = (error: unknown) => isSignatureRejection(error)

export function createHeldStore(
  blockHeight: (signal?: AbortSignal) => Promise<number> = readBlockHeight,
) {
  const held = new Map<string, Held>()
  return {
    // By `paymentKey`.
    hold(key: string, prepared: Signable) {
      held.set(key, { prepared })
    },
    has: (key: string) => held.has(key),
    // The finalized block height to look them up at, read once for a whole run; null
    // when it cannot be read, or the page was left meanwhile.
    height: async (signal?: AbortSignal): Promise<number | null> => {
      try {
        return await blockHeight(signal)
      } catch {
        return null
      }
    },
    // Looks, and keeps it: a signature cancelled again leaves it held.
    lookup: (key: string, height: number | null) =>
      lookupHeld(held.get(key), height),
    // Once it was sent, confirmed, or replaced: it must never be signed again.
    drop: (key: string) => void held.delete(key),
    // Everything a run still holds, in position order: what a sequence that stopped
    // would sign next.
    ofRun: (runId: string) =>
      [...held.entries()]
        .filter(([key]) => key.startsWith(`${runId}:`))
        .map(([, entry]) => entry.prepared)
        .sort((a, b) => a.position - b.position),
  }
}

export type HeldStore = ReturnType<typeof createHeldStore>
