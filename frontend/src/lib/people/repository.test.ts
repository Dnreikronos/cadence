import { afterEach, describe, expect, it, vi } from "vitest"

const supabase = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.test",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
}

// The mode is read when the module loads, so each case loads it fresh.
async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const name of [
    "NEXT_PUBLIC_API_MODE",
    "NEXT_PUBLIC_PROOF_API_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ]) {
    vi.stubEnv(name, env[name] ?? "")
  }
  return {
    repository: await import("./repository"),
    errors: await import("./errors"),
    mock: await import("./mock-repository"),
  }
}

afterEach(() => vi.unstubAllEnvs())

describe("peopleRepository", () => {
  it("is the mock in mock mode, even with Supabase configured", async () => {
    const { repository, mock } = await load({
      NEXT_PUBLIC_API_MODE: "mock",
      ...supabase,
    })
    expect(await repository.peopleRepository()).toBe(
      mock.mockPeopleRepository(),
    )
  })

  it("is the mock in mock mode without Supabase", async () => {
    const { repository, mock } = await load({ NEXT_PUBLIC_API_MODE: "mock" })
    expect(await repository.peopleRepository()).toBe(
      mock.mockPeopleRepository(),
    )
  })

  it("is not the mock in real mode: without Supabase it says sign-in is not configured", async () => {
    const { repository, errors } = await load({
      NEXT_PUBLIC_API_MODE: "real",
      NEXT_PUBLIC_PROOF_API_URL: "https://proof.example.test",
    })
    await expect(repository.peopleRepository()).rejects.toBeInstanceOf(
      errors.PeopleNotConfiguredError,
    )
  })

  it("is Supabase's in real mode when it is configured", async () => {
    const { repository, mock } = await load({
      NEXT_PUBLIC_API_MODE: "real",
      NEXT_PUBLIC_PROOF_API_URL: "https://proof.example.test",
      ...supabase,
    })
    const chosen = await repository.peopleRepository()
    expect(chosen).not.toBe(mock.mockPeopleRepository())
    expect(typeof chosen.list).toBe("function")
  })
})
