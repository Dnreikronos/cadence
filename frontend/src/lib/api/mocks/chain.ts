import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createAddressWithSeed,
  createTransactionMessage,
  getAddressEncoder,
  getTransactionEncoder,
  getU32Encoder,
  getU64Encoder,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  type Instruction,
} from "@solana/kit"
import {
  CLOSE_CONTEXT_STATE,
  CONFIDENTIAL_TRANSFER_EXTENSION,
  CREATE_ACCOUNT_WITH_SEED,
  confidential,
  programs,
} from "@/lib/solana/programs"
import { base58FromBytes } from "../base58"
import { db } from "./db"

// Stand-ins for the Token-2022 accounts a run pays from and to, until the service says
// where the browser gets them (API_CONTRACT Q36). The same owner always gets the same
// account, and different owners different ones; nothing checks them on a chain.
export function mockTokenAccount(owner: string) {
  return base58FromBytes(stretch(`token-account:${owner}`))
}

// FNV-1a over the whole text, then stretched to 32 bytes.
function stretch(text: string) {
  let state = 2166136261
  for (const byte of new TextEncoder().encode(text)) {
    state = Math.imul(state ^ byte, 16777619) >>> 0
  }
  return Uint8Array.from({ length: 32 }, (_, i) => {
    state = Math.imul(state ^ i, 16777619) >>> 0
    return (state >>> 24) & 0xff
  })
}

// A block every 400 ms, from the clock, so a page's fake clock moves it too. The service
// and the screens read the same height.
export const mockBlockHeight = (now = Date.now()) => Math.floor(now / 400)

// About a minute: how long a blockhash read now stays valid.
export const MOCK_BLOCKHASH_LIFETIME = 150

export const mockBlockhash = (n: number) =>
  base58FromBytes(stretch(`blockhash:${n}`))

// What the mock network knows of a signature: set when the mock service sees the
// transaction finalized or failed, read by the finality check after a confirm
// (`lib/solana/finality.ts`). The scenario "chain-unconfirmed" keeps it empty.
export const mockChain = {
  record: (signature: string, outcome: "finalized" | "failed") => {
    db.chain.set(signature, outcome)
  },
  read: (signature: string) => db.chain.get(signature) ?? null,
}

// ---- Transactions -------------------------------------------------------------

// Real wire bytes, so the pre-sign check (`lib/solana/inspect.ts`) reads the mock's
// transactions as it would the service's. The proofs are filler: nothing verifies them.

type MockInstruction = {
  program: string
  // An account is [address, writable, signer].
  accounts: readonly (readonly [string, boolean, boolean])[]
  data: Uint8Array
}

const role = (writable: boolean, signer: boolean) =>
  signer
    ? writable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER
    : writable
      ? AccountRole.WRITABLE
      : AccountRole.READONLY

const toInstruction = ({ program, accounts, data }: MockInstruction) =>
  ({
    programAddress: address(program),
    accounts: accounts.map(([account, writable, signer]) => ({
      address: address(account),
      role: role(writable, signer),
    })),
    data,
  }) satisfies Instruction

// An unsigned transaction paid and signed by `wallet`, as wire bytes. Version 1 carries
// the service's budget in its config, version 0 in compute budget instructions.
export function mockTransaction({
  version,
  wallet,
  n,
  instructions,
}: {
  version: 0 | 1
  wallet: string
  n: number
  instructions: readonly MockInstruction[]
}) {
  const budget = (tag: number, value: number) => ({
    program: programs.computeBudget,
    accounts: [],
    data: Uint8Array.from([tag, ...getU32Encoder().encode(value)]),
  })
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(address(wallet), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(mockBlockhash(n)),
          lastValidBlockHeight: BigInt(1000 + n),
        },
        m,
      ),
    (m) =>
      version === 1
        ? setTransactionMessageLoadedAccountsDataSizeLimit(
            64 * 1024 * 1024,
            setTransactionMessageComputeUnitLimit(400_000, m),
          )
        : m,
    (m) =>
      appendTransactionMessageInstructions(
        [
          ...(version === 0
            ? [budget(2, 400_000), budget(4, 64 * 1024 * 1024)]
            : []),
          ...instructions,
        ].map(toInstruction),
        m,
      ),
  )
  return Uint8Array.from(
    getTransactionEncoder().encode(compileTransaction(message)),
  )
}

