import {
  decompileTransactionMessage,
  getAddressDecoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
} from "@solana/kit"
import type { WalletAccounts } from "./accounts"
import {
  CLOSE_CONTEXT_STATE,
  CONFIDENTIAL_TRANSFER_ACCOUNT_EXTENSION,
  CONFIDENTIAL_TRANSFER_EXTENSION,
  CREATE_ACCOUNT_WITH_SEED,
  CREATE_IDEMPOTENT,
  INSTRUCTIONS_SYSVAR,
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_COMPUTE_UNIT_PRICE,
  MAX_LOADED_ACCOUNTS_DATA_SIZE,
  MAX_PRIORITY_FEE_LAMPORTS,
  REALLOCATE,
  computeBudget,
  confidential,
  confidentialDataLength,
  programs,
  proofContextSpace,
  rentExemptMaximum,
  tokenWrap,
  verifyProof,
} from "./programs"

// The pre-sign check. The web app signs the exact bytes the proof service prepared, so
// before it does, it reads them: who signs and pays, which programs run, what each
// instruction does, and every account it names. Each flow (a payment, a wrap, an unwrap,
// configuring an account, applying pending credits) has one shape, as the service builds
// it, and every account in it is derived here or approved by the person, never read from
// the service's answer. Anything else is refused, so a compromised or buggy service
// cannot get a signature for a transaction the person did not approve. Confidential
// amounts are ciphertexts and cannot be checked; public ones (wrap, unwrap) are.

// Why a transaction was refused, as a stable word for tests and logs, never shown.
export type RefusalReason =
  | "undecodable"
  | "version"
  | "lookup"
  | "signer"
  | "program"
  | "budget"
  | "instruction"
  | "context"
  | "transfer"
  | "sender"
  | "destination"
  | "mint"
  | "amount"
  | "writable"

export class UnexpectedTransactionError extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`The prepared transaction is not the one approved (${reason})`)
    this.name = "UnexpectedTransactionError"
  }
}

// What the person reads when a flow's transaction was refused, in every flow alike;
// null for any other error. `what` names the flow's transaction ("deposit").
export function refusalMessage(error: unknown, what: string): string | null {
  return error instanceof UnexpectedTransactionError
    ? `The ${what} Cadence prepared doesn't match what you asked for, so it wasn't signed. Nothing was sent.`
    : null
}

export type InspectedAccount = {
  address: string
  writable: boolean
  signer: boolean
}

export type InspectedInstruction = {
  program: string
  accounts: InspectedAccount[]
  data: Uint8Array
}

// A version 1 message's own budget, in place of compute budget instructions.
export type MessageConfig = {
  priorityFeeLamports?: bigint
  computeUnitLimit?: number
  loadedAccountsDataSizeLimit?: number
  heapSize?: number
}

export type InspectedTransaction = {
  version: 0 | 1
  feePayer: string
  // Every key that must sign, fee payer first.
  signers: string[]
  // Every account the transaction may write.
  writable: string[]
  config: MessageConfig
  instructions: InspectedInstruction[]
}

const refuse = (reason: RefusalReason): never => {
  throw new UnexpectedTransactionError(reason)
}

