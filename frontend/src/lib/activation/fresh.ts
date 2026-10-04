import { apiConfig } from "@/lib/api/mode"

// `/activate?fresh=1` is what the demo's "New recipient" button opens: a recipient
// who has set nothing up. The parameter means nothing outside mock mode.
export function wantsFreshDemo(
  search: { get: (name: string) => string | null },
  mockMode: boolean,
) {
  return mockMode && search.get("fresh") === "1"
}

export const isMockMode = () => apiConfig.mode === "mock"

// The literal check on the mode lets Next inline it, as in lib/api/index.ts: a
// real-mode build drops the import and the mock db never reaches the bundle.
export async function resetMockActivation() {
  if (
    process.env.NEXT_PUBLIC_API_MODE !== "real" &&
    apiConfig.mode === "mock"
  ) {
    const { resetAccountStatus } = await import("@/lib/api/mocks/db")
    resetAccountStatus()
  }
}
