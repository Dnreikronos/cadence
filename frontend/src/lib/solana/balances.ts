import { address, type Address } from "@solana/kit"
import { apiConfig } from "@/lib/api/mode"
import { sumUnits } from "@/lib/money"
import { cluster, type ClusterName } from "./cluster"
import { createRpc } from "./rpc"

// Circle's USDC on each cluster. This is the plain, public token: the wrapped
// confidential mint is the proof service's business.
export const usdcMints: Record<ClusterName, string> = {
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}

// The part of the RPC this read uses, so a test can answer it.
export type TokenBalanceRpc = {
  getTokenAccountsByOwner: (
    owner: Address,
    filter: { mint: Address },
    config: { encoding: "jsonParsed" },
  ) => {
    send: (options?: { abortSignal?: AbortSignal }) => Promise<{
      value: readonly {
        account: {
          data: { parsed: { info: { tokenAmount: { amount: string } } } }
        }
      }[]
    }>
  }
}

type Options = {
  rpc?: TokenBalanceRpc
  mint?: string
  signal?: AbortSignal
}

// What `wallet` holds of the cluster's USDC, in base units, summed over every
// token account it owns for that mint. "0" when it owns none.
export async function fetchPublicUsdc(
  wallet: string,
  { rpc = createRpc(), mint = usdcMints[cluster.name], signal }: Options = {},
): Promise<string> {
  const { value } = await rpc
    .getTokenAccountsByOwner(
      address(wallet),
      { mint: address(mint) },
      { encoding: "jsonParsed" },
    )
    .send({ abortSignal: signal })
  return sumUnits(
    value.map((a) => a.account.data.parsed.info.tokenAmount.amount),
  )
}

// The public USDC balance of a wallet: the chain in real mode, a stand-in in
// mock mode. The literal check on the mode lets Next inline it, as in
// lib/api/index.ts, so a real-mode build drops the import and the mock source
// never reaches the bundle.
export async function readPublicUsdc(
  wallet: string,
  signal?: AbortSignal,
): Promise<string> {
  if (
    process.env.NEXT_PUBLIC_API_MODE !== "real" &&
    apiConfig.mode === "mock"
  ) {
    const { mockPublicUsdc } = await import("./mock-balances")
    return mockPublicUsdc(wallet, signal)
  }
  return fetchPublicUsdc(wallet, { signal })
}
