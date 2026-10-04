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

// Whether a request path is `/dev` or under it, however it is spelled: a trailing or
// doubled slash, another case, a percent-encoded letter (`/%64ev`), even encoded twice.
// Next matches routes on the decoded path, so the check has to as well. A path that
// does not decode is not a path any route matches.
export function isDevPath(pathname: string): boolean {
  let path = pathname
  for (let pass = 0; pass < 3; pass++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      return false
    }
    if (decoded === path) break
    path = decoded
  }
  const clean = path
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
  return clean === "/dev" || clean.startsWith("/dev/")
}

// What the middleware answers with a 404: a /dev path while dev tools are off. The
// layout checks too, but a layout is the weakest place in the App Router (a request for
// a page's payload alone can skip it), so the door is here first.
export function blocksDevPath(
  pathname: string,
  env: Parameters<typeof devToolsEnabled>[0],
): boolean {
  return isDevPath(pathname) && !devToolsEnabled(env)
}