// Decodes wire bytes, signed or not. Only versions 0 and 1 without lookup tables are
// read: an account loaded from a table cannot be checked without trusting the RPC.
export function inspectTransaction(bytes: Uint8Array): InspectedTransaction {
  let compiled
  try {
    const { messageBytes } = getTransactionDecoder().decode(bytes)
    compiled = getCompiledTransactionMessageDecoder().decode(messageBytes)
  } catch {
    return refuse("undecodable")
  }
  if (compiled.version !== 0 && compiled.version !== 1) {
    return refuse("version")
  }
  if (
    "addressTableLookups" in compiled &&
    (compiled.addressTableLookups?.length ?? 0) > 0
  ) {
    return refuse("lookup")
  }
  let message
  try {
    message = decompileTransactionMessage(compiled)
  } catch {
    return refuse("undecodable")
  }
  const { header, staticAccounts } = compiled
  const writableSigners =
    header.numSignerAccounts - header.numReadonlySignerAccounts
  const firstReadonly =
    staticAccounts.length - header.numReadonlyNonSignerAccounts
  return {
    version: compiled.version,
    feePayer: message.feePayer.address,
    signers: staticAccounts.slice(0, header.numSignerAccounts),
    writable: staticAccounts.filter(
      (_, i) =>
        i < writableSigners ||
        (i >= header.numSignerAccounts && i < firstReadonly),
    ),
    config: { ...("config" in message ? message.config : {}) },
    instructions: (message.instructions as readonly Instruction[]).map(
      (instruction) => ({
        program: instruction.programAddress,
        accounts: (instruction.accounts ?? []).map((account) => ({
          address: account.address,
          // AccountRole: bit 0 is writable, bit 1 is signer.
          writable: (account.role & 1) === 1,
          signer: (account.role & 2) === 2,
        })),
        data: Uint8Array.from(instruction.data ?? []),
      }),
    ),
  }
}

// ---- Reading instruction data ---------------------------------------------------

const view = (data: Uint8Array) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength)
const u32At = (data: Uint8Array, offset: number) =>
  data.length >= offset + 4 ? view(data).getUint32(offset, true) : null
const u64At = (data: Uint8Array, offset: number) =>
  data.length >= offset + 8 ? view(data).getBigUint64(offset, true) : null
const addressAt = (data: Uint8Array, offset: number) =>
  data.length >= offset + 32
    ? getAddressDecoder().decode(data.slice(offset, offset + 32))
    : null

const addresses = (instruction: InspectedInstruction) =>
  instruction.accounts.map((account) => account.address)

const sameList = <T>(actual: readonly T[], expected: readonly T[]) =>
  actual.length === expected.length &&
  actual.every((account, i) => account === expected[i])

// ---- What every transaction must be ---------------------------------------------

// Bounds on what the wallet pays beyond the base fee: a version 0 message's compute
// budget instructions and a version 1 message's config. Never a heap request.
function checkBudgetInstruction({ accounts, data }: InspectedInstruction) {
  const fits = (length: number, value: bigint | number | null, max: number) =>
    data.length === length && value !== null && value <= max
  const ok =
    accounts.length === 0 &&
    (data[0] === computeBudget.setComputeUnitLimit
      ? fits(5, u32At(data, 1), MAX_COMPUTE_UNIT_LIMIT)
      : data[0] === computeBudget.setComputeUnitPrice
        ? fits(9, u64At(data, 1), MAX_COMPUTE_UNIT_PRICE)
        : data[0] === computeBudget.setLoadedAccountsDataSizeLimit &&
          fits(5, u32At(data, 1), MAX_LOADED_ACCOUNTS_DATA_SIZE))
  if (!ok) refuse("budget")
}

function checkConfig({ config }: InspectedTransaction) {
  if (
    (config.computeUnitLimit ?? 0) > MAX_COMPUTE_UNIT_LIMIT ||
    (config.priorityFeeLamports ?? BigInt(0)) >
      BigInt(MAX_PRIORITY_FEE_LAMPORTS) ||
    (config.loadedAccountsDataSizeLimit ?? 0) > MAX_LOADED_ACCOUNTS_DATA_SIZE ||
    config.heapSize !== undefined
  ) {
    refuse("budget")
  }
}

const knownPrograms: ReadonlySet<string> = new Set(Object.values(programs))

