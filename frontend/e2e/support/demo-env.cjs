// CommonJS because two loaders read it: the Playwright config (compiled to CommonJS) and
// the build script (plain Node).
// The environment the e2e suite builds and serves with: demo mode, which is the mock API
// and no Supabase, whatever a developer's .env.local says (an empty value counts as set,
// so it wins over the file). One definition, used by the build and by the server.
const demoEnv = {
  NEXT_PUBLIC_API_MODE: "mock",
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
  NEXT_PUBLIC_SOLANA_CLUSTER: "devnet",
  NEXT_PUBLIC_SOLANA_RPC_URL: "",
  NEXT_PUBLIC_PROOF_API_URL: "",
}

// Written by `pnpm e2e:build` after a successful build, and read before a build is reused
// (`E2E_SKIP_BUILD=1`): a `.next` from a plain `pnpm build`, or from a build with Supabase
// configured, would run the suite against something that is not the demo.
const markerFile = `${__dirname}/../../.next/e2e-build.json`

function markerFor(env) {
  return {
    apiMode: env.NEXT_PUBLIC_API_MODE,
    supabaseConfigured: Boolean(
      env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
  }
}

module.exports = { demoEnv, markerFile, markerFor }
