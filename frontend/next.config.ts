import type { NextConfig } from "next"
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants"
import { readApiConfig } from "./src/lib/api/config"
import { readSiteUrl } from "./src/lib/auth/site-url"
import { readCluster } from "./src/lib/solana/cluster-config"
import { connectSources, headerRules } from "./src/lib/security-headers"
import { isSupabaseConfigured } from "./src/lib/supabase/env"

// What the CSP depends on is computed when the config loads, from the same NEXT_PUBLIC_*
// values the bundle inlines, so the policy always names the origins the build was made to
// call (and allows the mock's worker only in a mock build). It reaches the middleware,
// which sends the policy with a per-request nonce, through `env`: inlined at build like
// the NEXT_PUBLIC_* values themselves.
function cspSources(production: boolean) {
  const nodeEnv = production ? "production" : process.env.NODE_ENV
  const cluster = readCluster({
    cluster: process.env.NEXT_PUBLIC_SOLANA_CLUSTER,
    rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
    nodeEnv,
  })
  const api = readApiConfig({
    mode: process.env.NEXT_PUBLIC_API_MODE,
    baseUrl: process.env.NEXT_PUBLIC_PROOF_API_URL,
    isMainnet: cluster.isMainnet,
    nodeEnv,
  })
  return {
    connect: connectSources({
      apiBaseUrl: api.baseUrl,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      rpcUrl: cluster.rpcUrl,
    }),
    mockWorker: api.mode === "mock",
  }
}

export default function config(phase: string): NextConfig {
  // Fails the build, like NEXT_PUBLIC_API_MODE: a production deploy with Supabase must
  // say which origin its emailed sign-in links point at.
  if (phase === PHASE_PRODUCTION_BUILD) {
    readSiteUrl({
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
      supabaseConfigured: isSupabaseConfigured(),
      nodeEnv: "production",
    })
  }
  const production =
    phase === PHASE_PRODUCTION_BUILD || phase === PHASE_PRODUCTION_SERVER
  const csp = cspSources(production)
  return {
    env: {
      CSP_CONNECT_SRC: csp.connect.join(" "),
      CSP_MOCK_WORKER: csp.mockWorker ? "1" : "",
    },
    // The framework's name and version are of use to nobody but a scanner.
    poweredByHeader: false,
    // (`next start` serves the headers `next build` wrote to the routes manifest.)
    async headers() {
      return headerRules({ production })
    },
    webpack(config, { isServer }) {
      // msw/browser is not exported for the `node` condition, and the mock API only
      // ever starts in the browser. The server build gets an empty module.
      if (isServer) {
        config.resolve.alias = { ...config.resolve.alias, "msw/browser": false }
      }
      return config
    },
  }
}
