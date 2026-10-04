# Docs router

Proposed layout, following the convention used in `supa-skeleton`. Nothing here
is established yet — if this doc set moves into an existing repo, match that
repo's paths instead of these.

| Genre                | Path                                                    |
| -------------------- | ------------------------------------------------------- |
| PRD                  | `docs/prd-<slug>.md`                                    |
| ADR / decision log   | `docs/decisions/YYYY-MM-DD-<slug>.md`                   |
| Implementation plan  | `docs/plans/YYYY-MM-DD-NNN-plan-<slug>.md`              |
| Design deep-dive     | `docs/dev/<UPPER_SNAKE_CASE>.md`                        |
| Spike / POC report   | `docs/dev/spikes/YYYY-MM-DD-<slug>.md`                  |
| Past-problem writeup | `docs/solutions/<category>/<claim-as-sentence-slug>.md` |

## Product

- [Cadence — confidential USDC payments](prd-confidential-usdc-payments.md) — companies pay their team and suppliers in dollars without showing the amounts to the world. Status: draft.
- ~~[Payroll rail for Brazil](prd-confidential-payroll-rail.md)~~ — superseded 2026-09-27. Kept for the Brazilian licensing analysis, which applies again if a fiat corridor is ever added.

## Decisions

- [Cadence pays people who already hold dollars, so no part of the product is a regulated activity](decisions/2026-09-27-confidential-payroll-rail-architecture.md) — 2026-09-27, decision log. Why the Brazil corridor was abandoned, why proof generation moved to the browser, and what is still open on the wrapped mint. Status: accepted.

## Implementation plans

- [Proof service scaffold](plans/2026-09-28-048-plan-proof-service.md) — 2026-09-28, #48. The standalone `services/proof` Rust crate: HTTP server, validated configuration, one error mapping, a Solana RPC client, a container image and a workflow. It adds no proof endpoints, key storage or signing.

- [Decryption audit log](plans/2026-09-28-049-decryption-audit-log.md) — 2026-09-28, #49. The audit record written before any key access (actor, reason, target account, no amount). Implements ADR B19 and PRD R11.

- [Encrypted viewing keys](plans/2026-09-28-050-encrypted-viewing-keys.md) — 2026-09-28, #50. Deriving an ElGamal key from a wallet signature over the SDK's key-derivation message and storing it encrypted in Vault. Implements ADR B19.

- [Company wallets sign the USDC wrap transaction](plans/2026-09-29-052-plan-wrap.md) — 2026-09-29, #52. Implemented and tested locally; browser-wallet devnet acceptance remains unverified. [API contract](dev/WRAP_API.md).

- [Proof generation module](plans/2026-10-03-053-proof-generation.md) — 2026-10-03, #53. `solana::confidential`, a pure builder of one unsigned v1 confidential transfer, with no HTTP endpoint of its own.

- [Authenticated transfer API](plans/2026-10-03-054-transfer-api.md) — 2026-10-03, #54. Supabase login and wallet association; verified locally and on devnet through a browser-driven Turnkey test adapter. [API contract](dev/TRANSFER_API.md).

- [Finish the frontend, against mocks](plans/2026-10-04-frontend-completion.md) — 2026-10-04, #76 and #78 to #88. Complete except task Q (end-to-end tests, accessibility pass, docs; #126, open): every other screen is merged and runs on the mock service. The task table with PR numbers, what changed from the plan, the checklist before real signing, and the known gaps.

## Contracts

- [API contract for the web app](dev/API_CONTRACT.md) — #63. What the web app builds and mocks against: authentication, the prepare-sign-confirm pattern, errors that never carry an amount, and every route, marked implemented or proposed, plus the design review findings to resolve before building. Synced with the client and the mock on 2026-10-04: it now lists the mock's deviations from a real service and what the screens assume from the backend. Status: working draft, open questions 1 to 35 for the backend owner.

- [Wrap USDC](dev/WRAP_API.md) — #52. The implemented `POST /wrap` and `POST /wrap/confirm`, their configuration, errors and storage.

- [Transfer API](dev/TRANSFER_API.md) — #54. The implemented `POST /transfer` and `POST /transfer/confirm`, their configuration, authentication, errors and storage.

## Web app

- [Cadence web app](../frontend/README.md) — how to run it, the screens and the routes they use, the API client and its mock, the demo viewer, the wallet, queries, activation, the route guard and sign-in, and deploys.

## Spikes

- [One confidential transfer is 2,395 bytes on devnet, and `spl-token-client` cannot send it](dev/spikes/2026-09-27-confidential-transfer.md) — 2026-09-27. Verdict: go, conditional on superseding B18. R2 and R3 confirmed on chain; the client the ADR picks cannot build a v1 transaction.
- [A Supabase user can sign with a Turnkey wallet from the browser, with security decisions open](dev/spikes/2026-10-03-embedded-wallet.md) — 2026-10-03, #77. Verdict: go, conditional on an RS256 key on hosted Supabase, a real v1 transfer from a user session confirmed on devnet, the behaviour at session expiry, and the production-security decisions in its security review.
