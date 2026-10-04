import type { ClusterName } from "@/lib/solana/cluster"

// Mainnet is the explorer's default, so only another cluster names itself.
export function explorerTxUrl(signature: string, cluster: ClusterName) {
  const path = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`
  return cluster === "mainnet" ? path : `${path}?cluster=${cluster}`
}
