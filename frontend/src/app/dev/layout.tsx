import { notFound } from "next/navigation"
import { devToolsEnabled } from "@/lib/dev-tools"
import { cluster } from "@/lib/solana/cluster"

// Dev tooling renders fake data and is reachable without a session: a 404 on mainnet and,
// in a production build, unless NEXT_PUBLIC_DEV_TOOLS=1 (see `devToolsEnabled`).
export default function DevLayout({ children }: { children: React.ReactNode }) {
  const enabled = devToolsEnabled({
    nodeEnv: process.env.NODE_ENV,
    flag: process.env.NEXT_PUBLIC_DEV_TOOLS,
    isMainnet: cluster.isMainnet,
  })
  if (!enabled) notFound()
  return children
}
