import { devToolsEnabled } from "@/lib/dev-tools"
import { cluster } from "@/lib/solana/cluster"

// The environment `devToolsEnabled` decides on, read where Next inlines it (a literal
// `process.env.NAME`, in the middleware and the layout alike).
export function devToolsEnv() {
  return {
    nodeEnv: process.env.NODE_ENV,
    flag: process.env.NEXT_PUBLIC_DEV_TOOLS,
    isMainnet: cluster.isMainnet,
  }
}

// Only asked for a /dev path, so a bad cluster setting cannot take the public pages down
// with it; and for a /dev path it fails closed, like everything else here.
export function devToolsOff(): boolean {
  try {
    return !devToolsEnabled(devToolsEnv())
  } catch {
    return true
  }
}