// What every prepared transaction passes, whatever the flow: the wallet is the fee payer
// and the only signer, every program is one a flow uses, and the fee stays bounded. It
// says nothing of where money goes: `checkFlow` does, and nothing is signed without it.
export function checkAllowed(tx: InspectedTransaction, wallet: string) {
  if (tx.feePayer !== wallet || tx.signers.some((key) => key !== wallet)) {
    refuse("signer")
  }
  for (const instruction of tx.instructions) {
    if (!knownPrograms.has(instruction.program)) refuse("program")
    // A version 1 message states its budget in its config, bounded below: it carries
    // no compute budget instructions (the service sets none, `v1.rs`).
    if (instruction.program === programs.computeBudget) {
      if (tx.version === 1) refuse("budget")
      checkBudgetInstruction(instruction)
    }
  }
  const budgetTags = tx.instructions
    .filter((ix) => ix.program === programs.computeBudget)
    .map((ix) => ix.data[0])
  if (new Set(budgetTags).size !== budgetTags.length) refuse("budget")
  checkConfig(tx)
}

// ---- What each flow may be --------------------------------------------------------

// What the person approved, with every account derived by this app or chosen by the
// person: the service's answer names none of them.
export type Expected =
  // One payroll payment: from the company's token account to the account the admin
  // approved for that position, in the wrapped mint.
  | {
      flow: "payment"
      wallet: string
      sender: string
      destination: string
      mint: string
    }
  // Public USDC into the wallet's confidential account, and back out to its USDC
  // account, for the amount the person entered (integer base units).
  | { flow: "wrap" | "unwrap"; accounts: WalletAccounts; amount: bigint }
  // Configure the wallet's confidential account; move its pending credits to available.
  | { flow: "configure" | "apply"; accounts: WalletAccounts }

export type Flow = Expected["flow"]

type Kind =
  | "budget"
  | "createContext"
  | "verify"
  | "closeContext"
  | "createAccount"
  | "reallocate"
  | "configure"
  | "deposit"
  | "withdraw"
  | "applyPending"
  | "transfer"
  | "wrap"
  | "unwrap"

// Each flow's instructions as the service builds them (`confidential.rs`, `wrap.rs`,
// `unwrap.rs`): the kinds it may contain, the ones it must contain once, and the proofs
// it verifies. Configure and apply pending have no service builder yet (API_CONTRACT
// "Accounts"); they act on the wallet's confidential account only.
const flows: Record<
  Flow,
  {
    version?: 0 | 1
    kinds: readonly Kind[]
    once: readonly Kind[]
    proofs: readonly number[]
  }
> = {
  payment: {
    version: 1,
    kinds: ["createContext", "verify", "transfer", "closeContext"],
    once: ["transfer"],
    proofs: [
      verifyProof.ciphertextCommitmentEquality,
      verifyProof.batchedGroupedCiphertext3HandlesValidity,
      verifyProof.batchedRangeProofU128,
    ],
  },
  wrap: {
    version: 0,
    kinds: [
      "budget",
      "createAccount",
      "reallocate",
      "configure",
      "verify",
      "wrap",
      "deposit",
    ],
    once: ["wrap", "deposit"],
    proofs: [verifyProof.pubkeyValidity],
  },
  unwrap: {
    version: 1,
    kinds: ["createAccount", "withdraw", "verify", "unwrap"],
    once: ["withdraw", "unwrap"],
    proofs: [
      verifyProof.ciphertextCommitmentEquality,
      verifyProof.batchedRangeProofU64,
    ],
  },
  configure: {
    kinds: ["budget", "createAccount", "reallocate", "configure", "verify"],
    once: ["configure"],
    proofs: [verifyProof.pubkeyValidity],
  },
  apply: {
    kinds: ["budget", "applyPending"],
    once: ["applyPending"],
    proofs: [],
  },
}

// How many of a kind a transaction may hold: a payment's three proof contexts, one of
// everything else (compute budget tags are kept distinct by `checkAllowed`).
const maxOf = (kind: Kind) =>
  ["createContext", "verify", "closeContext", "budget"].includes(kind) ? 3 : 1

