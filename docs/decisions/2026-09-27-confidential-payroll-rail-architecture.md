# Cadence pays people who already hold dollars, so no part of the product is a regulated activity

Status: accepted · Shape: decision log
Date: 2026-09-27 · Decided by: João · Consulted: three teammates on the client side — TODO(João): names

Team shape, which drives several decisions below: João on Solana and the wrapped mint, three on the frontend. Proof generation and signing both moved to the browser, so the client team owns more of the transfer path than the original split assumed.

Product definition: [PRD — confidential USDC payments](../prd-confidential-usdc-payments.md)

## Context

The first version of this product paid Brazilian workers and ended in reais. That ran into three separate licensing walls, only one of which was about crypto. Pushing a Pix payment requires participation in the Banco Central's SPI, open to banks and authorized payment institutions. Converting dollar-denominated value into reais is a câmbio operation, restricted to institutions authorized in the FX market. And Resolução BCB 561/2026, effective 2026-10-01, rewrites art. 50 of Res. BCB 277/2022 so that settlement between a Brazilian eFX provider and its foreign counterparty must run through câmbio or a non-resident BRL account, "sendo vedado o uso de ativos virtuais." Authorization under Res. BCB 519/520/521 needs roughly R$10.8M–R$37.2M in capital with filings due 2026-10-30.

Cutting the fiat leg left a product whose recipients still had to sell USDC on an exchange to get money they could spend. The friction was not removed, only pushed outside the product boundary — which is legitimate only if the recipient does not mind holding dollars.

That is the pivot. Serve people for whom holding USDC is already normal, and the last mile disappears rather than being deferred: no exchange, no Pix, no câmbio, no Res. 561, no VASP question. The Brazilian analysis stays in this document because it becomes live again the moment a fiat corridor is added.

Meanwhile the technical window is narrow and recent. The ZK ElGamal Proof program was disabled 2025-06-11 after a Fiat-Shamir transcript bug, re-enabled at epoch 982 in June 2026, with Token-2022 redeployed carrying the confidential instructions on 2026-06-17. Transaction v1 (SIMD-0385, raising the size cap from 1,232 to 4,096 bytes per SIMD-0296) activated at mainnet epoch 1035 on 2026-09-15. The Foundation's reference confidential transfer is 2,897 bytes, so it now fits one atomic transaction. Adoption is close to zero.

## Area A — product and regulatory boundary

| # | Decision | Why |
|---|---|---|
| A1 | Delivery is USDC to the recipient's wallet, and the product ends there | Everything past that line is someone else's regulated activity |
| A2 | Companies fund in USDC. No fiat on-ramp | Keeps the inbound leg out of scope and avoids money-transmission exposure |
| A3 | We integrate no exchange. Documenting or linking is fine | An integration makes us a party to a conversion; a link does not |
| ~~A4~~ | ~~Target users are Brazil-resident workers paid by foreign companies~~ | Superseded by A6 |
| ~~A5~~ | ~~Partner acquisition runs in parallel, never on the critical path~~ | Superseded by A7 — with no fiat leg there is nothing for a partner to do |
| A6 | Target users are crypto companies, projects and DAOs already paying team, freelancers and suppliers in USDC | Their recipients hold dollars by preference, so there is no last mile to be friction. It also moves the market from one corridor to anywhere USDC is paid |
| A7 | No licensed partner is required for any part of v1 | The three walls in Context all sit past A1. Removing the dependency removes the largest risk the earlier design carried |
| A8 | Revenue is a software subscription. Never a spread on the amount transferred, never yield on held balances | A flat software fee is unambiguously software. Charging on value moved, or earning on float, changes what kind of business this is and reopens everything A1 closed |

## Area B — technical

