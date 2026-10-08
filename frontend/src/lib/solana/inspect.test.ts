import { beforeAll, describe, expect, it } from "vitest"
import { getU64Encoder } from "@solana/kit"
import { bytesFromBase64 } from "@/lib/api/base64"
import {
  mockAccountTransaction,
  mockTokenAccount,
  mockTransaction,
  mockTransferTransaction,
} from "@/lib/api/mocks/chain"
import { walletAccounts, wrapAccounts, type WalletAccounts } from "./accounts"
import { devnetRunPayment as devnet } from "./devnet-fixture"
import { flowCheck } from "./flow-check"
import {
  UnexpectedTransactionError,
  checkAllowed,
  checkConfidentialTransfer,
  checkFlow,
  inspectTransaction,
  type Expected,
  type InspectedInstruction,
  type InspectedTransaction,
} from "./inspect"
import { programs, rentExemptMaximum } from "./programs"

const WALLET = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const SOURCE = mockTokenAccount(WALLET)
const DESTINATION = mockTokenAccount("bruno")

let own: WalletAccounts
let MINT: string
beforeAll(async () => {
  own = await walletAccounts(WALLET)
  MINT = own.wrappedMint
})

const transfer = (overrides: Partial<{ destination: string }> = {}) =>
  mockTransferTransaction({
    wallet: WALLET,
    source: SOURCE,
    destination: DESTINATION,
    mint: MINT,
    n: 1,
    ...overrides,
  }).then(inspectTransaction)

const expected = () => ({
  wallet: WALLET,
  sender: SOURCE,
  destination: DESTINATION,
  mint: MINT,
})

const account = (
  kind: Parameters<typeof mockAccountTransaction>[0]["kind"],
  options: { amount?: bigint; setup?: boolean; wallet?: string } = {},
) =>
  mockAccountTransaction({
    kind,
    wallet: WALLET,
    n: 6,
    amount: BigInt(5),
    ...options,
  }).then(inspectTransaction)

const expect_ = (flow: Expected["flow"]): Expected =>
  flow === "wrap" || flow === "unwrap"
    ? { flow, accounts: own, amount: BigInt(5) }
    : flow === "payment"
      ? { flow, ...expected() }
      : { flow, accounts: own }

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

// The same transaction with instruction `index` changed.
const changed = (
  tx: InspectedTransaction,
  index: number,
  change: (instruction: InspectedInstruction) => InspectedInstruction,
): InspectedTransaction => ({
  ...tx,
  instructions: tx.instructions.map((ix, i) => (i === index ? change(ix) : ix)),
})

// An instruction with account `index` replaced.
const withAccount =
  (index: number, address: string) => (instruction: InspectedInstruction) => ({
    ...instruction,
    accounts: instruction.accounts.map((a, i) =>
      i === index ? { ...a, address } : a,
    ),
  })

const indexOf = (tx: InspectedTransaction, program: string, tag?: number) =>
  tx.instructions.findIndex(
    (ix) => ix.program === program && (tag === undefined || ix.data[0] === tag),
  )

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
    // The service's budget, in the message config.
    expect(tx.config).toEqual({
      computeUnitLimit: 400_000,
      loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
    })
  })

  it("reads the v0 transactions the wrap uses", async () => {
    const tx = await account("wrap")
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

  it("refuses a v0 transaction that loads accounts from a lookup table", () => {
    const v0 = mockTransaction({
      version: 0,
      wallet: WALLET,
      n: 3,
      instructions: [],
    })
    // The last byte of a v0 message is its lookup count: one table, one writable and
    // no readonly index.
    const withTable = Uint8Array.from([
      ...v0.slice(0, -1),
      1,
      ...new Uint8Array(32),
      1,
      0,
      0,
    ])
    expect(refusal(() => inspectTransaction(withTable))).toBe("lookup")
  })
})

