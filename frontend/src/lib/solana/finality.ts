import { signature as toSignature } from "@solana/kit"
import { createRpc } from "./rpc"

// What the network says of a submitted transaction. A receipt from the proof service is
// its word that the transaction finalized; this is the browser's own read, so a payment
// is shown as done only once the chain says so too. The wallet owns the read, as it owns
// `submit`: the mock wallet asks the mock network (`mockFinality`), and the embedded
// wallet (#78) is to use `fetchFinality`.
export type Finality = "finalized" | "failed" | "pending"

// The part of the RPC this read uses, so a test can answer it.
export type SignatureStatusRpc = {
  getSignatureStatuses: (
    signatures: ReturnType<typeof toSignature>[],
    config: { searchTransactionHistory: boolean },
  ) => {
    send: (options?: { abortSignal?: AbortSignal }) => Promise<{
      value: readonly ({
        err: unknown
        confirmationStatus: string | null
      } | null)[]
    }>
  }
}

// Finalized with no error, finalized with one, or anything short of final (not seen
// yet, or only confirmed: a confirmed error can still be rolled back with its fork).
export async function fetchFinality(
  signature: string,
  {
    rpc = createRpc(),
    signal,
  }: { rpc?: SignatureStatusRpc; signal?: AbortSignal } = {},
): Promise<Finality> {
  const { value } = await rpc
    .getSignatureStatuses([toSignature(signature)], {
      searchTransactionHistory: true,
    })
    .send({ abortSignal: signal })
  const status = value[0]
  if (status?.confirmationStatus !== "finalized") return "pending"
  return status.err === null ? "finalized" : "failed"
}
