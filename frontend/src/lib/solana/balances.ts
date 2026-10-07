import type { Address } from "@solana/kit"
import { apiConfig } from "@/lib/api/mode"
import { sumUnits } from "@/lib/money"
import { associatedTokenAddress, usdcMints } from "./accounts"
import { cluster } from "./cluster"
import { createRpc } from "./rpc"

export { associatedTokenAddress, usdcMints } from "./accounts"

// The part of the RPC this read uses, so a test can answer it.
export type TokenBalanceRpc = {
  getAccountInfo: (
    account: Address,
    config: { encoding: "jsonParsed" },
  ) => {
    send: (options?: { abortSignal?: AbortSignal }) => Promise<{
      // Null when the account does not exist.
      value: {
        data: unknown
      } | null
    }>
  }
}

type Options = {
  rpc?: TokenBalanceRpc
  mint?: string
  signal?: AbortSignal
}

function amountOf(data: unknown): string {
  const info = (
    data as {
      parsed?: { info?: { tokenAmount?: { amount?: unknown } } }
    }
  )?.parsed?.info?.tokenAmount?.amount
  if (typeof info !== "string") {
    throw new TypeError("The account is not a parsed token account")
  }
  return info
}

// What `wallet` holds of the cluster's USDC in its associated token account, in
// base units. "0" when the account does not exist yet.
export async function fetchPublicUsdc(
  wallet: string,
  { rpc = createRpc(), mint = usdcMints[cluster.name], signal }: Options = {},
): Promise<string> {
  const { value } = await rpc
    .getAccountInfo(await associatedTokenAddress(wallet, mint), {
      encoding: "jsonParsed",
    })
    .send({ abortSignal: signal })
  // Reads the digits through the same strict check as every other amount.
  return value ? sumUnits([amountOf(value.data)]) : "0"
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
