import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { Run, RunRequest } from "@/lib/api/schemas"
import type { Signer } from "@/lib/api/sign"
vi.mock("@/lib/api/mode", () => ({ apiConfig: { mode: "mock", baseUrl: "" } }))

import { createRun } from "./create"
import { walletLinkMessage } from "./keys"
import type { PayrollPerson } from "./plan"

const WALLET = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"
const SENDER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const ACCOUNT = "CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb"
const AES_KEY = "AAAAAAAAAAAAAAAAAAAAAA=="
const USER = "f0000000-0000-4000-8000-000000000001"

const person: PayrollPerson = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Bruno Costa",
  email: "bruno@solaris.test",
  kind: "employee",
  activation: "active",
  amount: "1000000",
  tokenAccount: ACCOUNT,
}

const run = { run_id: "r" } as unknown as Run

function setup(answers: (Run | Error)[]) {
  const sent: RunRequest[] = []
  const signMessage = vi.fn(async () => new Uint8Array(64).fill(7))
  const signer: Signer = {
    address: WALLET,
    signTransaction: async (bytes) => bytes,
    signMessage,
  }
  const create = vi.fn(async (request: RunRequest) => {
    sent.push(request)
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    return answer as Run
  })
  const deps = {
    create,
    userId: async () => USER,
    senderAccount: async () => SENDER,
    balanceKey: async () => AES_KEY,
  }
  return { signer, sent, signMessage, deps }
}

describe("createRun", () => {
  it("sends the sender, the balance key and each person's account at their position", async () => {
    const { signer, sent, signMessage, deps } = setup([run])
    const created = await createRun(signer, [person], deps)
    expect(sent).toEqual([
      {
        company_wallet: WALLET,
        sender: SENDER,
        aes_key: AES_KEY,
        payments: [{ recipient: ACCOUNT, amount: "1000000" }],
      },
    ])
    expect(created).toMatchObject({
      run,
      aesKey: AES_KEY,
      recipients: [person],
    })
    // No link was asked for.
    expect(signMessage).not.toHaveBeenCalled()
  })

  it("signs the link text and sends the same request once more when the wallet is not linked", async () => {
    const { signer, sent, signMessage, deps } = setup([
      new ApiError(409, "wallet_link_required"),
      run,
    ])
    const created = await createRun(signer, [person], deps)
    expect(signMessage).toHaveBeenCalledWith(walletLinkMessage(USER, WALLET))
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({
      ...sent[0],
      wallet_signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]+$/),
    })
    expect(created.request.wallet_signature).toBe(sent[1].wallet_signature)
  })

  it("passes any other refusal on, without signing anything", async () => {
    const { signer, sent, signMessage, deps } = setup([
      new ApiError(403, "wallet_access_denied"),
    ])
    await expect(createRun(signer, [person], deps)).rejects.toMatchObject({
      code: "wallet_access_denied",
    })
    expect(sent).toHaveLength(1)
    expect(signMessage).not.toHaveBeenCalled()
  })

  it("does not link a wallet for a session with no user", async () => {
    const { signer, deps } = setup([new ApiError(409, "wallet_link_required")])
    await expect(
      createRun(signer, [person], { ...deps, userId: async () => null }),
    ).rejects.toMatchObject({ name: "KeyInputUnavailableError" })
  })
})

describe("walletLinkMessage", () => {
  it("is the exact text the service checks", () => {
    expect(new TextDecoder().decode(walletLinkMessage(USER, WALLET))).toBe(
      `Cadence wallet association\nuser:${USER}\nwallet:${WALLET}`,
    )
  })
})
