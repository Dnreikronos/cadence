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
import { COMPANY_WALLET, ME_WALLET, db, resetDb } from "@/lib/api/mocks/db"
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

import {
  associatedTokenAddress,
  fetchPublicUsdc,
  readPublicUsdc,
  usdcMints,
} from "./balances"
import { mockPublicUsdc } from "./mock-balances"

const OWNER = COMPANY_WALLET

// What the node answers for getAccountInfo with jsonParsed data.
function tokenAccount(amount: string) {
  return {
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
    space: 165,
  }
}

function rpcAnswering(account: ReturnType<typeof tokenAccount> | null) {
  const sent: { method: string; params: unknown[] }[] = []
  const transport = (async ({ payload }: { payload: unknown }) => {
    sent.push(payload as (typeof sent)[number])
    return {
      jsonrpc: "2.0",
      id: (payload as { id: unknown }).id,
      result: { context: { slot: 1 }, value: account },
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

describe("associatedTokenAddress", () => {
  // Worked out independently of the kit: sha256 of the owner, the token program,
  // the mint, the bump, the associated-token program and the PDA marker, with
  // the first bump (from 255 down) that lands off the ed25519 curve.
  it.each([
    [OWNER, usdcMints.devnet, "326FkmYoBjhvybQaiiyvsBk2ULFhMFnJRKYDnKJCVfw6"],
    [OWNER, usdcMints.mainnet, "YWqYJ4UXkbSRYmfuM6n9kQjhzyNNMVdSj61HCX28rtP"],
    [
      ME_WALLET,
      usdcMints.devnet,
      "5K3tmjKHJcLujL7SLZcEjutEZnrzMruUXTzQV6z5cQT6",
    ],
    [
      ME_WALLET,
      usdcMints.mainnet,
      "F4YA4H7HeXLCvjLRKdh56FgE4cyHpPqLP1VCM6fEqEmX",
    ],
  ])("derives the account of %s for mint %s", async (owner, mint, expected) => {
    expect(await associatedTokenAddress(owner, mint)).toBe(expected)
  })
})

describe("fetchPublicUsdc", () => {
  it("asks the node for the wallet's associated USDC account, parsed", async () => {
    const { sent, rpc } = rpcAnswering(tokenAccount("1"))
    await fetchPublicUsdc(OWNER, { rpc, mint: usdcMints.devnet })
    expect(sent[0].method).toBe("getAccountInfo")
    expect(sent[0].params[0]).toBe(
      "326FkmYoBjhvybQaiiyvsBk2ULFhMFnJRKYDnKJCVfw6",
    )
    expect(sent[0].params[1]).toMatchObject({ encoding: "jsonParsed" })
  })

  it("reads the balance in exact base units, past what a float holds", async () => {
    const { rpc } = rpcAnswering(tokenAccount("9007199254740993"))
    await expect(fetchPublicUsdc(OWNER, { rpc })).resolves.toBe(
      "9007199254740993",
    )
  })

  it("is zero when the account does not exist yet", async () => {
    const { rpc } = rpcAnswering(null)
    await expect(fetchPublicUsdc(OWNER, { rpc })).resolves.toBe("0")
  })

  it("refuses an amount that is not whole digits", async () => {
    const { rpc } = rpcAnswering(tokenAccount("1.5"))
    await expect(fetchPublicUsdc(OWNER, { rpc })).rejects.toThrow(RangeError)
  })

  it("refuses an account that is not a parsed token account", async () => {
    const { rpc } = rpcAnswering({
      ...tokenAccount("1"),
      data: ["AAAA", "base64"] as never,
    })
    await expect(fetchPublicUsdc(OWNER, { rpc })).rejects.toThrow(TypeError)
  })

  it("refuses a wallet that is not an address", async () => {
    const { rpc } = rpcAnswering(null)
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

  it("refuses to prepare a wrap larger than what the wallet holds", async () => {
    await expect(
      api.wrap.prepare({
        company_wallet: COMPANY_WALLET,
        amount: "12500000001",
      }),
    ).rejects.toMatchObject({ code: "insufficient_usdc" })
    await expect(
      api.wrap.prepare({
        company_wallet: COMPANY_WALLET,
        amount: "12500000000",
      }),
    ).resolves.toBeDefined()
  })

  it("still refuses at confirm when the balance fell after the prepare, and spends nothing", async () => {
    scenarios.set("instant")
    const prepared = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "5000000000",
    })
    db.publicUsdc = 1_000_000n

    await expect(
      api.wrap.confirm({ request_id: prepared.request_id, signature: SIG }),
    ).rejects.toMatchObject({ code: "insufficient_usdc" })

    await expect(mockPublicUsdc(COMPANY_WALLET)).resolves.toBe("1000000")
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
