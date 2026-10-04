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