// A System `CreateAccountWithSeed` of a proof context: funded by the wallet with no more
// than its rent, at a size the service creates, owned by the proof program. The System
// program checks the address against the base, seed and owner. Returns the account and
// its size, or refuses.
function createdContext(
  instruction: InspectedInstruction,
  wallet: string,
): { account: string; space: number } {
  const { data } = instruction
  const seedLength = u64At(data, 36)
  // Base (32), seed length (u64), seed, lamports (u64), space (u64), owner (32).
  if (
    u32At(data, 0) !== CREATE_ACCOUNT_WITH_SEED ||
    seedLength === null ||
    seedLength > BigInt(32)
  ) {
    return refuse("instruction")
  }
  const seedEnd = 44 + Number(seedLength)
  const lamports = u64At(data, seedEnd)
  const space = u64At(data, seedEnd + 8)
  const sizes = Object.values(proofContextSpace)
  const [funder, account] = addresses(instruction)
  if (
    data.length !== seedEnd + 8 + 8 + 32 ||
    addressAt(data, 4) !== wallet ||
    addressAt(data, seedEnd + 16) !== programs.zkProof ||
    instruction.accounts.length !== 2 ||
    funder !== wallet ||
    lamports === null ||
    space === null ||
    !sizes.includes(Number(space)) ||
    lamports > BigInt(rentExemptMaximum(Number(space)))
  ) {
    return refuse("instruction")
  }
  return { account, space: Number(space) }
}

type Context = {
  wallet: string
  expected: Expected
  // Proof contexts this transaction creates, by account, with their size.
  created: Map<string, number>
  verified: Map<string, number>
  closed: Map<string, number>
}

const bump = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1)

const walletAccountsOf = (expected: Expected) =>
  "accounts" in expected ? expected.accounts : null

// What one instruction is, with every account it names checked against what this
// flow expects. Refuses what is none of the kinds.
function kindOf(instruction: InspectedInstruction, context: Context): Kind {
  const { wallet, expected, created } = context
  const { program, data } = instruction
  const named = addresses(instruction)
  const derived = walletAccountsOf(expected)
  const amount = "amount" in expected ? expected.amount : null
  switch (program) {
    case programs.computeBudget:
      return "budget"
    case programs.system:
      createdContext(instruction, wallet)
      return "createContext"
    case programs.zkProof: {
      if (data[0] === CLOSE_CONTEXT_STATE) {
        // The rent goes back to the wallet, on the wallet's authority.
        if (
          data.length !== 1 ||
          named.length !== 3 ||
          !created.has(named[0]) ||
          named[1] !== wallet ||
          named[2] !== wallet
        ) {
          return refuse("context")
        }
        bump(context.closed, named[0])
        return "closeContext"
      }
      if (!flows[expected.flow].proofs.includes(data[0])) {
        return refuse("instruction")
      }
      // A proof verified in the instruction writes nothing. One verified into a context
      // must be a proof the service keeps in one, go into a context this transaction
      // made, of the size that proof fills, with the wallet as the only authority that
      // can close it.
      if (named.length === 0) return "verify"
      const space = proofContextSpace[data[0]]
      if (
        named.length !== 2 ||
        space === undefined ||
        !created.has(named[0]) ||
        created.get(named[0]) !== space ||
        named[1] !== wallet
      ) {
        return refuse("context")
      }
      bump(context.verified, named[0])
      return "verify"
    }
    case programs.associatedToken: {
      // The wallet's own associated account, paid by the wallet: its confidential one
      // when a wrap or a configure may need it, its USDC one when an unwrap does.
      if (!derived || data.length !== 1 || data[0] !== CREATE_IDEMPOTENT) {
        return refuse("instruction")
      }
      const [account, mint, tokenProgram] =
        expected.flow === "unwrap"
          ? [derived.usdc, derived.usdcMint, programs.token]
          : [derived.confidential, derived.wrappedMint, programs.token2022]
      if (
        !sameList(named, [
          wallet,
          account,
          wallet,
          mint,
          programs.system,
          tokenProgram,
        ])
      ) {
        return refuse("instruction")
      }
      return "createAccount"
    }
    case programs.token2022: {
      if (data[0] === REALLOCATE) {
        // Room for the confidential extension on the wallet's own account.
        if (
          !derived ||
          !sameList(Array.from(data), [
            REALLOCATE,
            CONFIDENTIAL_TRANSFER_ACCOUNT_EXTENSION,
            0,
          ]) ||
          !sameList(named, [
            derived.confidential,
            wallet,
            programs.system,
            wallet,
          ])
        ) {
          return refuse("instruction")
        }
        return "reallocate"
      }
      if (
        data[0] !== CONFIDENTIAL_TRANSFER_EXTENSION ||
        confidentialDataLength[data[1]] !== data.length
      ) {
        return refuse("instruction")
      }
      return confidentialKind(instruction, context, derived, amount)
    }
    case programs.tokenWrap:
      return wrapKind(instruction, wallet, derived, amount)
    default:
      return refuse("program")
  }
}

