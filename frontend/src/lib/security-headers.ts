// Response headers set in next.config.ts. A pure function so a test can read the rules.
// Nothing in the app frames itself or is meant to be framed (a sign-in page in an iframe
// is a clickjacking target), so framing is refused everywhere, except that the /dev
// pages may frame each other: /dev/components previews the shell in iframes of its own
// origin. The rule for them comes after the global one, so it wins for the same header.
export function headerRules() {
  return [
    {
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        // Older browsers ignore frame-ancestors.
        { key: "X-Frame-Options", value: "DENY" },
      ],
    },
    {
      source: "/dev/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
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