| # | Decision | Why |
|---|---|---|
| B1 | Wrapped USDC via `token-wrap`, deployed by Cadence because no canonical deployment exists on any cluster — see [ops/token-wrap](../../ops/token-wrap/README.md). The mint carries no auditor key; auditors get access through app-level grants — see O1 | Stock `token-wrap` adds `ConfidentialTransferMint` to every wrapped mint with authority `None` and **auditor `None`**, immutably. Verified on chain 2026-09-28 against the devnet mint in [ops/mint](../../ops/mint/README.md). That is a decision rather than a default, and B16 changed what it costs |
| B2 | One atomic confidential transfer using transaction v1 | The 2,897-byte reference transaction fits the 4,096-byte cap |
| B3 | Balance display reads the AES `decryptable_available_balance` | Decrypting the ElGamal balance is a discrete-log solve, roughly a second on mobile. AES is constant time |
| B4 | Develop against devnet or a mainnet-forking validator such as Surfpool | A stock `solana-test-validator` does not enable `ZkE1Gama1Proof11111111111111111111111111111` |
| B5 | No custom on-chain program in v1 | Token-2022 instructions plus an orchestrator cover the flow |
| B6 | Embedded wallet provider chosen on custody model first | B9 and B16 narrow the exposure but do not close it — the provider still handles key material for users who arrive without a wallet |
| B7 | All RPC clients pin `maxSupportedTransactionVersion: 1` | One v1 transaction in a block breaks `getBlock` for that whole block on clients that have not declared it |
| ~~B8~~ | ~~Use `spl-token-client` (Rust) for the confidential helpers~~ | Superseded by B15 |
| B9 | Transactions are signed in the browser by the user's own wallet | No Solana signing key reaches our infrastructure. Survives B17 deliberately — the server can read amounts but can never move funds. Two separate claims; keep the one that still holds |
| ~~B10~~ | ~~Proof generation runs server-side in Rust~~ | Superseded by B16, reinstated by B17 |
| B11 | State lives in Supabase Postgres. Schema and RLS policies are migrations in the repo, applied by CLI | No dashboard click-ops; the schema stays reviewable and reproducible, and `supabase start` gives each frontend dev a real database |
| B12 | Postgres never stores a plaintext amount | Encrypting on-chain and mirroring into a column would make the privacy claim theater |
| B13 | RLS policies are the authorization boundary, not a hardening pass | The client reads Postgres directly, so there is no API tier to enforce anything. Every table ships with policies and a test proving cross-tenant reads fail |
| ~~B15~~ | ~~Use `@solana-program/token-2022` and `getConfidentialTransferInstructionPlan` in the browser~~ | Superseded by B18 |
| ~~B16~~ | ~~Proof generation runs in the browser~~ | Superseded by B17 |
| B17 | **Proof generation runs server-side in a Rust service, which therefore holds customers' ElGamal secrets** | Browser crypto is re-delivered on every page load, so a compromised CDN, an XSS or one malicious transitive dependency can exfiltrate the secret. A server is one audited runtime with memory-safe handling and secrets that can be zeroed. Accepted cost: Cadence can decrypt customer amounts, and the product claim changes from "we cannot see" to "we do not expose" — see Consequences |
| B18 | Use `spl-token-client` (Rust) for the confidential helpers, with a pinned local patch exposing unsigned transfer instructions and making its legacy RPC client optional. The service assembles transaction v1; the browser signs it. Do not hand-assemble proofs | Confirmed with João 2026-09-28 for #48. The stock 0.19.1 client cannot package our transfer or coexist with the required v1 dependency graph unchanged. The [proof service](../../services/proof/README.md) preserves its proof and balance helpers and documents the patch maintenance cost. A 2,395-byte transfer through the patched helper confirmed on devnet |
| B19 | ElGamal secrets are encrypted at rest with Supabase Vault, decryption is access-controlled, and every service read is logged with actor and reason | Amended for #50 on 2026-09-28: use the existing Supabase stack instead of provisioning a separate cloud KMS. A dedicated database role can only use audited key accessors; Supabase administrators and the broad service_role remain trusted. See the [storage contract](../plans/2026-09-28-050-encrypted-viewing-keys.md) |

