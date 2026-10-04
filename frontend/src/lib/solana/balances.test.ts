import { createSolanaRpcFromTransport, address } from "@solana/kit"
import type { RpcTransport } from "@solana/kit"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { MOCK_ORIGIN } from "@/lib/api/config"
import { createApiClient } from "@/lib/api/client"
import { COMPANY_WALLET, ME_WALLET, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"

const config = vi.hoisted(() => ({ mode: "mock" as "mock" | "real" }))
vi.mock("@/lib/api/mode", () => ({
  apiConfig: {
    get mode() {
      return config.mode
    },
  },
}))

import { fetchPublicUsdc, readPublicUsdc, usdcMints } from "./balances"
import { mockPublicUsdc } from "./mock-balances"

// What the node answers for getTokenAccountsByOwner with jsonParsed data.
function tokenAccount(amount: string) {
  return {
    pubkey: COMPANY_WALLET,
    account: {
      data: {
        parsed: {
          info: { tokenAmount: { amount, decimals: 6, uiAmount: 0 } },
          type: "account",
        },
        program: "spl-token",
        space: 165,
      },
      executable: false,
      lamports: 2_039_280,
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      rentEpoch: 0,
    },
  }
}

function rpcAnswering(accounts: ReturnType<typeof tokenAccount>[]) {
  const sent: { method: string; params: unknown[] }[] = []
  const transport = (async ({ payload }: { payload: unknown }) => {
    sent.push(payload as (typeof sent)[number])
    return {
      jsonrpc: "2.0",
      id: (payload as { id: unknown }).id,
      result: { context: { slot: 1 }, value: accounts },
    }
  }) as RpcTransport
  return { sent, rpc: createSolanaRpcFromTransport(transport) }
}

describe("usdcMints", () => {
  it("holds valid addresses for both clusters", () => {
    for (const mint of Object.values(usdcMints)) {
      expect(() => address(mint)).not.toThrow()
    }
    expect(usdcMints.devnet).not.toBe(usdcMints.mainnet)
  })
})

describe("fetchPublicUsdc", () => {
  it("asks the node for the wallet's accounts of the USDC mint, parsed", async () => {
    const { sent, rpc } = rpcAnswering([tokenAccount("1")])
    await fetchPublicUsdc(COMPANY_WALLET, { rpc, mint: usdcMints.devnet })
    expect(sent[0].method).toBe("getTokenAccountsByOwner")
    expect(sent[0].params[0]).toBe(COMPANY_WALLET)
    expect(sent[0].params[1]).toEqual({ mint: usdcMints.devnet })
    expect(sent[0].params[2]).toMatchObject({ encoding: "jsonParsed" })
  })

  it("sums every account in exact base units, past what a float holds", async () => {
    const { rpc } = rpcAnswering([
      tokenAccount("12500000000"),
      tokenAccount("1"),
      tokenAccount("9007199254740993"),
    ])
    await expect(fetchPublicUsdc(COMPANY_WALLET, { rpc })).resolves.toBe(
      "9007211754740994",
    )
  })

  it("is zero for a wallet that owns no account of the mint", async () => {
    const { rpc } = rpcAnswering([])
    await expect(fetchPublicUsdc(COMPANY_WALLET, { rpc })).resolves.toBe("0")
  })

  it("refuses an amount that is not whole digits", async () => {
    const { rpc } = rpcAnswering([tokenAccount("1.5")])
    await expect(fetchPublicUsdc(COMPANY_WALLET, { rpc })).rejects.toThrow(
      RangeError,
    )
  })

  it("refuses a wallet that is not an address", async () => {
    const { rpc } = rpcAnswering([])
    await expect(fetchPublicUsdc("not-an-address", { rpc })).rejects.toThrow()
  })
})

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  server.resetHandlers()
  scenarios.clear()
  resetDb()
  config.mode = "mock"
})
afterAll(() => server.close())

const api = createApiClient({
  baseUrl: MOCK_ORIGIN,
  getToken: async () => "test-token",
})
const SIG = "5SigMockSignature1111111111111111111111111111"

describe("the mock public balance", () => {
  it("starts with the seed amount for the company wallet and nothing for others", async () => {
    await expect(mockPublicUsdc(COMPANY_WALLET)).resolves.toBe("12500000000")
    await expect(mockPublicUsdc(ME_WALLET)).resolves.toBe("0")
  })

  it("goes down when a wrap confirms, and not before", async () => {
    scenarios.set("instant")
    const prepared = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "2500000000",
    })
    await expect(mockPublicUsdc(COMPANY_WALLET)).resolves.toBe("12500000000")

    await api.wrap.confirm({ request_id: prepared.request_id, signature: SIG })

    await expect(mockPublicUsdc(COMPANY_WALLET)).resolves.toBe("10000000000")
  })

  it("refuses to confirm a wrap larger than what the wallet holds, and spends nothing", async () => {
    scenarios.set("instant")
    const prepared = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "12500000001",
    })

    await expect(
      api.wrap.confirm({ request_id: prepared.request_id, signature: SIG }),
    ).rejects.toMatchObject({ code: "insufficient_usdc" })

    await expect(mockPublicUsdc(COMPANY_WALLET)).resolves.toBe("12500000000")
  })

  it("fails like an unreachable node under rpc-down", async () => {
    scenarios.set("rpc-down")
    await expect(mockPublicUsdc(COMPANY_WALLET)).rejects.toThrow(TypeError)
  })

  it("stops when the caller aborts", async () => {
    const abort = new AbortController()
    const read = mockPublicUsdc(COMPANY_WALLET, abort.signal)
    abort.abort(new Error("left the page"))
    await expect(read).rejects.toThrow("left the page")
  })
})

describe("readPublicUsdc", () => {
  it("reads the mock source in mock mode", async () => {
    await expect(readPublicUsdc(COMPANY_WALLET)).resolves.toBe("12500000000")
  })

  it("goes to the chain, not the mock, in real mode", async () => {
    config.mode = "real"
    // The chain read rejects an invalid address; the mock would have answered "0".
    await expect(readPublicUsdc("not-an-address")).rejects.toThrow()
  })
})
