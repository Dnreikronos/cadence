import { describe, expect, it } from "vitest"
import { explorerTxUrl } from "./receipt"

describe("explorerTxUrl", () => {
  it("names devnet", () => {
    expect(explorerTxUrl("abc", "devnet")).toBe(
      "https://explorer.solana.com/tx/abc?cluster=devnet",
    )
  })

  it("leaves mainnet as the explorer's default", () => {
    expect(explorerTxUrl("abc", "mainnet")).toBe(
      "https://explorer.solana.com/tx/abc",
    )
  })

  it("keeps a signature from changing the path or the query", () => {
    expect(explorerTxUrl("a/b?c=d#e", "devnet")).toBe(
      "https://explorer.solana.com/tx/a%2Fb%3Fc%3Dd%23e?cluster=devnet",
    )
  })
})
