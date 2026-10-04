import { COMPANY_WALLET, db } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"

// Mock-mode stand-in for the chain read in ./balances. Imported only through the
// guarded `import()` there. The mock service spends this balance when a wrap
// confirms, so the number moves the way the chain's would.
export async function mockPublicUsdc(
  wallet: string,
  signal?: AbortSignal,
): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  signal?.throwIfAborted()
  // The real read fails with a TypeError when it cannot reach the node.
  if (scenarios.has("rpc-down")) throw new TypeError("Failed to fetch")
  return wallet === COMPANY_WALLET ? db.publicUsdc.toString() : "0"
}
