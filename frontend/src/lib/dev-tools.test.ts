import { describe, expect, it } from "vitest"
import { devToolsEnabled, isDevPath } from "./dev-tools"

describe("devToolsEnabled", () => {
  it("is on in the dev server with no setting", () => {
    expect(devToolsEnabled({ nodeEnv: "development", isMainnet: false })).toBe(
      true,
    )
    expect(devToolsEnabled({ nodeEnv: "test", isMainnet: false })).toBe(true)
  })

  it("is off in a production build unless NEXT_PUBLIC_DEV_TOOLS is 1", () => {
    const prod = { nodeEnv: "production", isMainnet: false }
    expect(devToolsEnabled(prod)).toBe(false)
    expect(devToolsEnabled({ ...prod, flag: "" })).toBe(false)
    expect(devToolsEnabled({ ...prod, flag: "0" })).toBe(false)
    expect(devToolsEnabled({ ...prod, flag: "true" })).toBe(false)
    expect(devToolsEnabled({ ...prod, flag: "1" })).toBe(true)
  })

  it("is never on for mainnet, whatever is set", () => {
    expect(
      devToolsEnabled({ nodeEnv: "development", isMainnet: true, flag: "1" }),
    ).toBe(false)
    expect(
      devToolsEnabled({ nodeEnv: "production", isMainnet: true, flag: "1" }),
    ).toBe(false)
  })
})

describe("isDevPath", () => {
  it.each([
    "/dev",
    "/dev/",
    "/dev/api",
    "/dev/components/shell/admin",
    "/dev//api",
    "//dev",
    "/DEV",
    "/Dev/Api",
    "/%64ev",
    "/%64ev/api",
    "/dev%2Fapi",
    "/%2564ev",
    "/%44EV/",
  ])("is %s", (path) => {
    expect(isDevPath(path)).toBe(true)
  })

  it.each([
    "/",
    "/devices",
    "/developers",
    "/dev-tools",
    "/company/dev",
    "/company/dev/x",
    "/me",
    "/sign-in",
    "/%E0%A4%A",
  ])("is not %s", (path) => {
    expect(isDevPath(path)).toBe(false)
  })
})
