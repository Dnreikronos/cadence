# Cadence

Crypto companies pay their team, freelancers and suppliers in USDC — and every
one of those payments is public. Anyone can see what each person earns, who the
suppliers are, and how much runway is left.

Cadence is a dashboard where the same payments happen with the amount hidden.
The recipient sees it. The accountant sees it. Everyone else sees only that a
payment occurred.

It is confidentiality, not anonymity: amounts and balances are encrypted, wallet
addresses stay public. Like a bank — the bank and the accountant know
everything, the neighbour doesn't.

Cadence never holds anyone's money, never holds a signing key, and never
converts currency. It does generate the proofs server-side, so it holds viewing
keys and can read amounts — it cannot move funds. Those boundaries are
load-bearing; read the ADR before changing anything about the money flow.

Built for the [Colosseum Crypto World's Fair](https://colosseum.com/worldsfair)
hackathon, Solana track. Submissions close 2026-10-12.

## Why this is buildable now

Solana's amount-hiding feature was switched off between June 2025 and June 2026
after a bug in the ZK ElGamal Proof program. It returned at epoch 982, with
Token-2022 redeployed carrying the confidential instructions on 2026-06-17. Then
transaction v1 raised the transaction size cap from 1,232 to 4,096 bytes at
mainnet epoch 1035 on 2026-09-15, and a hidden payment finally fit in a single
transaction — the reference implementation is 2,897 bytes. The piece has been
ready for twelve days and adoption is close to zero.

## Start here

- [PRD](docs/prd-confidential-usdc-payments.md) — the problem, the product, and
  what has to be true for it to work.
- [ADR](docs/decisions/2026-09-27-confidential-payroll-rail-architecture.md) —
  decision log. Why the Brazil corridor was abandoned, why proof generation runs
  in the browser, and what is still open.
- [Docs router](docs/README.md)

## Shape

Payments are wrapped USDC on Solana using Token-2022 confidential balances. A
Rust service generates the proofs and assembles transactions; the user's own
wallet signs them in the browser, so no signing key reaches our infrastructure.
State lives in Supabase Postgres, managed entirely through migrations, with
row-level security as the authorization boundary. No plaintext amount is stored
off-chain, and viewing keys are encrypted at rest with every decryption logged.

## Status

Pre-implementation. No application code yet. The wrapped USDC mint is live on
devnet with no auditor key, and auditors get access through app-level grants
(ADR O1, see [ops/mint](ops/mint/README.md)). Open items are tracked in the ADR —
O3 (whether a Squads multisig can originate a confidential transfer) gates a
paid tier.
