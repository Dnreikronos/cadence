import { describe, expect, it } from "vitest"
import { bytesFromBase64 } from "@/lib/api/base64"
import {
  mockAccountTransaction,
  mockTokenAccount,
  mockTransaction,
  mockTransferTransaction,
} from "@/lib/api/mocks/chain"
import { devnetRunPayment as devnet } from "./devnet-fixture"
import {
  UnexpectedTransactionError,
  checkConfidentialTransfer,
  checkSignedOnlyBy,
  inspectTransaction,
} from "./inspect"
import { programs } from "./programs"

const WALLET = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const SOURCE = mockTokenAccount(WALLET)
const DESTINATION = mockTokenAccount("bruno")
const MINT = "CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb"

const transfer = (overrides: Partial<{ destination: string }> = {}) =>
  mockTransferTransaction({
    wallet: WALLET,
    source: SOURCE,
    destination: DESTINATION,
    mint: MINT,
    n: 1,
    ...overrides,
  })

const expected = { wallet: WALLET, source: SOURCE, destination: DESTINATION }

// The reason a check refused, or null when it passed.
function refusal(check: () => void) {
  try {
    check()
    return null
  } catch (error) {
    expect(error).toBeInstanceOf(UnexpectedTransactionError)
    return (error as UnexpectedTransactionError).reason
  }
}

const token2022 = (data: number[], accounts = [[SOURCE, true, false]]) => ({
  program: programs.token2022,
  accounts: [...accounts, [WALLET, false, true]] as [
    string,
    boolean,
    boolean,
  ][],
  data: Uint8Array.from(data),
})

describe("inspectTransaction", () => {
  it("reads a v1 payment the proof service built and devnet finalized", () => {
    const tx = inspectTransaction(bytesFromBase64(devnet.transaction))
    expect(tx.version).toBe(1)
    expect(tx.feePayer).toBe(devnet.wallet)
    expect(tx.signers).toEqual([devnet.wallet])
    expect(tx.instructions.map((ix) => ix.program)).toEqual([
      programs.system,
      programs.zkProof,
      programs.system,
      programs.zkProof,
      programs.system,
      programs.zkProof,
      programs.token2022,
      programs.zkProof,
      programs.zkProof,
      programs.zkProof,
    ])
    expect(tx.writable).toContain(devnet.sender)
    expect(tx.writable).toContain(devnet.destination)
    expect(tx.writable).not.toContain(devnet.mint)
  })

  it("reads the v0 transactions the wrap uses", () => {
    const tx = inspectTransaction(
      mockAccountTransaction({ kind: "wrap", wallet: WALLET, n: 2 }),
    )
    expect(tx.version).toBe(0)
    expect(tx.feePayer).toBe(WALLET)
  })

  it("refuses bytes that are not a transaction", () => {
    expect(refusal(() => inspectTransaction(Uint8Array.of(1, 2, 3)))).toBe(
      "undecodable",
    )
  })

  it("refuses a legacy transaction: the contract sends only versions 0 and 1", () => {
    const v0 = mockTransaction({
      version: 0,
      wallet: WALLET,
      n: 3,
      instructions: [],
    })
    expect(refusal(() => inspectTransaction(v0))).toBeNull()
    // Without the 0x80 version byte that follows the one signature, the same message
    // reads as a legacy one.
    const legacy = Uint8Array.from([...v0.slice(0, 65), ...v0.slice(66)])
    expect(refusal(() => inspectTransaction(legacy))).toBe("version")
  })
})

