// The security headers: the static ones next.config.ts sets, and the per-request policy
// the middleware sends. Pure functions so a test can read the rules.

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

// What the policy depends on, settled once by next.config.ts from the build's
// NEXT_PUBLIC_* values: `connect-src` (connectSources) and whether the build runs MSW.
export type CspSources = { connect: string[]; mockWorker: boolean }

// next.config.ts hands the sources to the middleware through `env`, which inlines them
// into every bundle, the client's too: public origins only, never a secret.
export function cspEnv({ connect, mockWorker }: CspSources) {
  return {
    CSP_CONNECT_SRC: connect.join(" "),
    CSP_MOCK_WORKER: mockWorker ? "1" : "",
  }
}

// The middleware's side of cspEnv. next.config.ts always sets CSP_CONNECT_SRC, so a
// missing one is a broken build: it throws (every response fails, and says why) rather
// than serve a policy that guesses.
export function readCspEnv(env: {
  CSP_CONNECT_SRC?: string
  CSP_MOCK_WORKER?: string
}): CspSources {
  if (!env.CSP_CONNECT_SRC) {
    throw new Error(
      "CSP_CONNECT_SRC is missing: next.config.ts sets it at build",
    )
  }
  return {
    connect: env.CSP_CONNECT_SRC.split(" "),
    mockWorker: env.CSP_MOCK_WORKER === "1",
  }
}

// The policy is minted per request by the middleware (src/middleware.ts): Next reads the
// nonce from the request's own `content-security-policy` header and stamps it on its
// bootstrap and flight scripts, and `strict-dynamic` passes the trust on to the chunks
// they load. So no inline script runs without the nonce, and none from another origin
// at all. Every page renders per request (the root layout awaits `connection()`): a
// prerendered page would carry no nonce and never hydrate.
//
// Styles keep `unsafe-inline`: React's `style` attributes, sonner's toasts and the
// landing's motion cannot take a nonce, and a style runs no script.
//
// Trusted Types: script sinks (`innerHTML`, `eval`, a script URL) take only typed values,
// and the only policy allowed to make them is the one Next's chunk loader creates. A
// mock-mode build also allows a `default` policy: MSW registers its service worker with
// a plain string, and src/lib/api/mocks/trusted-types.ts lets that one URL through.
// Next's other policy, `nextjs`, is made only by the pages router's loaders, and the app
// has no pages router (and no `next/script`), so it is not listed.
//
// No `unsafe-eval`: zod is told not to probe for it (src/lib/zod-config.ts).
export function contentSecurityPolicy({
  connect,
  frameAncestors,
  mockWorker = false,
  nonce,
}: {
  connect: string[]
  frameAncestors: "'none'" | "'self'"
  mockWorker?: boolean
  nonce: string
}) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    "require-trusted-types-for 'script'",
    `trusted-types nextjs#bundler${mockWorker ? " default" : ""}`,
  ].join("; ")
}

// 16 random bytes, base64: a fresh nonce for one response.
export function mintNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

// The policy for one response. Nothing in the app frames itself or is meant to be framed
// (a sign-in page in an iframe is a clickjacking target), except that the /dev pages may
// frame each other: /dev/components previews the shell in iframes of its own origin.
// `next dev` needs `eval` for its refresh runtime and a websocket for it, which a policy
// cannot allow without weakening it: in development only framing is restricted.
export function policyFor({
  connect,
  dev,
  development,
  mockWorker,
  nonce,
}: {
  // `connect-src`, from connectSources.
  connect: string[]
  // Whether the path is a /dev page (isDevPath).
  dev: boolean
  development: boolean
  // Whether the build runs the API mock (MSW) in the browser.
  mockWorker?: boolean
  // A fresh one (mintNonce) when left out; a test passes its own.
  nonce?: string
}) {
  const frameAncestors = dev ? "'self'" : "'none'"
  return development
    ? `frame-ancestors ${frameAncestors}`
    : contentSecurityPolicy({
        connect,
        frameAncestors,
        mockWorker,
        nonce: nonce ?? mintNonce(),
      })
}

export type HeaderOptions = {
  // HSTS is sent by production builds only: a dev or preview host on plain http must not
  // pin a browser to https. A year, without includeSubDomains, for the first deploy: a
  // mistake costs a year of https-only on this host rather than two on every subdomain
  // of the domain, whose other services nobody here has checked. Raise it, and add
  // includeSubDomains (and preload, if wanted), once the deploy has run clean.
  production?: boolean
}

// The static headers. The policy is not among them: it carries a per-request nonce, so
// the middleware sends it (policyFor), and two policies would both be enforced.
// X-Frame-Options is for older browsers, which ignore frame-ancestors; it follows the
// same rule as policyFor. The /dev rule comes after the global one, so it wins for the
// same header.
export function headerRules({ production = false }: HeaderOptions = {}) {
  return [
    {
      source: "/:path*",
      headers: [
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
      headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
    },
    {
      // The page behind the emailed link carries a one-time token in its URL and form.
      source: "/auth/confirm",
      headers: [{ key: "Cache-Control", value: "no-store" }],
    },
  ]
}
