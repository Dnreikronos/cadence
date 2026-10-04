export type DemoEnv = {
  mode: "mock" | "real"
  supabaseConfigured: boolean
  isMainnet: boolean
}

// The demo viewer is a sign-in that skips authentication, so it exists only where
// nothing real can be reached: the mock API, no Supabase, and never mainnet.
export function demoAllowed({
  mode,
  supabaseConfigured,
  isMainnet,
}: DemoEnv): boolean {
  return mode === "mock" && !supabaseConfigured && !isMainnet
}
