// The programs a transaction the proof service prepares may call, and the instruction
// tags and layouts the pre-sign check (`inspect.ts`) reads. The addresses are the same on
// every cluster except token-wrap, which is Cadence's own deployment (services/proof
// `token_wrap.rs`, ops/token-wrap): the canonical one is not on any cluster.
export const programs = {
  system: "11111111111111111111111111111111",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  // The ZK ElGamal proof program: it verifies the confidential transfer's proofs.
  zkProof: "ZkE1Gama1Proof11111111111111111111111111111",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  tokenWrap: "8vc29A8ztm3pE5qJ43paHTMGtBTnf5jXvyqcPQcTjJZc",
} as const

// Read by Token-2022 when a proof sits in a later instruction of the same transaction.
export const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111"

// System: `CreateAccountWithSeed`, a u32 tag. The only System call the service makes,
// for the proof context accounts.
export const CREATE_ACCOUNT_WITH_SEED = 3

// Token-2022: the confidential transfer extension's tag, then its own sub-tag. Each
// instruction's data has one fixed length (spl-token-2022 `confidential_transfer`
// instruction data, with the proofs elsewhere).
export const CONFIDENTIAL_TRANSFER_EXTENSION = 27
export const REALLOCATE = 29
// `ExtensionType::ConfidentialTransferAccount`, the one extension a reallocate adds.
export const CONFIDENTIAL_TRANSFER_ACCOUNT_EXTENSION = 5
export const confidential = {
  configureAccount: 2,
  deposit: 5,
  withdraw: 6,
  transfer: 7,
  applyPendingBalance: 8,
} as const
export const confidentialDataLength: Record<number, number> = {
  // Decryptable zero balance (36), max pending credits (u64), proof offset (i8).
  [confidential.configureAccount]: 2 + 36 + 8 + 1,
  // Amount (u64), decimals (u8).
  [confidential.deposit]: 2 + 8 + 1,
  // Amount, decimals, new decryptable balance, two proof offsets.
  [confidential.withdraw]: 2 + 8 + 1 + 36 + 1 + 1,
  // New decryptable balance, the auditor's two ciphertexts, three proof offsets.
  [confidential.transfer]: 2 + 36 + 64 + 64 + 3,
  // Expected credit counter (u64), new decryptable balance.
  [confidential.applyPendingBalance]: 2 + 8 + 36,
}

// ZK ElGamal proof: 0 closes a context account and returns its rent; the others verify
// a proof and move nothing. Only the proofs the service's flows use.
export const CLOSE_CONTEXT_STATE = 0
export const verifyProof = {
  ciphertextCommitmentEquality: 3,
  pubkeyValidity: 4,
  batchedRangeProofU64: 6,
  batchedRangeProofU128: 7,
  batchedGroupedCiphertext3HandlesValidity: 12,
} as const

// The size of each proof context account a payment creates (`ProofContextState<T>`:
// a 32-byte authority, a 1-byte proof type, then the context), by the proof verified
// into it (`confidential.rs` CONTEXT_SIZES).
export const proofContextSpace: Record<number, number> = {
  [verifyProof.ciphertextCommitmentEquality]: 33 + 128,
  [verifyProof.batchedGroupedCiphertext3HandlesValidity]: 33 + 352,
  [verifyProof.batchedRangeProofU128]: 33 + 264,
}

// The most a proof context may be funded with: the rent-exempt minimum under the default
// rent (3,480 lamports per byte-year, two years, plus 128 bytes of account overhead).
// The service asks the cluster for the minimum (`minimum_balance`), which is never
// above this; devnet's is lower. The wallet gets it back when the context is closed.
export const rentExemptMaximum = (space: number) => (128 + space) * 3_480 * 2

// Token-wrap (upstream `program@v1.0.0` layout): `Wrap` and `Unwrap`, each a tag and a
// u64 amount. `CreateMint` and the rest are never asked of a wallet.
export const tokenWrap = { wrap: 1, unwrap: 2 } as const

// Compute budget instructions (version 0) and the same fields of a version 1 message's
// config. The service sets a 400,000 unit limit and a 64 MiB loaded-data limit, and no
// price (`v0.rs`, `v1.rs`). The bounds leave room for that and keep any fee small.
export const computeBudget = {
  setComputeUnitLimit: 2,
  setComputeUnitPrice: 3,
  setLoadedAccountsDataSizeLimit: 4,
} as const
// The runtime's own ceiling per transaction.
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000
// Micro-lamports per unit: at the unit ceiling, at most 0.00014 SOL of priority fee.
export const MAX_COMPUTE_UNIT_PRICE = 100_000
// Version 1 states the priority fee in lamports: the same 0.00014 SOL.
export const MAX_PRIORITY_FEE_LAMPORTS =
  (MAX_COMPUTE_UNIT_LIMIT * MAX_COMPUTE_UNIT_PRICE) / 1_000_000
// The runtime's own ceiling, which the service asks for.
export const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024

// Associated token account: `CreateIdempotent`.
export const CREATE_IDEMPOTENT = 1