// One of the confidential transfer extension's steps. A payment's transfer is the only
// one that moves value to another account, and only in the payment flow.
function confidentialKind(
  instruction: InspectedInstruction,
  { wallet, expected, created }: Context,
  derived: WalletAccounts | null,
  amount: bigint | null,
): Kind {
  const { data } = instruction
  const named = addresses(instruction)
  if (data[1] === confidential.transfer) {
    if (expected.flow !== "payment") return refuse("transfer")
    // Sender, mint, destination, the three proof contexts, then the authority.
    const [sender, mint, destination, ...rest] = named
    if (named.length !== 7 || rest[3] !== wallet) return refuse("transfer")
    if (sender !== expected.sender) refuse("sender")
    if (mint !== expected.mint) refuse("mint")
    if (destination !== expected.destination) refuse("destination")
    const contexts = rest.slice(0, 3)
    if (
      new Set(contexts).size !== 3 ||
      contexts.some((account) => !created.has(account))
    ) {
      refuse("context")
    }
    return "transfer"
  }
  if (!derived) return refuse("instruction")
  const accounts = {
    [confidential.configureAccount]: [
      derived.confidential,
      derived.wrappedMint,
      INSTRUCTIONS_SYSVAR,
      wallet,
    ],
    [confidential.deposit]: [derived.confidential, derived.wrappedMint, wallet],
    [confidential.withdraw]: [
      derived.confidential,
      derived.wrappedMint,
      INSTRUCTIONS_SYSVAR,
      wallet,
    ],
    [confidential.applyPendingBalance]: [derived.confidential, wallet],
  }[data[1]]
  if (!accounts) return refuse("instruction")
  // Always the wallet's own confidential account.
  if (named[0] !== derived.confidential) refuse("destination")
  if (!sameList(named, accounts)) refuse("instruction")
  // Deposit and withdraw carry the public amount, a u64 after the two tags.
  if (
    (data[1] === confidential.deposit || data[1] === confidential.withdraw) &&
    u64At(data, 2) !== amount
  ) {
    refuse("amount")
  }
  return (
    {
      [confidential.configureAccount]: "configure",
      [confidential.deposit]: "deposit",
      [confidential.withdraw]: "withdraw",
      [confidential.applyPendingBalance]: "applyPending",
    } as const
  )[data[1] as 2 | 5 | 6 | 8]
}

// Token-wrap's `Wrap` (USDC from the wallet's USDC account into escrow, wrapped tokens
// minted to its confidential account) and `Unwrap` (the reverse, USDC released to its
// USDC account), with every account derived here (`token_wrap.rs`).
function wrapKind(
  instruction: InspectedInstruction,
  wallet: string,
  derived: WalletAccounts | null,
  amount: bigint | null,
): Kind {
  const { data } = instruction
  const named = addresses(instruction)
  if (
    !derived ||
    data.length !== 9 ||
    (data[0] !== tokenWrap.wrap && data[0] !== tokenWrap.unwrap)
  ) {
    return refuse("instruction")
  }
  const wrap = data[0] === tokenWrap.wrap
  const accounts = wrap
    ? [
        derived.confidential,
        derived.wrappedMint,
        derived.wrapAuthority,
        programs.token,
        programs.token2022,
        derived.usdc,
        derived.usdcMint,
        derived.escrow,
        wallet,
      ]
    : [
        derived.escrow,
        derived.usdc,
        derived.wrapAuthority,
        derived.usdcMint,
        programs.token2022,
        programs.token,
        derived.confidential,
        derived.wrappedMint,
        wallet,
      ]
  // The recipient: the first account of a wrap, the second of an unwrap.
  const recipient = wrap ? 0 : 1
  if (named[recipient] !== accounts[recipient]) refuse("destination")
  if (!sameList(named, accounts)) refuse("instruction")
  if (u64At(data, 1) !== amount) refuse("amount")
  return wrap ? "wrap" : "unwrap"
}

