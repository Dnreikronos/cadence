import { readCluster } from "./cluster-config"

export { readCluster } from "./cluster-config"
export type { Cluster, ClusterName } from "./cluster-config"

// Read at import so a bad cluster fails the build rather than a payment.
// Next inlines NEXT_PUBLIC_* only when referenced literally.
export const cluster = readCluster({
  cluster: process.env.NEXT_PUBLIC_SOLANA_CLUSTER,
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
  nodeEnv: process.env.NODE_ENV,
})
