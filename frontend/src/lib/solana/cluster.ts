import { z } from "zod"

const publicRpc = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
} as const

export type ClusterName = keyof typeof publicRpc

export type Cluster = { name: ClusterName; rpcUrl: string; isMainnet: boolean }

type ClusterEnv = {
  cluster?: string
  rpcUrl?: string
  // process.env.NODE_ENV: "production" under `next build` and `next start`.
  nodeEnv?: string
}

const schema = z.object({
  cluster: z.enum(["devnet", "mainnet"]).default("devnet"),
  rpcUrl: z.url().optional(),
})

// Devnet is the default for `next dev` and tests only. A production build must name its
// cluster: one that forgot the variable would otherwise ship pointing at devnet, with
// the DEVNET badge and test money, and nothing would say so.
export function readCluster(env: ClusterEnv): Cluster {
  if (env.nodeEnv === "production" && !env.cluster) {
    throw new Error(
      'NEXT_PUBLIC_SOLANA_CLUSTER must be set to "devnet" or "mainnet" in a production build',
    )
  }
  const parsed = schema.safeParse({
    cluster: env.cluster || undefined,
    rpcUrl: env.rpcUrl || undefined,
  })
  if (!parsed.success) {
    throw new Error(
      `NEXT_PUBLIC_SOLANA_CLUSTER must be "devnet" or "mainnet" and NEXT_PUBLIC_SOLANA_RPC_URL a URL: ${z.prettifyError(parsed.error)}`,
    )
  }
  const { cluster, rpcUrl } = parsed.data
  return {
    name: cluster,
    rpcUrl: rpcUrl ?? publicRpc[cluster],
    isMainnet: cluster === "mainnet",
  }
}

// Read at import so a bad cluster fails the build rather than a payment.
// Next inlines NEXT_PUBLIC_* only when referenced literally.
export const cluster = readCluster({
  cluster: process.env.NEXT_PUBLIC_SOLANA_CLUSTER,
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
  nodeEnv: process.env.NODE_ENV,
})
