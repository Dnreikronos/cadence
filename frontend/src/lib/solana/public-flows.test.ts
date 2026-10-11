import { describe, expect, it } from "vitest"
import { getU64Encoder } from "@solana/kit"
import {
  mockAccountTransaction,
  mockPublicTransferTransaction,
  mockTokenAccount,
} from "@/lib/api/mocks/chain"
import { COMPANY_WALLET } from "@/lib/api/mocks/db"
import { walletAccounts } from "./accounts"
import { flowCheck } from "./flow-check"
import {
  checkFlow,
  inspectTransaction,
  UnexpectedTransactionError,
} from "./inspect"
import { programs } from "./programs"

const wallet = COMPANY_WALLET
const own = await walletAccounts(wallet)
const source = own.confidential
const destination = mockTokenAccount("approved recipient")
const mint = own.wrappedMint
const amount = BigInt(1_000_000)
const payment = () =>
  inspectTransaction(
    mockPublicTransferTransaction({
      wallet,
      source,
      destination,
      mint,
      amount,
      n: 1,
    }),
  )
const expected = {
  flow: "payment" as const,
  wallet,
  sender: source,
  destination,
  mint,
  transparent: true,
  amount,
}

describe("public payment signing checks", () => {
  it("accepts only the approved transfer and amount", () => {
    expect(() => checkFlow(payment(), expected)).not.toThrow()
    for (const change of [
      { sender: destination },
      { destination: source },
      { mint: programs.token },
      { wallet: destination },
      { amount: amount + BigInt(1) },
      { amount: undefined },
      { transparent: false },
    ]) {
      expect(() => checkFlow(payment(), { ...expected, ...change })).toThrow(
        UnexpectedTransactionError,
      )
    }
  })

  it("rejects extra transfers and incorrect decimals", () => {
    const tx = payment()
    expect(() =>
      checkFlow(
        { ...tx, instructions: [...tx.instructions, tx.instructions[0]] },
        expected,
      ),
    ).toThrow(UnexpectedTransactionError)
    const ix = tx.instructions[0]
    expect(() =>
      checkFlow(
        {
          ...tx,
          instructions: [
            {
              ...ix,
              data: Uint8Array.from([12, ...getU64Encoder().encode(amount), 9]),
            },
          ],
        },
        expected,
      ),
    ).toThrow(UnexpectedTransactionError)
  })
})

describe("public funding signing checks", () => {
  it("accepts a public wrap and checks the requested amount", async () => {
    const tx = inspectTransaction(
      await mockAccountTransaction({
        kind: "wrap",
        wallet,
        amount,
        mode: "public",
        n: 2,
      }),
    )
    await expect(
      flowCheck(wallet, {
        flow: "wrap",
        amount: amount.toString(),
        mode: "public",
      })(tx),
    ).resolves.toBeUndefined()
    await expect(
      flowCheck(wallet, { flow: "wrap", amount: "1", mode: "public" })(tx),
    ).rejects.toThrow(UnexpectedTransactionError)
    await expect(
      flowCheck(wallet, { flow: "wrap", amount: amount.toString() })(tx),
    ).rejects.toThrow(UnexpectedTransactionError)
  })

  it("refuses to encrypt funds requested for the public reserve", async () => {
    const tx = inspectTransaction(
      await mockAccountTransaction({ kind: "wrap", wallet, amount, n: 3 }),
    )
    await expect(
      flowCheck(wallet, {
        flow: "wrap",
        amount: amount.toString(),
        mode: "public",
      })(tx),
    ).rejects.toThrow(UnexpectedTransactionError)
  })
})