describe("checkConfidentialTransfer", () => {
  it("accepts the devnet payment for the accounts it paid from and to", async () => {
    const tx = inspectTransaction(bytesFromBase64(devnet.transaction))
    expect((await wrapAccounts()).wrappedMint).toBe(devnet.mint)
    expect(
      refusal(() =>
        checkConfidentialTransfer(tx, {
          wallet: devnet.wallet,
          sender: devnet.sender,
          destination: devnet.destination,
          mint: devnet.mint,
        }),
      ),
    ).toBeNull()
  })

  it("accepts the mock's transfer", async () => {
    const tx = await transfer()
    expect(refusal(() => checkConfidentialTransfer(tx, expected()))).toBeNull()
  })

  it("refuses a payment to another account than the one approved", async () => {
    const tx = await transfer({ destination: OTHER })
    expect(refusal(() => checkConfidentialTransfer(tx, expected()))).toBe(
      "destination",
    )
  })

  it("refuses a payment from another account than the company's", () => {
    const tx = inspectTransaction(bytesFromBase64(devnet.transaction))
    expect(
      refusal(() =>
        checkConfidentialTransfer(tx, {
          wallet: devnet.wallet,
          sender: SOURCE,
          destination: devnet.destination,
          mint: devnet.mint,
        }),
      ),
    ).toBe("sender")
  })

  it("refuses a payment in another mint", async () => {
    const tx = await transfer()
    const at = indexOf(tx, programs.token2022)
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, withAccount(1, OTHER)),
          expected(),
        ),
      ),
    ).toBe("mint")
  })

  it("refuses the devnet payment for another wallet", () => {
    const tx = inspectTransaction(bytesFromBase64(devnet.transaction))
    expect(
      refusal(() =>
        checkConfidentialTransfer(tx, {
          wallet: OTHER,
          sender: devnet.sender,
          destination: devnet.destination,
          mint: devnet.mint,
        }),
      ),
    ).toBe("signer")
  })

  it("refuses a transaction that is not a confidential transfer", async () => {
    const tx = await account("apply-pending")
    expect(refusal(() => checkConfidentialTransfer(tx, expected()))).toBe(
      "instruction",
    )
  })

  it("refuses a second transfer in the same transaction", async () => {
    const tx = await transfer()
    const twice = {
      ...tx,
      instructions: [
        ...tx.instructions,
        tx.instructions[indexOf(tx, programs.token2022)],
      ],
    }
    expect(refusal(() => checkConfidentialTransfer(twice, expected()))).toBe(
      "transfer",
    )
  })

  it("refuses an account it would write that is neither party nor a proof context", async () => {
    const tx = await transfer()
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          { ...tx, writable: [...tx.writable, OTHER] },
          expected(),
        ),
      ),
    ).toBe("writable")
  })
})

describe("proof contexts", () => {
  const create = (tx: InspectedTransaction) => indexOf(tx, programs.system)

  it("refuses a context funded with more than its rent", async () => {
    const tx = await transfer()
    const at = create(tx)
    const ix = tx.instructions[at]
    // Lamports sit after the u32 tag, the base, the u64 seed length and the seed.
    const data = Uint8Array.from(ix.data)
    const offset = 4 + 32 + 8 + 32
    data.set(getU64Encoder().encode(1_000_000_000), offset)
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, () => ({ ...ix, data })),
          expected(),
        ),
      ),
    ).toBe("instruction")
    // The rent-exempt minimum itself passes.
    data.set(getU64Encoder().encode(rentExemptMaximum(161)), offset)
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, () => ({ ...ix, data })),
          expected(),
        ),
      ),
    ).toBeNull()
  })

  it("reads the owner where it is, not at the end of the data", async () => {
    const tx = await transfer()
    const at = create(tx)
    const ix = tx.instructions[at]
    // Owned by the System program, with the proof program's address appended: the
    // last 32 bytes still name the proof program.
    const owner = ix.data.length - 32
    const data = Uint8Array.from([
      ...ix.data.slice(0, owner),
      ...new Uint8Array(32),
      ...ix.data.slice(owner),
    ])
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, () => ({ ...ix, data })),
          expected(),
        ),
      ),
    ).toBe("instruction")
    // Trailing bytes after the real owner.
    const trailing = Uint8Array.from([...ix.data, 0])
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, () => ({ ...ix, data: trailing })),
          expected(),
        ),
      ),
    ).toBe("instruction")
  })

  it("refuses a context of a size no proof fills", async () => {
    const tx = await transfer()
    const at = create(tx)
    const ix = tx.instructions[at]
    const data = Uint8Array.from(ix.data)
    data.set(getU64Encoder().encode(10_000), 4 + 32 + 8 + 32 + 8)
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, () => ({ ...ix, data })),
          expected(),
        ),
      ),
    ).toBe("instruction")
  })

  it("refuses a proof verified into a context someone else can close", async () => {
    const tx = await transfer()
    const at = indexOf(tx, programs.zkProof, 3)
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, withAccount(1, OTHER)),
          expected(),
        ),
      ),
    ).toBe("context")
  })

  it("refuses a proof verified into an account this transaction did not create", async () => {
    const tx = await transfer()
    const at = indexOf(tx, programs.zkProof, 3)
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, withAccount(0, OTHER)),
          expected(),
        ),
      ),
    ).toBe("context")
  })

  it.each([
    ["configure", "configure", 4],
    ["unwrap", "unwrap", 6],
  ] as const)(
    "refuses a %s proof verified into an account this transaction did not create",
    async (kind, flow, tag) => {
      const tx = await account(kind)
      const at = indexOf(tx, programs.zkProof, tag)
      const into = changed(tx, at, (ix) => ({
        ...ix,
        accounts: [
          { address: OTHER, writable: true, signer: false },
          { address: WALLET, writable: false, signer: true },
        ],
      }))
      expect(refusal(() => checkFlow(into, expect_(flow)))).toBe("context")
    },
  )

  it("refuses a proof the flow does not use", async () => {
    const tx = await transfer()
    const at = indexOf(tx, programs.zkProof, 3)
    const ix = tx.instructions[at]
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, () => ({ ...ix, data: Uint8Array.of(1, 0) })),
          expected(),
        ),
      ),
    ).toBe("instruction")
  })

  it("refuses a context that is created and never closed", async () => {
    const tx = await transfer()
    const kept = {
      ...tx,
      instructions: tx.instructions.slice(0, -1),
    }
    expect(refusal(() => checkConfidentialTransfer(kept, expected()))).toBe(
      "context",
    )
  })

  it("refuses closing a proof context to anyone but the wallet", async () => {
    const tx = await transfer()
    const at = tx.instructions.length - 1
    expect(
      refusal(() =>
        checkConfidentialTransfer(
          changed(tx, at, withAccount(1, OTHER)),
          expected(),
        ),
      ),
    ).toBe("context")
  })
})

