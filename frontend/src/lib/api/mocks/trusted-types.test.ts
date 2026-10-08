import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

beforeEach(() => vi.stubGlobal("location", new URL("http://app.test/company")))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function install() {
  // As the browser does: the created `default` policy becomes `defaultPolicy`.
  const trustedTypes = {
    defaultPolicy: null as unknown,
    createPolicy: vi.fn(
      (
        name: string,
        rules: { createScriptURL(url: string): string | null },
      ) => {
        if (trustedTypes.defaultPolicy) throw new Error("already exists")
        trustedTypes.defaultPolicy = rules
      },
    ),
  }
  const createPolicy = trustedTypes.createPolicy
  vi.stubGlobal("trustedTypes", trustedTypes)
  const { allowMockWorkerUrl } = await import("./trusted-types")
  allowMockWorkerUrl()
  allowMockWorkerUrl()
  return createPolicy
}

describe("allowMockWorkerUrl", () => {
  it("creates the default policy once, however often it is called, with script URLs only", async () => {
    const createPolicy = await install()
    expect(createPolicy).toHaveBeenCalledTimes(1)
    const [name, rules] = createPolicy.mock.calls[0]
    expect(name).toBe("default")
    expect(Object.keys(rules)).toEqual(["createScriptURL"])
  })

  it("lets the worker's URL through, however it is written, and nothing else", async () => {
    const [[, { createScriptURL }]] = (await install()).mock.calls
    expect(createScriptURL("/mockServiceWorker.js")).toBe(
      "/mockServiceWorker.js",
    )
    const absolute = "http://app.test/mockServiceWorker.js"
    expect(createScriptURL(absolute)).toBe(absolute)
    for (const url of [
      "/mockServiceWorker.js?x=1",
      "/other.js",
      "https://evil.example/mockServiceWorker.js",
      "data:text/javascript,alert(1)",
    ])
      expect(createScriptURL(url)).toBeNull()
  })

  it("does nothing in a browser without Trusted Types", async () => {
    const { allowMockWorkerUrl } = await import("./trusted-types")
    expect(() => allowMockWorkerUrl()).not.toThrow()
  })
})