const filler = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, i) => (seed * 7 + i) % 256)

const encodeAddress = (value: string) =>
  getAddressEncoder().encode(address(value))

// System `CreateAccountWithSeed`: the wallet funds a proof context account owned by
// the ZK proof program.
function createContext(wallet: string, context: string, seed: string) {
  const text = new TextEncoder().encode(seed)
  return {
    program: programs.system,
    accounts: [
      [wallet, true, true],
      [context, true, false],
    ] as const,
    data: Uint8Array.from([
      ...getU32Encoder().encode(CREATE_ACCOUNT_WITH_SEED),
      ...encodeAddress(wallet),
      ...getU64Encoder().encode(text.length),
      ...text,
      ...getU64Encoder().encode(2_000_000),
      ...getU64Encoder().encode(256),
      ...encodeAddress(programs.zkProof),
    ]),
  }
}

// A confidential transfer shaped like the service's (`confidential.rs`): three proof
// contexts created and verified, the Token-2022 transfer, and the contexts closed back
// to the wallet.
export async function mockTransferTransaction({
  wallet,
  source,
  destination,
  mint,
  n,
}: {
  wallet: string
  source: string
  destination: string
  mint: string
  n: number
}) {
  const verifyTags = [3, 12, 7]
  const contexts = await Promise.all(
    verifyTags.map(async (_, i) => {
      const seed = base58FromBytes(stretch(`context:${n}:${i}`))
        .slice(0, 32)
        .padEnd(32, "1")
      const context = await createAddressWithSeed({
        baseAddress: address(wallet),
        programAddress: address(programs.zkProof),
        seed,
      })
      return { context: String(context), seed }
    }),
  )
  return mockTransaction({
    version: 1,
    wallet,
    n,
    instructions: [
      ...contexts.flatMap(({ context, seed }, i) => [
        createContext(wallet, context, seed),
        {
          program: programs.zkProof,
          accounts: [
            [context, true, false],
            [wallet, false, true],
          ] as const,
          data: Uint8Array.from([verifyTags[i], ...filler(64, n + i)]),
        },
      ]),
      {
        program: programs.token2022,
        accounts: [
          [source, true, false],
          [mint, false, false],
          [destination, true, false],
          ...contexts.map(({ context }) => [context, false, false] as const),
          [wallet, false, true],
        ],
        data: Uint8Array.from([
          CONFIDENTIAL_TRANSFER_EXTENSION,
          confidential.transfer,
          ...filler(96, n),
        ]),
      },
      ...contexts.map(({ context }) => ({
        program: programs.zkProof,
        accounts: [
          [context, true, false],
          [wallet, true, true],
          [wallet, false, true],
        ] as const,
        data: Uint8Array.of(CLOSE_CONTEXT_STATE),
      })),
    ],
  })
}

// One Token-2022 confidential instruction on the wallet's own account, for the routes
// that move nothing to anyone else (configure, apply pending), plus what wrap and
// unwrap add around it. Shaped enough for the pre-sign check, not like the service's.
export function mockAccountTransaction({
  kind,
  wallet,
  n,
}: {
  kind: "wrap" | "unwrap" | "configure" | "apply-pending"
  wallet: string
  n: number
}) {
  const account = mockTokenAccount(wallet)
  const sub = {
    wrap: confidential.deposit,
    unwrap: confidential.withdraw,
    configure: confidential.configureAccount,
    "apply-pending": confidential.applyPendingBalance,
  }[kind]
  const own = {
    program: programs.token2022,
    accounts: [
      [account, true, false],
      [wallet, false, true],
    ] as const,
    data: Uint8Array.from([CONFIDENTIAL_TRANSFER_EXTENSION, sub]),
  }
  const wrapProgram = {
    program: programs.tokenWrap,
    accounts: [
      [account, true, false],
      [wallet, false, true],
    ] as const,
    data: Uint8Array.of(kind === "wrap" ? 1 : 2),
  }
  return mockTransaction({
    version: kind === "wrap" ? 0 : 1,
    wallet,
    n,
    instructions:
      kind === "wrap"
        ? [wrapProgram, own]
        : kind === "unwrap"
          ? [own, wrapProgram]
          : [own],
  })
}