describe("checkFlow on the wallet's own accounts", () => {
  it("refuses a known program no flow calls, as a refusal and not a crash", async () => {
    const tx = await account("unwrap")
    const at = indexOf(tx, programs.tokenWrap)
    expect(
      refusal(() =>
        checkFlow(
          changed(tx, at, (ix) => ({ ...ix, program: programs.token })),
          expect_("unwrap"),
        ),
      ),
    ).toBe("program")
  })

  it.each(["wrap", "unwrap", "configure", "apply"] as const)(
    "accepts the mock's %s",
    async (flow) => {
      const tx = await account(flow === "apply" ? "apply-pending" : flow)
      expect(refusal(() => checkFlow(tx, expect_(flow)))).toBeNull()
    },
  )

  it("accepts a wrap that configures the account first", async () => {
    const tx = await account("wrap", { setup: true })
    expect(refusal(() => checkFlow(tx, expect_("wrap")))).toBeNull()
  })

  it.each([
    ["wrap", "apply"],
    ["unwrap", "wrap"],
    ["configure", "apply"],
    ["apply-pending", "configure"],
  ] as const)("refuses a %s checked as %s", async (kind, flow) => {
    const tx = await account(kind)
    expect(refusal(() => checkFlow(tx, expect_(flow)))).not.toBeNull()
  })

  it("refuses a confidential transfer added to an apply", async () => {
    const tx = await account("apply-pending")
    const payment = await transfer({ destination: OTHER })
    const added = {
      ...tx,
      instructions: [
        ...tx.instructions,
        payment.instructions[indexOf(payment, programs.token2022)],
      ],
    }
    expect(refusal(() => checkFlow(added, expect_("apply")))).toBe("transfer")
  })

  it("refuses a wrap minted to another account", async () => {
    const tx = await account("wrap")
    const at = indexOf(tx, programs.tokenWrap)
    expect(
      refusal(() =>
        checkFlow(changed(tx, at, withAccount(0, OTHER)), expect_("wrap")),
      ),
    ).toBe("destination")
  })

  it("refuses an unwrap released to another account", async () => {
    const tx = await account("unwrap")
    const at = indexOf(tx, programs.tokenWrap)
    expect(
      refusal(() =>
        checkFlow(changed(tx, at, withAccount(1, OTHER)), expect_("unwrap")),
      ),
    ).toBe("destination")
  })

  it("refuses a wrap through another escrow", async () => {
    const tx = await account("wrap")
    const at = indexOf(tx, programs.tokenWrap)
    expect(
      refusal(() =>
        checkFlow(changed(tx, at, withAccount(7, OTHER)), expect_("wrap")),
      ),
    ).toBe("instruction")
  })

  it("refuses a token-wrap instruction the flows never send", async () => {
    const tx = await account("wrap")
    const at = indexOf(tx, programs.tokenWrap)
    const ix = tx.instructions[at]
    const data = Uint8Array.from(ix.data)
    data[0] = 0
    expect(
      refusal(() =>
        checkFlow(
          changed(tx, at, () => ({ ...ix, data })),
          expect_("wrap"),
        ),
      ),
    ).toBe("instruction")
  })

  it("refuses a deposit into another account", async () => {
    const tx = await account("wrap")
    const at = indexOf(tx, programs.token2022)
    expect(
      refusal(() =>
        checkFlow(changed(tx, at, withAccount(0, OTHER)), expect_("wrap")),
      ),
    ).toBe("destination")
  })

  it("refuses a wrap or unwrap of another amount than the one asked for", async () => {
    const wrap = await account("wrap", { amount: BigInt(6) })
    expect(refusal(() => checkFlow(wrap, expect_("wrap")))).toBe("amount")
    const unwrap = await account("unwrap", { amount: BigInt(6) })
    expect(refusal(() => checkFlow(unwrap, expect_("unwrap")))).toBe("amount")
  })

  it("refuses an apply on another account", async () => {
    const tx = await account("apply-pending")
    expect(
      refusal(() =>
        checkFlow(changed(tx, 0, withAccount(0, OTHER)), expect_("apply")),
      ),
    ).toBe("destination")
  })

  it("refuses creating someone else's associated account", async () => {
    const tx = await account("unwrap")
    const at = indexOf(tx, programs.associatedToken)
    expect(
      refusal(() =>
        checkFlow(changed(tx, at, withAccount(2, OTHER)), expect_("unwrap")),
      ),
    ).toBe("instruction")
  })
})

