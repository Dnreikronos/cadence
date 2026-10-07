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
import { walletAccounts, type WalletAccounts } from "@/lib/solana/accounts"
import {
  CLOSE_CONTEXT_STATE,
  CONFIDENTIAL_TRANSFER_ACCOUNT_EXTENSION,
  CONFIDENTIAL_TRANSFER_EXTENSION,
  CREATE_ACCOUNT_WITH_SEED,
  CREATE_IDEMPOTENT,
  INSTRUCTIONS_SYSVAR,
  REALLOCATE,
  confidential,
  confidentialDataLength,
  programs,
  proofContextSpace,
  tokenWrap,
  verifyProof,
} from "@/lib/solana/programs"
import type { Finality } from "@/lib/solana/finality"
import { base58FromBytes } from "../base58"
import { db } from "./db"
import { scenarios } from "./scenario"

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
// transaction finalized or failed.
export function recordOnMockChain(
  signature: string,
  outcome: "finalized" | "failed",
) {
  db.chain.set(signature, outcome)
}

// The mock wallet's read of the network after a confirm, standing in for
// `fetchFinality`. Under "chain-unconfirmed" it never sees anything land.
export async function mockFinality(signature: string): Promise<Finality> {
  if (scenarios.has("chain-unconfirmed")) return "pending"
  return db.chain.get(signature) ?? "pending"
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

const u64 = (value: bigint | number) => getU64Encoder().encode(value)

// Devnet's rent per byte, lower than the default the pre-sign check bounds it by.
const contextRent = (space: number) => (128 + space) * 5_080

// System `CreateAccountWithSeed`: the wallet funds a proof context account owned by
// the ZK proof program, with its rent and at its size.
function createContext(
  wallet: string,
  context: string,
  seed: string,
  space: number,
) {
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
      ...u64(text.length),
      ...text,
      ...u64(contextRent(space)),
      ...u64(space),
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
  const verifyTags = [
    verifyProof.ciphertextCommitmentEquality,
    verifyProof.batchedGroupedCiphertext3HandlesValidity,
    verifyProof.batchedRangeProofU128,
  ]
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
        createContext(wallet, context, seed, proofContextSpace[verifyTags[i]]),
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
          ...filler(confidentialDataLength[confidential.transfer] - 2, n),
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

// ---- The wallet's own accounts: wrap, unwrap, configure, apply pending -----------

// `CreateIdempotent` of the wallet's associated account, paid by the wallet.
const createAccount = (
  wallet: string,
  account: string,
  mint: string,
  tokenProgram: string,
): MockInstruction => ({
  program: programs.associatedToken,
  accounts: [
    [wallet, true, true],
    [account, true, false],
    [wallet, false, false],
    [mint, false, false],
    [programs.system, false, false],
    [tokenProgram, false, false],
  ],
  data: Uint8Array.of(CREATE_IDEMPOTENT),
})

// A Token-2022 confidential transfer extension step: its sub-tag, then its fixed-length
// data, which starts with the public amount when it has one.
const confidentialStep = (
  sub: number,
  accounts: MockInstruction["accounts"],
  n: number,
  amount?: bigint,
): MockInstruction => {
  const head = amount === undefined ? [] : [...u64(amount)]
  return {
    program: programs.token2022,
    accounts,
    data: Uint8Array.from([
      CONFIDENTIAL_TRANSFER_EXTENSION,
      sub,
      ...head,
      ...filler(confidentialDataLength[sub] - 2 - head.length, n),
    ]),
  }
}

// A proof verified in the instruction itself: no context account, nothing written.
const verifyInline = (tag: number, n: number): MockInstruction => ({
  program: programs.zkProof,
  accounts: [],
  data: Uint8Array.from([tag, ...filler(64, n)]),
})

// Reallocate, configure and its pubkey validity proof: the confidential extension on
// the wallet's own account (`wrap.rs`, when it has none yet).
const configureSteps = (own: WalletAccounts, n: number): MockInstruction[] => [
  createAccount(
    own.wallet,
    own.confidential,
    own.wrappedMint,
    programs.token2022,
  ),
  {
    program: programs.token2022,
    accounts: [
      [own.confidential, true, false],
      [own.wallet, true, true],
      [programs.system, false, false],
      [own.wallet, false, true],
    ],
    data: Uint8Array.of(REALLOCATE, CONFIDENTIAL_TRANSFER_ACCOUNT_EXTENSION, 0),
  },
  confidentialStep(
    confidential.configureAccount,
    [
      [own.confidential, true, false],
      [own.wrappedMint, false, false],
      [INSTRUCTIONS_SYSVAR, false, false],
      [own.wallet, false, true],
    ],
    n,
  ),
  verifyInline(verifyProof.pubkeyValidity, n),
]

// A transaction on the wallet's own accounts, shaped like the service's: the wrap
// (`wrap.rs`, version 0) and unwrap (`unwrap.rs`). Configure and apply pending have no
// service builder yet; they are the extension's own steps on the same account.
// `setup` is a wrap that also configures the account first; `amount` is the wrap's or
// the unwrap's, in base units.
export async function mockAccountTransaction({
  kind,
  wallet,
  n,
  amount = BigInt(1),
  setup = false,
}: {
  kind: "wrap" | "unwrap" | "configure" | "apply-pending"
  wallet: string
  n: number
  amount?: bigint
  setup?: boolean
}) {
  const own = await walletAccounts(wallet)
  const tokenWrapStep = (
    tag: number,
    accounts: MockInstruction["accounts"],
  ) => ({
    program: programs.tokenWrap,
    accounts,
    data: Uint8Array.from([tag, ...u64(amount)]),
  })
  const instructions: Record<typeof kind, MockInstruction[]> = {
    wrap: [
      ...(setup ? configureSteps(own, n) : []),
      tokenWrapStep(tokenWrap.wrap, [
        [own.confidential, true, false],
        [own.wrappedMint, true, false],
        [own.wrapAuthority, false, false],
        [programs.token, false, false],
        [programs.token2022, false, false],
        [own.usdc, true, false],
        [own.usdcMint, false, false],
        [own.escrow, true, false],
        [wallet, false, true],
      ]),
      confidentialStep(
        confidential.deposit,
        [
          [own.confidential, true, false],
          [own.wrappedMint, false, false],
          [wallet, false, true],
        ],
        n,
        amount,
      ),
    ],
    unwrap: [
      createAccount(wallet, own.usdc, own.usdcMint, programs.token),
      confidentialStep(
        confidential.withdraw,
        [
          [own.confidential, true, false],
          [own.wrappedMint, false, false],
          [INSTRUCTIONS_SYSVAR, false, false],
          [wallet, false, true],
        ],
        n,
        amount,
      ),
      verifyInline(verifyProof.ciphertextCommitmentEquality, n),
      verifyInline(verifyProof.batchedRangeProofU64, n + 1),
      tokenWrapStep(tokenWrap.unwrap, [
        [own.escrow, true, false],
        [own.usdc, true, false],
        [own.wrapAuthority, false, false],
        [own.usdcMint, false, false],
        [programs.token2022, false, false],
        [programs.token, false, false],
        [own.confidential, true, false],
        [own.wrappedMint, true, false],
        [wallet, false, true],
      ]),
    ],
    configure: configureSteps(own, n),
    "apply-pending": [
      confidentialStep(
        confidential.applyPendingBalance,
        [
          [own.confidential, true, false],
          [wallet, false, true],
        ],
        n,
      ),
    ],
  }
  return mockTransaction({
    version: kind === "wrap" ? 0 : 1,
    wallet,
    n,
    instructions: instructions[kind],
  })
}