## Alternatives considered

### Who the customer is

**Brazilian workers paid by foreign companies — superseded.** Better founder-market fit and a story that travels with these judges, and it is where the project started. It lost because the recipient still has to reach reais and every route there is licensed. Cutting the fiat leg left them selling on an exchange by hand, which is what they already do — so the product improved the payer's life and not the recipient's. A6 fixes that by choosing recipients who want dollars.

**Become the licensed entity — rejected.** R$10.8M–R$37.2M in capital and a filing by 2026-10-30.

**Settle cross-border without a licence — rejected, concretely.** From 2026-10-30 BCB-supervised institutions may not facilitate virtual-asset operations with unauthorized VASP counterparties, so any Brazilian PSP would be obliged to drop us. Incorporating offshore does not help; the framework attaches to who the users are.

### Where proofs are generated

This reversed twice in one day. The record of why matters more than the outcome.

**Browser-side — considered and rejected (B16, superseded by B17).** With proofs generated client-side, Cadence genuinely cannot read customer amounts, which would make "nobody but the payer, the recipient and the auditor sees this" literally true rather than a promise. It also distributes risk: compromising one browser exposes one user, while compromising the service exposes everyone.

It lost on delivery integrity. Browser code is re-shipped on every page load, so a compromised CDN, an XSS, or a single malicious transitive dependency can exfiltrate the ElGamal secret — and secrets in JS memory cannot be reliably zeroed. A server is one runtime you audit, deploy and control. Mitigations exist (strict CSP, subresource integrity, a vendored and pinned dependency tree, reproducible builds with published hashes) but they harden a weaker foundation rather than replacing it.

**Server-side in Rust — chosen (B17).** Better per-user cryptographic hygiene, a controlled runtime, and the transfer path stays in the language the team knows best for this API, which matters with fifteen days.

The costs are real and named: Cadence becomes able to decrypt every customer's amounts, the service becomes the single highest-value target in the system, and the marketing claim has to weaken accordingly. B19 exists because the first two are operational obligations, not footnotes.

**A custom circuit for proof-of-income — deferred, not rejected.** Proving "I earned at least X over six months" without revealing amounts needs a circuit over summed ciphertexts. Out of reach in this window. The achievable version is proving a decryption is correct against the on-chain ciphertext.

## Consequences

**Privacy is bounded by the wrap.** Deposits and withdrawals are public; only what happens between them is hidden. A recipient who withdraws their exact salary on payday defeats it entirely, which is why the warning in R6b is a requirement rather than a nicety.

**Wallets cannot display hidden balances.** Recipients read their real balance in our dashboard, and Phantom shows it only after a withdrawal. Non-supporting wallets degrade gracefully rather than breaking, but this is a standing product weakness until wallet vendors move.

**We lose the Brazil narrative.** Founder-market fit was a genuine edge with these judges, and A6 trades it for a larger market and no regulatory overhang. Superteam stays a distribution channel, not a moat.

**Cadence can read every customer's amounts**, as a direct result of B17. The product therefore cannot claim "nobody including us can see this." The honest claim is that the public cannot see it and Cadence does not expose it — the same posture as any payment processor, and weaker than the one B16 would have allowed. Every piece of copy has to match that, including the competitor comparison against custodians.

**The proof service is the highest-value target in the system.** One compromise exposes every company's payroll, where a browser compromise would have exposed one person's. B19 is the mitigation and it is not optional.

**Circle can freeze wrapped USDC.** The wrapped mint inherits USDC's freeze authority, and Circle can freeze the escrow holding the USDC behind every wrapped token. That is the exposure of holding USDC at all, concentrated in one account: freezing the escrow stops every unwrap at once.

**We gain a product with no licensed counterparty, no corridor and no regulated activity anywhere in it**, and a transfer path in the language the team is fastest in — which is what makes it shippable in this window.