describe("flowCheck", () => {
  it("derives the wallet's accounts and passes the flow's own transaction", async () => {
    const tx = await account("unwrap")
    await expect(
      flowCheck(WALLET, { flow: "unwrap", amount: "5" })(tx),
    ).resolves.toBeUndefined()
    await expect(
      flowCheck(WALLET, { flow: "unwrap", amount: "7" })(tx),
    ).rejects.toMatchObject({ reason: "amount" })
    await expect(
      flowCheck(OTHER, { flow: "unwrap", amount: "5" })(tx),
    ).rejects.toMatchObject({ reason: "signer" })
  })
})

describe("checkAllowed", () => {
  const only = (
    instructions: Parameters<typeof mockTransaction>[0]["instructions"],
    version: 0 | 1 = 1,
  ) =>
    inspectTransaction(
      mockTransaction({ version, wallet: WALLET, n: 5, instructions }),
    )

  it("refuses a fee payer that is not the wallet", async () => {
    const tx = await account("apply-pending", { wallet: OTHER })
    expect(refusal(() => checkAllowed(tx, WALLET))).toBe("signer")
  })

  it("refuses a second signer", () => {
    const tx = only([
      {
        program: programs.token2022,
        accounts: [
          [OTHER, true, true],
          [WALLET, false, true],
        ],
        data: Uint8Array.of(27, 8),
      },
    ])
    expect(refusal(() => checkAllowed(tx, WALLET))).toBe("signer")
  })

  it("refuses a program that is not on the list, without throwing anything else", () => {
    const tx = only([
      {
        program: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        accounts: [],
        data: Uint8Array.of(1),
      },
    ])
    expect(refusal(() => checkAllowed(tx, WALLET))).toBe("program")
  })

  it.each([
    ["a unit limit above the runtime's", [2, ...u32(1_400_001)]],
    ["a unit price above the bound", [3, ...u64(100_001)]],
    ["a heap request", [1, ...u32(256 * 1024)]],
    ["a unit limit with trailing bytes", [2, ...u32(400_000), 0]],
  ])("refuses %s", (_, data) => {
    const tx = only(
      [
        {
          program: programs.computeBudget,
          accounts: [],
          data: Uint8Array.from(data),
        },
      ],
      0,
    )
    expect(refusal(() => checkAllowed(tx, WALLET))).toBe("budget")
  })

  it("accepts the budget the service sets, and a bounded price", () => {
    const tx = only(
      [
        {
          program: programs.computeBudget,
          accounts: [],
          data: Uint8Array.from([3, ...u64(100_000)]),
        },
      ],
      0,
    )
    expect(refusal(() => checkAllowed(tx, WALLET))).toBeNull()
  })

  it("refuses compute budget instructions in a v1 message, whose budget is its config", () => {
    const tx = only([
      {
        program: programs.computeBudget,
        accounts: [],
        data: Uint8Array.from([3, ...u64(100_000)]),
      },
    ])
    expect(refusal(() => checkAllowed(tx, WALLET))).toBe("budget")
  })

  it("refuses a v1 priority fee or unit limit above the bounds", async () => {
    const tx = await transfer()
    for (const config of [
      { priorityFeeLamports: BigInt(140_001) },
      { computeUnitLimit: 1_400_001 },
      { heapSize: 64 * 1024 },
    ]) {
      expect(refusal(() => checkAllowed({ ...tx, config }, WALLET))).toBe(
        "budget",
      )
    }
  })
})

const u32 = (value: number) => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return [...bytes]
}
const u64 = (value: number) => [...getU64Encoder().encode(value)]
