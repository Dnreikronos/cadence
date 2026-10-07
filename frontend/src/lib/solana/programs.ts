// The programs a transaction the proof service prepares may call, and the instruction
// tags the pre-sign check (`inspect.ts`) reads. The addresses are the same on every
// cluster except token-wrap, which is Cadence's own deployment (services/proof
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

// System: `CreateAccountWithSeed`, a u32 tag. The only System call the service makes,
// for the proof context accounts.
export const CREATE_ACCOUNT_WITH_SEED = 3

// Token-2022: the confidential transfer extension's tag, then its own sub-tag.
export const CONFIDENTIAL_TRANSFER_EXTENSION = 27
export const REALLOCATE = 29
export const confidential = {
  configureAccount: 2,
  deposit: 5,
  withdraw: 6,
  transfer: 7,
  applyPendingBalance: 8,
} as const

// ZK ElGamal proof: 0 closes a context account and returns its rent; 1 to 12 verify a
// proof and move nothing.
export const CLOSE_CONTEXT_STATE = 0
export const LAST_VERIFY_PROOF = 12

// Compute budget: the unit limit, the unit price and the loaded-data limit. A v1
// message carries these in its config instead.
export const computeBudgetTags: readonly number[] = [2, 3, 4]

// Associated token account: `CreateIdempotent`.
export const CREATE_IDEMPOTENT = 1
