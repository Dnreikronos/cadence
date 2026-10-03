import { cluster } from "@/lib/solana/cluster"
import { readApiConfig } from "./config"

// Kept apart from the client so a component can read the mode without pulling
// the client in. Read at import so a bad mode fails the build rather than a
// payment. Next inlines NEXT_PUBLIC_* only when referenced literally.
export const apiConfig = readApiConfig({
  mode: process.env.NEXT_PUBLIC_API_MODE,
  baseUrl: process.env.NEXT_PUBLIC_PROOF_API_URL,
  isMainnet: cluster.isMainnet,
  nodeEnv: process.env.NODE_ENV,
})
