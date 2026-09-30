import { describe, expect, it } from "vitest";
import { readCluster } from "./cluster";

describe("readCluster", () => {
  it("defaults to devnet with the public devnet RPC when nothing is set", () => {
    expect(readCluster({})).toEqual({
      name: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      isMainnet: false,
    });
  });

  it("selects mainnet and its public RPC", () => {
    expect(readCluster({ cluster: "mainnet" })).toEqual({
      name: "mainnet",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      isMainnet: true,
    });
  });

  it("prefers an explicit RPC URL over the public endpoint", () => {
    expect(readCluster({ cluster: "mainnet", rpcUrl: "https://rpc.example.com" }).rpcUrl).toBe(
      "https://rpc.example.com",
    );
  });

  it("refuses an unknown cluster instead of silently picking one", () => {
    expect(() => readCluster({ cluster: "mainnet-beta" })).toThrow(/NEXT_PUBLIC_SOLANA_CLUSTER/);
  });
});
