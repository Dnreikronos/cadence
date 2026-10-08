import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { UnwrapPrepared, UnwrapRequest } from "@/lib/api/schemas"
import type { Signer } from "@/lib/api/sign"
vi.mock("@/lib/api/mode", () => ({ apiConfig: { mode: "mock", baseUrl: "" } }))

import { apiConfig } from "@/lib/api/mode"
import { walletLinkMessage } from "@/lib/runs/keys"
import { prepareUnwrap } from "./prepare"

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const ACCOUNT = "CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb"
const AES_KEY = "AAAAAAAAAAAAAAAAAAAAAA=="
const USER = "f0000000-0000-4000-8000-000000000001"

const prepared = { request_id: "a".repeat(64) } as UnwrapPrepared
const ask = {
  wallet: WALLET,
  amount: "4200000000",
  acknowledge_reveal_risk: false,
}

function setup(answers: (UnwrapPrepared | Error)[]) {
  const sent: UnwrapRequest[] = []
  const signMessage = vi.fn(async () => new Uint8Array(64).fill(7))
  const signer: Signer = {
    address: WALLET,
    signTransaction: async (bytes) => bytes,
    signMessage,
  }
  const prepare = vi.fn(async (request: UnwrapRequest) => {
    sent.push(request)
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    return answer as UnwrapPrepared
  })
  const balanceKey = vi.fn(async () => AES_KEY)
  const deps = {
    prepare,
    userId: async () => USER,
    senderAccount: async () => ACCOUNT,
    balanceKey,
  }
  return { signer, sent, signMessage, balanceKey, deps }
}

describe("prepareUnwrap", () => {
  it("sends the balance key of the wallet's account with the ask", async () => {
    const { signer, sent, signMessage, balanceKey, deps } = setup([prepared])
    expect(await prepareUnwrap(signer, ask, deps)).toBe(prepared)
    expect(balanceKey).toHaveBeenCalledWith(signer, ACCOUNT)
    expect(sent).toEqual([{ ...ask, aes_key: AES_KEY }])
    // No link was asked for.
    expect(signMessage).not.toHaveBeenCalled()
  })

  it("signs the link text and asks once more when the wallet is not linked", async () => {
    const { signer, sent, signMessage, deps } = setup([
      new ApiError(409, "wallet_link_required"),
      prepared,
    ])
    expect(await prepareUnwrap(signer, ask, deps)).toBe(prepared)
    expect(signMessage).toHaveBeenCalledWith(walletLinkMessage(USER, WALLET))
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({
      ...sent[0],
      wallet_signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]+$/),
    })
  })

  it("passes on what the linked ask answers, such as the reveal-risk question", async () => {
    const { signer, sent, deps } = setup([
      new ApiError(409, "wallet_link_required"),
      new ApiError(409, "reveal_risk_not_acknowledged"),
    ])
    await expect(prepareUnwrap(signer, ask, deps)).rejects.toMatchObject({
      code: "reveal_risk_not_acknowledged",
    })
    expect(sent).toHaveLength(2)
  })

  it("passes any other refusal on, without signing anything", async () => {
    const { signer, sent, signMessage, deps } = setup([
      new ApiError(403, "wallet_access_denied"),
    ])
    await expect(prepareUnwrap(signer, ask, deps)).rejects.toMatchObject({
      code: "wallet_access_denied",
    })
    expect(sent).toHaveLength(1)
    expect(signMessage).not.toHaveBeenCalled()
  })

  it("does not link a wallet for a session with no user", async () => {
    const { signer, sent, deps } = setup([
      new ApiError(409, "wallet_link_required"),
    ])
    await expect(
      prepareUnwrap(signer, ask, { ...deps, userId: async () => null }),
    ).rejects.toMatchObject({ name: "KeyInputUnavailableError" })
    expect(sent).toHaveLength(1)
  })

  it("refuses an ask for a wallet other than the signer's before anything is signed", async () => {
    const { signer, sent, signMessage, balanceKey, deps } = setup([prepared])
    await expect(
      prepareUnwrap(signer, { ...ask, wallet: ACCOUNT }, deps),
    ).rejects.toMatchObject({ name: "UnexpectedSignerError" })
    expect(balanceKey).not.toHaveBeenCalled()
    expect(signMessage).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it("refuses in real mode before anything is signed or sent", async () => {
    const { signer, sent, signMessage, deps } = setup([prepared])
    apiConfig.mode = "real"
    try {
      await expect(
        prepareUnwrap(signer, ask, {
          prepare: deps.prepare,
          userId: deps.userId,
        }),
      ).rejects.toMatchObject({ name: "KeyInputUnavailableError" })
    } finally {
      apiConfig.mode = "mock"
    }
    expect(signMessage).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })
})
