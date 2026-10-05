// Response headers set in next.config.ts. Pure functions so a test can read the rules.

type Origins = {
  // The base URL readApiConfig settled on: the proof service, or the mock origin.
  apiBaseUrl: string
  // NEXT_PUBLIC_SUPABASE_URL, when set.
  supabaseUrl?: string
  // The Solana RPC endpoint of the cluster the build is for.
  rpcUrl: string
}

const TURNKEY_ORIGIN = "https://api.turnkey.com"

function originOf(url: string | undefined) {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

// Where the browser may send fetches: the app itself, the proof service, Supabase,
// Turnkey (the wallet, not wired yet) and the RPC. In mock mode the service is the mock
// origin: MSW answers it inside the page, but the browser checks `connect-src` before the
// worker sees the request, so the policy names it (and a real build never does).
export function connectSources({
  apiBaseUrl,
  supabaseUrl,
  rpcUrl,
}: Origins): string[] {
  const origins = [
    originOf(apiBaseUrl),
    originOf(supabaseUrl),
    TURNKEY_ORIGIN,
    originOf(rpcUrl),
  ]
  return [
    "'self'",
    ...new Set(origins.filter((origin): origin is string => origin !== null)),
  ]
}

// Stage 1: a static header. The inline allowances are what Next's own bootstrap scripts
// and the styles of the component libraries need. A nonce-based stage 2 (nonce plus
// `strict-dynamic`, no `unsafe-inline`) would drop them. It costs little here: the app
// routes and `/` already render per request (the viewer comes from cookies, and the
// responses are no-store), so a nonce does not take static pages away. It is recommended
// before the wallet lands and not done here (docs/plans/2026-10-04-frontend-completion.md,
// "Before going live"). No `unsafe-eval`: zod is told not to probe for it
// (src/lib/zod-config.ts).
export function contentSecurityPolicy(
  connect: string[],
  frameAncestors: "'none'" | "'self'",
) {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ")
}

export type HeaderOptions = {
  // `connect-src` entries beyond 'self' (see connectSources). Without them the policy
  // only allows the app's own origin.
  connect?: string[]
  // `next dev` needs `eval` for its refresh runtime and a websocket for it, which a policy
  // cannot allow without weakening it: in development only framing is restricted.
  development?: boolean
  // HSTS is sent by production builds only: a dev or preview host on plain http must not
  // pin a browser to https. A year, without includeSubDomains, for the first deploy: a
  // mistake costs a year of https-only on this host rather than two on every subdomain
  // of the domain, whose other services nobody here has checked. Raise it, and add
  // includeSubDomains (and preload, if wanted), once the deploy has run clean.
  production?: boolean
}

// Nothing in the app frames itself or is meant to be framed (a sign-in page in an iframe
// is a clickjacking target), so framing is refused everywhere, except that the /dev
// pages may frame each other: /dev/components previews the shell in iframes of its own
// origin. The rule for them comes after the global one, so it wins for the same header.
export function headerRules({
  connect = ["'self'"],
  development = false,
  production = false,
}: HeaderOptions = {}) {
  const policy = (frameAncestors: "'none'" | "'self'") =>
    development
      ? `frame-ancestors ${frameAncestors}`
      : contentSecurityPolicy(connect, frameAncestors)
  return [
    {
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: policy("'none'") },
        // Older browsers ignore frame-ancestors.
        { key: "X-Frame-Options", value: "DENY" },
        // Not "no-referrer": Chrome then sends `Origin: null` with a form POST, which the
        // confirm page's verify route refuses.
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        },
        ...(production
          ? [
              {
                key: "Strict-Transport-Security",
                value: "max-age=31536000",
              },
            ]
          : []),
      ],
    },
    {
      source: "/dev/:path*",
      headers: [
        { key: "Content-Security-Policy", value: policy("'self'") },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
      ],
    },
    {
      // The page behind the emailed link carries a one-time token in its URL and form.
      source: "/auth/confirm",
      headers: [{ key: "Cache-Control", value: "no-store" }],
    },
  ]
}
