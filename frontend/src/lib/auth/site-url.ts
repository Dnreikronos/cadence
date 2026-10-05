import { z } from "zod"

type SiteUrlEnv = {
  // NEXT_PUBLIC_SITE_URL
  siteUrl?: string
  supabaseConfigured: boolean
  // process.env.NODE_ENV: "production" under `next build` and `next start`.
  nodeEnv?: string
}

// The same rule as the proof service's URL: plain http only for a local host.
const plainHttpHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

// The origin the emailed sign-in link points at. It must not come from the request: the
// server-action origin check trusts X-Forwarded-Host, so a forged host could otherwise
// put an attacker's origin in a link that Supabase sends to the victim, wherever its
// redirect allowlist is loose. Production with Supabase configured must therefore name
// it, and the build fails without it. Development and tests may fall back to the
// request's own origin (see `emailLinkOrigin`).
export function readSiteUrl(env: SiteUrlEnv): string | null {
  const raw = env.siteUrl?.trim()
  if (!raw) {
    if (env.nodeEnv === "production" && env.supabaseConfigured) {
      throw new Error(
        "NEXT_PUBLIC_SITE_URL is required in a production build with Supabase configured: the origin the emailed sign-in link points at",
      )
    }
    return null
  }
  const parsed = z.url().safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must be a URL such as https://app.example.com: ${z.prettifyError(parsed.error)}`,
    )
  }
  const { protocol, hostname, origin } = new URL(parsed.data)
  const local = protocol === "http:" && plainHttpHosts.has(hostname)
  if (protocol !== "https:" && !local) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must use https unless it points at localhost",
    )
  }
  return origin
}

// Where the link goes: the configured site, always, when there is one. The request's
// Origin is a development and test fallback only; a production build without a site URL
// has none to offer (null), so the caller fails rather than trust the request.
export function emailLinkOrigin(
  siteUrl: string | null,
  requestOrigin: string | null,
  nodeEnv?: string,
): string | null {
  if (siteUrl) return siteUrl
  return nodeEnv === "production" ? null : requestOrigin
}
