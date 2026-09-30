import { z } from "zod"

const schema = z.object({
  url: z.url(),
  publishableKey: z.string().min(1),
})

// Read lazily so a missing value fails the request that needs it, not the build.
export function supabaseEnv() {
  const parsed = schema.safeParse({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  })
  if (!parsed.success) {
    throw new Error(
      "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (see frontend/README.md)",
    )
  }
  return parsed.data
}
