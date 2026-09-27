# Cadence

Payroll for companies outside Brazil that pay people inside Brazil. The employer
adds their workers once, funds a run in USDC, and approves it. Each worker
receives USDC in their wallet within seconds, with a payroll record both sides
can hand to an accountant.

Amounts are encrypted on-chain. A worker's pay is visible to the worker, to the
employer, and to a designated auditor holding the disclosure key — and to nobody
else.

Workers convert to reais on the exchange where they are already a customer.
Cadence never holds reais, never converts currency, and never initiates a Pix
payment. That boundary is deliberate and load-bearing; read the ADR before
changing anything about the money flow.

Built for the [Colosseum Crypto World's Fair](https://colosseum.com/worldsfair)
hackathon, Solana track. Submissions close 2026-10-12.

## Why this is buildable now

Confidential balances on Solana became practical two weeks before this repo was
created. The ZK ElGamal Proof program was disabled 2025-06-11 after a
Fiat-Shamir transcript bug and re-enabled at epoch 982 in June 2026, with
Token-2022 redeployed carrying the confidential instructions on 2026-06-17.
Transaction v1 raised the transaction size cap from 1,232 to 4,096 bytes at
mainnet epoch 1035 on 2026-09-15 — the Foundation's reference confidential
transfer is 2,897 bytes, so it now fits in a single atomic transaction. Adoption
is close to zero.

## Start here

- [PRD](docs/prd-confidential-payroll-rail.md) — what should become true for the
  user, with per-requirement done-when conditions.
- [ADR](docs/decisions/2026-09-27-confidential-payroll-rail-architecture.md) —
  the three licensing walls, why v1 stops short of all of them, and why the
  confidential mint is a forked `token-wrap`.
- [Docs router](docs/README.md)

## Shape

A Rust service owns the forked `token-wrap`, the mint, proof generation and
auditor operations. It builds unsigned transactions; the employer's wallet signs
in the browser, so no Solana signing key reaches our infrastructure. State lives
in Supabase Postgres, managed entirely through migrations, with row-level
security as the authorization boundary. No plaintext amount is ever stored
off-chain.

## Status

Pre-implementation. No application code yet. Open questions are tracked in the
PRD — Q2 (whether orchestrating transfers is a VASP activity) and Q3 (who holds
the auditor key) gate the build.
