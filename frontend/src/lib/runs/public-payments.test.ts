import { describe, expect, it, vi } from "vitest"
import { base64FromBytes } from "@/lib/api/base64"
import { signAndConfirm } from "@/lib/api/sign"
import {
  mockPublicTransferTransaction,
  mockTokenAccount,
} from "@/lib/api/mocks/chain"
import { COMPANY_WALLET } from "@/lib/api/mocks/db"
import { mockSigner } from "@/lib/api/mocks/signer"
import { wrapAccounts } from "@/lib/solana/accounts"
import { UnexpectedTransactionError } from "@/lib/solana/inspect"
import { approvedPayees, checkedSign } from "./executor"

const wallet = COMPANY_WALLET
const sender = mockTokenAccount(wallet)
const destination = mockTokenAccount("approved recipient")
const mint = (await wrapAccounts()).wrappedMint
const signature = "5SigMockSignature1111111111111111111111111111"
const request_id = "a".repeat(64)
const receipt = { request_id, signature, slot: 1, status: "finalized" as const }
const prepared = {
  position: 0,
  request_id,
  destination,
  required_signers: [wallet],
  transparent: true,
  transaction_version: 1 as const,
  transaction: base64FromBytes(
    mockPublicTransferTransaction({
      wallet,
      source: sender,
      destination,
      mint,
      amount: BigInt(1_000_000),
      n: 1,
    }),
  ),
}

function setup(amount?: string) {
  const submit = vi.fn(async () => signature)
  const confirm = vi.fn(async () => receipt)
  const sign = checkedSign(
    (p, c, onStep, extra) =>
      signAndConfirm(p, {
        signer: mockSigner(wallet),
        submit,
        finality: async () => "finalized",
        confirm: c,
        onStep,
        check: extra.check,
      }),
    async () => ({
      wallet,
      sender,
      mint,
      payees: approvedPayees([[0, destination, amount]]),
    }),
  )
  return { sign, submit, confirm }
}

describe("fallback payments through wallet signing", () => {
  it("signs the public amount approved by the admin", async () => {
    const { sign, submit, confirm } = setup("1000000")
    await expect(sign(prepared, confirm)).resolves.toEqual(receipt)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, "2000000", "bad amount"])(
    "refuses an unapproved public amount %s before submitting",
    async (amount) => {
      const { sign, submit, confirm } = setup(amount)
      await expect(sign(prepared, confirm)).rejects.toThrow(
        UnexpectedTransactionError,
      )
      expect(submit).not.toHaveBeenCalled()
      expect(confirm).not.toHaveBeenCalled()
    },
  )

  it("refuses a public transaction presented as confidential", async () => {
    const { sign, submit, confirm } = setup("1000000")
    await expect(
      sign({ ...prepared, transparent: false }, confirm),
    ).rejects.toThrow(UnexpectedTransactionError)
    expect(submit).not.toHaveBeenCalled()
  })
})
