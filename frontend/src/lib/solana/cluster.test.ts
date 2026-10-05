import { afterEach, describe, expect, it, vi } from "vitest"
import { readCluster } from "./cluster"

describe("readCluster", () => {
  it("defaults to devnet with the public devnet RPC when nothing is set", () => {
    expect(readCluster({})).toEqual({
      name: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      isMainnet: false,
    })
  })

  it("selects mainnet and its public RPC", () => {
    expect(readCluster({ cluster: "mainnet" })).toEqual({
      name: "mainnet",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      isMainnet: true,
    })
  })

  it("prefers an explicit RPC URL over the public endpoint", () => {
    expect(
      readCluster({ cluster: "mainnet", rpcUrl: "https://rpc.example.com" })
        .rpcUrl,
    ).toBe("https://rpc.example.com")
  })

  it("refuses an unknown cluster instead of silently picking one", () => {
    expect(() => readCluster({ cluster: "mainnet-beta" })).toThrow(
      /NEXT_PUBLIC_SOLANA_CLUSTER/,
    )
  })

  it("requires a production build to name its cluster", () => {
    expect(() => readCluster({ nodeEnv: "production" })).toThrow(
      /NEXT_PUBLIC_SOLANA_CLUSTER must be set/,
    )
    expect(() => readCluster({ nodeEnv: "production", cluster: "" })).toThrow(
      /NEXT_PUBLIC_SOLANA_CLUSTER must be set/,
    )
  })

  it("accepts an explicit cluster in a production build", () => {
    expect(readCluster({ nodeEnv: "production", cluster: "devnet" }).name).toBe(
      "devnet",
    )
    expect(
      readCluster({ nodeEnv: "production", cluster: "mainnet" }).isMainnet,
    ).toBe(true)
  })

  it("keeps the devnet default for development and tests", () => {
    expect(readCluster({ nodeEnv: "development" }).name).toBe("devnet")
    expect(readCluster({ nodeEnv: "test" }).name).toBe("devnet")
  })
})

describe("cluster-config", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("reads nothing when imported, so next.config.ts can load it under `next start`", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_SOLANA_CLUSTER", "")
    vi.resetModules()
    await expect(import("./cluster-config")).resolves.toHaveProperty(
      "readCluster",
    )
    // The app's own module still reads at import, and fails the build.
    vi.resetModules()
    await expect(import("./cluster")).rejects.toThrow(
      /NEXT_PUBLIC_SOLANA_CLUSTER must be set/,
    )
  })
})
