export type AuthSearchParams = Promise<
  Record<string, string | string[] | undefined>
>

// Repeated params are ambiguous, so only single values count.
export async function readSearchParams(searchParams: AuthSearchParams) {
  return new URLSearchParams(
    Object.entries(await searchParams).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  )
}
