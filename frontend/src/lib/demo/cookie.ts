// Whether the browser reached us over https: the proxy's word first (Vercel and most
// hosts set x-forwarded-proto), then the Origin a form post carries. A `secure` cookie
// over plain http is dropped, which would loop the visitor back to sign-in.
export function isHttpsRequest(headers: {
  get(name: string): string | null
}): boolean {
  const forwarded = headers.get("x-forwarded-proto")?.split(",")[0].trim()
  if (forwarded) return forwarded.toLowerCase() === "https"
  return headers.get("origin")?.toLowerCase().startsWith("https:") ?? false
}
