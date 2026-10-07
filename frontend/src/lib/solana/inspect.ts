import {
  decompileTransactionMessage,
  getAddressDecoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getU32Decoder,
  type Instruction,
} from "@solana/kit"
import {
  CLOSE_CONTEXT_STATE,
  CONFIDENTIAL_TRANSFER_EXTENSION,
  CREATE_ACCOUNT_WITH_SEED,
  CREATE_IDEMPOTENT,
  LAST_VERIFY_PROOF,
  REALLOCATE,
  computeBudgetTags,
  confidential,
  programs,
} from "./programs"

// The pre-sign check. The web app signs the exact bytes the proof service prepared, so
// before it does, it reads them: who signs and pays, which programs run, what each
// instruction does, and which accounts it writes. Anything outside what the flow needs
// is refused, so a compromised or buggy service cannot get a signature for a
// transaction the person did not approve. Amounts are ciphertexts and cannot be checked.

// Why a transaction was refused, as a stable word for tests and logs, never shown.
export type RefusalReason =
  | "undecodable"
  | "version"
  | "signer"
  | "program"
  | "instruction"
  | "transfer"
  | "source"
  | "destination"
  | "writable"

export class UnexpectedTransactionError extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`The prepared transaction is not the one approved (${reason})`)
    this.name = "UnexpectedTransactionError"
  }
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

export type InspectedTransaction = {
  version: 0 | 1
  feePayer: string
  // Every key that must sign, fee payer first.
  signers: string[]
  // Every account the transaction may write.
  writable: string[]
  instructions: InspectedInstruction[]
}

const refuse = (reason: RefusalReason): never => {
  throw new UnexpectedTransactionError(reason)
}

// Decodes wire bytes, signed or not. Only versions 0 and 1 without lookup tables are
// read: an account loaded from a table cannot be checked without trusting the RPC.
export function inspectTransaction(bytes: Uint8Array): InspectedTransaction {
  let compiled
  let message
  try {
    const { messageBytes } = getTransactionDecoder().decode(bytes)
    compiled = getCompiledTransactionMessageDecoder().decode(messageBytes)
    message =
      compiled.version === "legacy"
        ? null
        : decompileTransactionMessage(compiled)
  } catch {
    return refuse("undecodable")
  }
  if (!message || (compiled.version !== 0 && compiled.version !== 1)) {
    return refuse("version")
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

const accountAt = (instruction: InspectedInstruction, index: number) =>
  instruction.accounts[index]?.address

const addressAt = (data: Uint8Array, offset: number) =>
  data.length >= offset + 32
    ? getAddressDecoder().decode(data.slice(offset, offset + 32))
    : null

// What each program may be asked to do, with the wallet as the only key that signs.
// Nothing here lets an instruction hand the wallet's accounts or lamports to anyone:
// no plain token transfer, no new owner or delegate, no close to another account.
const instructionRules: Record<
  string,
  (instruction: InspectedInstruction, wallet: string) => boolean
> = {
  // Only the proof context accounts, funded by the wallet and owned by the proof
  // program. The System program itself checks the address against the seed.
  [programs.system]: ({ data, accounts }, wallet) =>
    data.length >= 4 + 32 + 32 &&
    getU32Decoder().decode(data.slice(0, 4)) === CREATE_ACCOUNT_WITH_SEED &&
    addressAt(data, 4) === wallet &&
    addressAt(data, data.length - 32) === programs.zkProof &&
    accounts[0]?.address === wallet,
  [programs.computeBudget]: ({ data }) => computeBudgetTags.includes(data[0]),
  // Verifying a proof moves nothing; closing a context returns its rent to the wallet.
  [programs.zkProof]: (instruction, wallet) =>
    instruction.data[0] === CLOSE_CONTEXT_STATE
      ? accountAt(instruction, 1) === wallet &&
        accountAt(instruction, 2) === wallet
      : instruction.data[0] >= 1 && instruction.data[0] <= LAST_VERIFY_PROOF,
  // The confidential transfer extension's own steps, and growing an account the wallet
  // pays for. Never a plain transfer, approve, set authority or close.
  [programs.token2022]: (instruction, wallet) =>
    instruction.data[0] === CONFIDENTIAL_TRANSFER_EXTENSION
      ? (Object.values(confidential) as number[]).includes(instruction.data[1])
      : instruction.data[0] === REALLOCATE &&
        accountAt(instruction, 1) === wallet,
  // The wallet's own associated account, which it pays for.
  [programs.associatedToken]: (instruction, wallet) =>
    instruction.data[0] === CREATE_IDEMPOTENT &&
    accountAt(instruction, 0) === wallet &&
    accountAt(instruction, 2) === wallet,
  // Cadence's token-wrap deployment: wrap and unwrap are its only instructions that
  // move tokens, and both act on accounts the wallet signs for.
  [programs.tokenWrap]: () => true,
}

// Only the programs with a rule: one without is refused, never looked up.
const allowedPrograms: ReadonlySet<string> = new Set(
  Object.keys(instructionRules),
)

// The check every prepared transaction passes before it is signed: the wallet is the
// fee payer and the only signer, and every instruction is one of the known programs
// doing one of the things above. It does not know where a flow's money should go:
// `checkConfidentialTransfer` adds that for a payment.
export function checkSignedOnlyBy(tx: InspectedTransaction, wallet: string) {
  if (tx.feePayer !== wallet || tx.signers.some((key) => key !== wallet)) {
    refuse("signer")
  }
  for (const instruction of tx.instructions) {
    if (!allowedPrograms.has(instruction.program)) refuse("program")
    if (!instructionRules[instruction.program](instruction, wallet)) {
      refuse("instruction")
    }
  }
}

export type TransferAllowlist = {
  // The company's wallet: it signs and pays the fee.
  wallet: string
  // The company's token account the payment comes from.
  source: string
  // The recipient's token account, as the admin approved it.
  destination: string
}

const transferPrograms: ReadonlySet<string> = new Set([
  programs.system,
  programs.zkProof,
  programs.token2022,
])

// One confidential payment, shaped as the service builds it (`confidential.rs`): proof
// contexts created and verified, exactly one Token-2022 confidential transfer from the
// company's account to the approved one, and the contexts closed back to the wallet.
// The only accounts it may write are the wallet, the two token accounts and the
// contexts it creates.
export function checkConfidentialTransfer(
  tx: InspectedTransaction,
  { wallet, source, destination }: TransferAllowlist,
) {
  checkSignedOnlyBy(tx, wallet)
  if (tx.version !== 1) refuse("version")
  if (tx.instructions.some((ix) => !transferPrograms.has(ix.program))) {
    refuse("program")
  }
  const transfers = tx.instructions.filter(
    (ix) => ix.program === programs.token2022,
  )
  const [transfer] = transfers
  if (
    transfers.length !== 1 ||
    transfer.data[0] !== CONFIDENTIAL_TRANSFER_EXTENSION ||
    transfer.data[1] !== confidential.transfer ||
    transfer.accounts.at(-1)?.address !== wallet
  ) {
    return refuse("transfer")
  }
  // Source, mint, destination, the three proof contexts, then the authority.
  if (accountAt(transfer, 0) !== source) refuse("source")
  if (accountAt(transfer, 2) !== destination) refuse("destination")
  const contexts = tx.instructions
    .filter((ix) => ix.program === programs.system)
    .map((ix) => accountAt(ix, 1))
  const allowed = new Set([wallet, source, destination, ...contexts])
  if (tx.writable.some((account) => !allowed.has(account))) refuse("writable")
}