**This obligates** an honest in-product statement that this is confidentiality and not anonymity *and* that Cadence holds viewing capability; Supabase Vault encryption at rest with access control and decryption audit logging (B19); monitoring of the `disable_zk_elgamal_proof_program` gate; and keeping the Brazilian analysis above current enough to act on if a fiat corridor is added.

## Revisit when

- **B18 compatibility decision resolved 2026-09-28** — retain `spl-token-client` through the [documented service patch](../../services/proof/vendor/spl-token-client/CADENCE.md). Revisit when upstream supports unsigned instruction building with a v1-compatible dependency graph, so the patch can be removed. The original [spike finding](../dev/spikes/2026-09-27-confidential-transfer.md) still applies to the unmodified release.
- A fiat corridor is added. Trigger: the entire Context section becomes live again, unchanged.
- Wallets ship confidential-balance display. Trigger: a standing weakness closes and the dashboard stops being the only place a recipient can see their balance.
- ~~Upstream `token-wrap` supports a configurable auditor and per-caller mints. Trigger: O1 resolves without a fork.~~ Moot 2026-09-28 — O1 resolved without a fork.
- Upstream deploys `token-wrap`. Trigger: its wrapped USDC is a different mint from ours, because the address derives from the program ID, so moving to it migrates every balance. Decide whether sharing a mint with the rest of the ecosystem is worth that.
- The `disable_zk_elgamal_proof_program` gate activates. Both gates remain ordinary feature gates at epoch boundaries after 95% stake adoption. Trigger: fall back to transparent transfers; payments continue.

## Open items

| # | Item | Owner | Needed by |
|---|---|---|---|
| ~~O1~~ | ~~Auditor access through an app-level grant on a shared mint, or a mint per company with its own auditor key. The second is better and needs custom PDA derivation; moving from the first to the second is a migration, not a rotation~~ **Resolved 2026-09-28: app-level grants on one shared mint**, by the rule [#47](https://github.com/Dnreikronos/cadence/issues/47) set — stock `token-wrap` produced the mint B1 describes, so no fork of its logic is needed. One premise moved underneath it: sharing the canonical wrapped USDC was what made "no fork" cheap, and there is no canonical deployment to share, so we deploy the program either way and a customizer with an auditor would cost little on top. TODO(João): confirm the resolution with that in view, before the mainnet mint is created | João | Before the mainnet mint is created |
| O2 | Does the embedded-wallet provider's custody model still expose us after B9 and B16? | TODO(João): assign | Before the provider is locked |
| O3 | Can a Squads multisig originate a confidential transfer? Proof generation needs the sender's ElGamal secret and a vault is a PDA with no private key | João | Before the Company tier is sold |
| O4 | Measure browser proof-generation time at a 100-recipient run, the largest case the Company tier advertises | João | Before unlimited recipients is advertised |

## References

- [ZK ElGamal Proof program post-mortem](https://solana.com/news/post-mortem-june-25-2025) · [re-enabling issue](https://github.com/solana-program/token-2022/issues/657)
- [Confidential Balances integration guide](https://solana.com/docs/tokens/extensions/confidential-transfer/integration-guide)
- [Token Wrap program](https://www.solana-program.com/docs/token-wrap) · [source](https://github.com/solana-program/token-wrap)
- [Agave 4.2 / transaction v1](https://solana.com/upgrades/larger-transaction-sizes) · [proof compute costs](https://xroot.dev/blog/solana-confidential-transfers-kill-switch-proof-cost)
- [Res. BCB 561/2026 — Machado Meyer](https://www.machadomeyer.com.br/pt/inteligencia-juridica/publicacoes-ij/bancario-seguros-e-financeiro-ij/banco-central-altera-regras-do-efx) · [Brazil VASP rules — FCM Law](https://fcm.law/brazil-vasp-license/)