// The accounts a flow may write: the wallet, the accounts it names, the contexts it
// creates. Every instruction is already pinned; this catches a writable flag on an
// account no instruction needs to write.
function writableFor(expected: Expected, contexts: Iterable<string>) {
  if (expected.flow === "payment") {
    return new Set([
      expected.wallet,
      expected.sender,
      expected.destination,
      ...contexts,
    ])
  }
  const { wallet, confidential: account } = expected.accounts
  if (expected.flow === "configure" || expected.flow === "apply") {
    return new Set([wallet, account])
  }
  const { usdc, wrappedMint, escrow } = expected.accounts
  return new Set([wallet, account, usdc, wrappedMint, escrow])
}

// A kind out of place, or out of count: a transfer is named, so a payment's refusal
// says so.
const refuseKind = (kind: Kind) =>
  refuse(kind === "transfer" ? "transfer" : "instruction")

// The check a flow's transaction passes before it is signed: `checkAllowed`, then the
// flow's own shape, with every account and public amount checked against `expected`.
export function checkFlow(tx: InspectedTransaction, expected: Expected) {
  const wallet =
    expected.flow === "payment" ? expected.wallet : expected.accounts.wallet
  checkAllowed(tx, wallet)
  const rules = flows[expected.flow]
  if (rules.version !== undefined && tx.version !== rules.version) {
    refuse("version")
  }
  const created = new Map<string, number>()
  for (const instruction of tx.instructions) {
    if (instruction.program !== programs.system) continue
    const { account, space } = createdContext(instruction, wallet)
    if (created.has(account)) refuse("context")
    created.set(account, space)
  }
  const context: Context = {
    wallet,
    expected,
    created,
    verified: new Map(),
    closed: new Map(),
  }
  const counts = new Map<Kind, number>()
  for (const instruction of tx.instructions) {
    const kind = kindOf(instruction, context)
    if (!rules.kinds.includes(kind)) refuseKind(kind)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  for (const [kind, count] of counts) {
    if (count > maxOf(kind)) refuseKind(kind)
  }
  for (const kind of rules.once) {
    if (counts.get(kind) !== 1) refuseKind(kind)
  }
  // Every context made here is verified once and closed back to the wallet once.
  for (const account of created.keys()) {
    if (
      context.verified.get(account) !== 1 ||
      context.closed.get(account) !== 1
    ) {
      refuse("context")
    }
  }
  const allowed = writableFor(expected, created.keys())
  if (tx.writable.some((account) => !allowed.has(account))) refuse("writable")
}

export type TransferAllowlist = {
  // The company's wallet: it signs and pays the fee.
  wallet: string
  // The company's token account the payment comes from.
  sender: string
  // The recipient's token account, as the admin approved it for this position.
  destination: string
  // The wrapped mint, as this app derives it.
  mint: string
}

// One confidential payment, shaped as the service builds it (`confidential.rs`): proof
// contexts created and verified, exactly one Token-2022 confidential transfer from the
// company's account to the approved one, and the contexts closed back to the wallet.
export function checkConfidentialTransfer(
  tx: InspectedTransaction,
  allowlist: TransferAllowlist,
) {
  checkFlow(tx, { flow: "payment", ...allowlist })
}
