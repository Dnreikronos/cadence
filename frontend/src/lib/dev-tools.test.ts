import { describe, expect, it } from "vitest"
import { devToolsEnabled } from "./dev-tools"

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