describe("checkConfidentialTransfer", () => {
  it("accepts the devnet payment for the accounts it paid from and to", () => {
    const tx = inspectTransaction(bytesFromBase64(devnet.transaction))
    expect(
      refusal(() =>
        checkConfidentialTransfer(tx, {
          wallet: devnet.wallet,
          source: devnet.sender,
          destination: devnet.destination,
        }),
      ),
    ).toBeNull()
  })

  it("accepts the mock's transfer", async () => {
    const tx = inspectTransaction(await transfer())
    expect(refusal(() => checkConfidentialTransfer(tx, expected))).toBeNull()
  })

  it("refuses a payment to another account than the one approved", async () => {
    const tx = inspectTransaction(await transfer({ destination: OTHER }))
    expect(refusal(() => checkConfidentialTransfer(tx, expected))).toBe(
      "destination",
    )
  })

  it("refuses a payment from another account than the company's", () => {
    const tx = inspectTransaction(bytesFromBase64(devnet.transaction))
    expect(
      refusal(() =>
        checkConfidentialTransfer(tx, {
          wallet: devnet.wallet,
          source: SOURCE,
          destination: devnet.destination,
        }),
      ),
    ).toBe("source")
  })

  it("refuses the devnet payment for another wallet", () => {
    const tx = inspectTransaction(bytesFromBase64(devnet.transaction))
    expect(
      refusal(() =>
        checkConfidentialTransfer(tx, {
          wallet: OTHER,
          source: devnet.sender,
          destination: devnet.destination,
        }),
      ),
    ).toBe("signer")
  })

  it("refuses a transaction that is not a confidential transfer", () => {
    const tx = inspectTransaction(
      mockAccountTransaction({ kind: "apply-pending", wallet: WALLET, n: 4 }),
    )
    expect(refusal(() => checkConfidentialTransfer(tx, expected))).toBe(
      "transfer",
    )
  })

  it("refuses a second transfer in the same transaction", async () => {
    const tx = inspectTransaction(await transfer())
    const twice = {
      ...tx,
      instructions: [...tx.instructions, ...tx.instructions],
    }
    expect(refusal(() => checkConfidentialTransfer(twice, expected))).toBe(
      "transfer",
    )
  })

  it("refuses an account it would write that is neither party nor a proof context", async () => {
    const tx = inspectTransaction(await transfer())
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          { ...tx, writable: [...tx.writable, OTHER] },
          expected,
        ),
      ),
    ).toBe("writable")
  })
})

describe("checkSignedOnlyBy", () => {
  const only = (
    instructions: Parameters<typeof mockTransaction>[0]["instructions"],
  ) =>
    inspectTransaction(
      mockTransaction({ version: 1, wallet: WALLET, n: 5, instructions }),
    )

  it.each(["wrap", "unwrap", "configure", "apply-pending"] as const)(
    "accepts the mock's %s",
    (kind) => {
      const tx = inspectTransaction(
        mockAccountTransaction({ kind, wallet: WALLET, n: 6 }),
      )
      expect(refusal(() => checkSignedOnlyBy(tx, WALLET))).toBeNull()
    },
  )

  it("refuses a fee payer that is not the wallet", () => {
    const tx = inspectTransaction(
      mockAccountTransaction({ kind: "apply-pending", wallet: OTHER, n: 7 }),
    )
    expect(refusal(() => checkSignedOnlyBy(tx, WALLET))).toBe("signer")
  })

  it("refuses a second signer", () => {
    const tx = only([token2022([27, 8], [[OTHER, true, true]])])
    expect(refusal(() => checkSignedOnlyBy(tx, WALLET))).toBe("signer")
  })

  it("refuses a program that is not on the list", () => {
    const tx = only([
      {
        program: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        accounts: [],
        data: Uint8Array.of(1),
      },
    ])
    expect(refusal(() => checkSignedOnlyBy(tx, WALLET))).toBe("program")
  })

  it.each([
    ["a plain transfer", [3]],
    ["a new owner for the account", [6]],
    ["a delegate", [4]],
    ["closing the account", [9]],
    ["an unknown confidential instruction", [27, 4]],
  ])("refuses %s on Token-2022", (_, data) => {
    const tx = only([token2022(data)])
    expect(refusal(() => checkSignedOnlyBy(tx, WALLET))).toBe("instruction")
  })

  it("refuses a System instruction that is not a proof context the wallet funds", async () => {
    const tx = inspectTransaction(await transfer())
    const create = tx.instructions[0]
    const plainTransfer = {
      ...create,
      data: Uint8Array.from([2, 0, 0, 0, ...create.data.slice(4)]),
    }
    expect(
      refusal(() =>
        checkSignedOnlyBy({ ...tx, instructions: [plainTransfer] }, WALLET),
      ),
    ).toBe("instruction")
    // Owned by another program than the proof program.
    const owned = Uint8Array.from(create.data)
    owned[owned.length - 1] ^= 1
    expect(
      refusal(() =>
        checkSignedOnlyBy(
          { ...tx, instructions: [{ ...create, data: owned }] },
          WALLET,
        ),
      ),
    ).toBe("instruction")
  })

  it("refuses closing a proof context to anyone but the wallet", async () => {
    const tx = inspectTransaction(await transfer())
    const close = tx.instructions.at(-1)!
    const elsewhere = {
      ...close,
      accounts: close.accounts.map((account, i) =>
        i === 1 ? { ...account, address: OTHER } : account,
      ),
    }
    expect(
      refusal(() =>
        checkSignedOnlyBy({ ...tx, instructions: [elsewhere] }, WALLET),
      ),
    ).toBe("instruction")
  })
})
