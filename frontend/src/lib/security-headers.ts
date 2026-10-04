// Response headers set in next.config.ts. A pure function so a test can read the rules.
// Nothing in the app frames itself or is meant to be framed (a sign-in page in an iframe
// is a clickjacking target), so framing is refused everywhere.
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
      // The page behind the emailed link carries a one-time token in its URL and form.
      source: "/auth/confirm",
      headers: [{ key: "Cache-Control", value: "no-store" }],
    },
  ]
}
