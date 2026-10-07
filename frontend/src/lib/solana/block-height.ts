import { createRpc } from "./rpc"

// Whether a transaction can still land is the chain's call, not the clock's: it can while
// the block height has not gone past its `last_valid_block_height`. The height read is the
// finalized one, which trails the tip by about 13 s, so once it is past nothing below it can
// still change: a transaction that landed in time is finalized by then, and one that did
// not never will.

// The part of the RPC this read uses, so a test can answer it.
export type BlockHeightRpc = {
  getBlockHeight: (config: { commitment: "finalized" }) => {
    send: (options?: { abortSignal?: AbortSignal }) => Promise<bigint>
  }
}

type Options = { rpc?: BlockHeightRpc; signal?: AbortSignal }

export async function fetchBlockHeight({
  rpc = createRpc(),
  signal,
}: Options = {}): Promise<number> {
  const height = await rpc
    .getBlockHeight({ commitment: "finalized" })
    .send({ abortSignal: signal })
  return Number(height)
}

// The finalized block height: the chain in real mode, the mock chain's clock-driven one
// in mock mode (the mock service prepares against the same height). The literal check on
// the mode lets Next inline it, as in ./balances, so the mock never reaches a real build.
// The mode is imported only here, so the flows that default to this read can be imported
// (and tested) without an API mode set.
export async function readBlockHeight(signal?: AbortSignal): Promise<number> {
  if (process.env.NEXT_PUBLIC_API_MODE !== "real") {
    const { apiConfig } = await import("@/lib/api/mode")
    if (apiConfig.mode === "mock") {
      const { mockBlockHeight } = await import("@/lib/api/mocks/chain")
      signal?.throwIfAborted()
      return mockBlockHeight()
    }
  }
  return fetchBlockHeight({ signal })
}

// A transaction can land up to and including its last valid block.
export const pastBlockhash = (lastValidBlockHeight: number, height: number) =>
  height > lastValidBlockHeight
