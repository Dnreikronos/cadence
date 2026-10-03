import { apiConfig } from "@/lib/api/mode"
import { cluster } from "@/lib/solana/cluster"

const badge =
  "rounded-md px-2 py-1 font-mono text-xs font-semibold tracking-wider uppercase shadow"

// Anything not on mainnet moves test money, and mock mode shows made-up data.
// Say so on every page.
export function ClusterBadge() {
  const mock = apiConfig.mode === "mock"
  if (cluster.isMainnet && !mock) return null
  return (
    <div className="fixed right-3 bottom-3 z-50 flex items-center gap-1.5">
      {mock && (
        <div
          title="This app is running on a mock of the service. Balances and payments are not real."
          className={`${badge} bg-amber-100 text-amber-950 ring-1 ring-amber-400`}
        >
          <span aria-hidden>Mock data</span>
          <span className="sr-only">
            Mock data: balances and payments are not real
          </span>
        </div>
      )}
      {!cluster.isMainnet && (
        <div className={`${badge} bg-amber-400 text-amber-950`}>
          {cluster.name}
        </div>
      )}
    </div>
  )
}
