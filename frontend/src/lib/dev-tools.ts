// The /dev pages (component showcase, screen previews, the API playground) render fake
// data and run flows against the mock. They are for `next dev` and for a preview someone
// opted into, never a production deploy by default.
//
// - Mainnet: never.
// - `next dev` (NODE_ENV "development"): always.
// - A production build (`next build`, any deploy): only with NEXT_PUBLIC_DEV_TOOLS=1.
//   Before this, any non-mainnet deploy exposed them without a session.
export function devToolsEnabled(env: {
  nodeEnv?: string
  flag?: string
  isMainnet: boolean
}): boolean {
  if (env.isMainnet) return false
  if (env.nodeEnv !== "production") return true
  return env.flag === "1"
}
