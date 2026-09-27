# Cadence stops at the worker's wallet; the regulated last mile belongs to the exchange they already use

Status: accepted
Date: 2026-09-27 · Decided by: João · Consulted: three teammates on the client side — TODO(João): names

Team shape, which drives several decisions below: João on Solana and Rust, three on the frontend. The seam between them is deliberate — nobody but João touches Token-2022.

## Context

Three separate licensing walls stand between a foreign employer and reais in a Brazilian worker's bank account, and only one of them is about crypto.

Pushing a Pix payment requires participation in the Banco Central's SPI, which is open to banks and authorized payment institutions. Converting dollar-denominated value into reais is a câmbio operation, restricted to institutions authorized to operate in the FX market. TODO(João): confirm both with the legal review, including whether any indirect-participation route changes the picture — these are stated from general knowledge, not from a primary source.

On top of those, Resolução BCB 561/2026 takes effect **2026-10-01** and rewrites art. 50 of Res. BCB 277/2022 so that settlement between a Brazilian eFX provider and its foreign counterparty must run through a câmbio operation or a non-resident BRL account, "sendo vedado o uso de ativos virtuais." Authorization under Res. BCB 519/520/521 requires roughly R$10.8M–R$37.2M in capital with filings due **2026-10-30**, and from that date BCB-supervised institutions may not facilitate virtual-asset operations with unauthorized VASP counterparties. The framework attaches to who the users are, not where the company is incorporated.

Cadence has no licensed partner and no path to a licence. Strip the crypto out entirely and build this as a wire-based payroll product and the first two walls still stand.

Meanwhile the technical opportunity is narrow and recent. The ZK ElGamal Proof program was disabled 2025-06-11 after a Fiat-Shamir transcript bug, re-enabled at epoch 982 in June 2026, with Token-2022 redeployed carrying the confidential instructions on 2026-06-17. Transaction v1 (SIMD-0385, raising the size cap from 1,232 to 4,096 bytes per SIMD-0296) activated at mainnet epoch 1035 on **2026-09-15**. The Foundation's reference confidential transfer is 2,897 bytes, so it fits in one atomic transaction as of twelve days before this decision. Adoption is close to zero.

The question was whether to spend the build window acquiring a partner or building the product.

## Decision

Cadence delivers USDC to the worker's wallet and stops there. The worker converts to reais on the exchange where they are already a customer. We never hold BRL, never execute a câmbio operation, and never initiate a Pix payment, so none of the three walls apply to us.

### Area A — product and regulatory boundary

| # | Decision | Why |
|---|---|---|
| A1 | Delivery is USDC to the worker's wallet. The BRL last mile is out of scope. | All three licensing walls sit on the far side of that line. Crossing it requires a licence or a partner; we have neither. |
| A2 | Employers fund in USDC. No USD fiat on-ramp. | Removes the inbound leg from scope and avoids US money-transmission exposure. |
| A3 | We integrate no exchange. At most we document or deep-link the off-ramp the worker already uses. | An integration makes us a party to the conversion. A link does not. |
| A4 | Target users are Brazil-resident workers paid by foreign companies. No Brazilian-domestic payroll. | *Folha* carries FGTS, INSS and eSocial obligations and sells to a different buyer. |
| A5 | Partner acquisition runs in parallel with the build, never on its critical path. | A partner upgrades the last mile later. Nothing ships or slips on their timeline. |

### Area B — technical

| # | Decision | Why |
|---|---|---|
| B1 | Wrapped USDC via a **forked** `token-wrap` with a `MintCustomizer` that sets both an auditor ElGamal key and a confidential-transfer authority. | Stock `token-wrap` sets authority `None` and auditor `None`, immutably. The authority is what makes the auditor key rotatable later. TODO(João): confirm the `UpdateMint` path actually permits rotating `auditor_elgamal_pubkey`. |
| B2 | One atomic confidential transfer using transaction v1. | The 2,897-byte reference transaction fits the 4,096-byte cap. |
| B3 | Balance display reads the AES `decryptable_available_balance`. | Decrypting the ElGamal `available_balance` is a discrete-log solve (~1s on mobile). AES is constant time. |
| B4 | Develop against devnet or a mainnet-forking validator (Surfpool). | A stock `solana-test-validator` does not enable `ZkE1Gama1Proof11111111111111111111111111111`. |
| B5 | No custom Anchor program in v1. | Token-2022 instructions plus a Rust orchestrator cover the flow. |
| B6 | Embedded wallet provider chosen on **custody model first**, signing ergonomics second. | With the partner gone, whether we look like a custodian is the main residual regulatory question. A provider holding key shares in a TEE is a different posture than one where the worker holds the key. See Open items. |
| B7 | All RPC clients pin `maxSupportedTransactionVersion: 1`. | One v1 transaction in a block breaks `getBlock` for the whole block on clients that have not declared it. |
| B8 | Use `spl-token-client` (Rust) for the confidential helpers. Do not hand-assemble proofs. | The helpers sequence proof accounts, transfer and closes. Matches João's existing Token-2022 experience, which is Rust-side. |
| B9 | The Rust service builds **unsigned** transactions. The employer's wallet signs in the browser. | Language and custody are independent choices. No Solana signing key ever reaches our infrastructure, which keeps the Q2 answer short. |
| B10 | Proof generation runs server-side in Rust, which means the service holds employers' ElGamal secrets. | Proofs require the sender's ElGamal secret and the plaintext amounts. This grants Cadence decryption capability — but B1 already does, via the auditor key, so it costs nothing additional *under the current auditor decision*. Coupled to O1. |
| B11 | State lives in Supabase Postgres. Schema and RLS policies are migrations in the repo, applied by CLI. | No dashboard click-ops; the schema is reviewable and reproducible. Local `supabase start` gives three frontend devs a real database without a shared environment. |
| B12 | Postgres never stores a plaintext amount. | Encrypting amounts on-chain and mirroring them into a column would make the privacy claim theater. Roster, run status and timestamps only. |
| B13 | RLS policies are the authorization boundary, not a hardening pass. | The client talks to Postgres directly, so there is no API tier to enforce anything. Every table ships with policies and a test proving cross-tenant reads fail. |

## Alternatives considered

**Partner with a licensed VASP or PSP to deliver BRL — rejected for v1, not rejected in principle.** This is the better product: reais land in a bank account and the worker does nothing. It lost on availability. We have no partner, a two-week-old company asking a licensed institution for production access is a relationship problem measured in weeks, and making the demo depend on someone else saying yes puts the single largest risk on the critical path. A5 keeps it alive as an upgrade.

**Become the licensed entity — rejected.** R$10.8M–R$37.2M in capital, filings due 2026-10-30. Not a question of ambition.

**Settle cross-border without a licence — rejected, and the exposure is concrete.** From 2026-10-30 BCB-supervised institutions may not facilitate virtual-asset operations with unauthorized VASP counterparties, so any Brazilian PSP would be obliged to drop us. Incorporating offshore does not help, because the framework attaches to who the users are.

**Do nothing — evaluated and rejected.** The status quo is that the employer sends USDC ad hoc and the worker sells it manually. It works. What it lacks is the employer side: no payroll run, no records, and every amount on a public ledger. That gap is the product, and it survives intact without the last mile.

There is a contested reading of 561 — Thiago Amaral of Barcellos Tucunduva argued it reinforces traceability rather than prohibiting stablecoin use, though the same firm later acknowledged express restrictions on virtual assets. We do not rely on the permissive reading, and under this decision we do not need to.

## Consequences

**We accept a worse last mile.** "Reais in your bank account in a minute" becomes "USDC in your wallet in a second, then the four steps you already know." For Brazilian developers taking foreign contracts this is a small delta, since most already hold an exchange account — but it is a real one, and it is the first thing a judge will poke at.

**We accept that the off-ramp's cost and reliability are invisible to us.** We cannot quote the worker an all-in rate, because we do not control the leg where the spread happens. Any figure we show is the employer-side cost only, and the UI must say so.

**We accept an unresolved question about our own classification.** Orchestrating non-custodial transfers may or may not constitute a VASP activity under Res. 519/520, and the answer depends partly on the embedded-wallet provider's custody model. This is the residual risk of the whole design and it is why B6 exists.

**We accept an auditor key we hold ourselves for now**, with no partner to hand it to, which means Cadence can decrypt amounts on the shared mint. The authority in B1 exists so this is reversible.

**We accept that server-side proof generation deepens that same exposure** — the service holds employers' ElGamal secrets as well. The two are coupled: reversing B1 toward per-employer auditor keys without also moving proof generation to the client would leave the privacy claim false. That is a transfer-path rewrite, not a key rotation, and O1 has to be decided with that price in view.

**We gain a product with no licensing dependency and no partner on the critical path**, which is compliant on 2026-10-01 by construction rather than by argument, and which can ship and acquire real users without anyone's permission.

**This obligates** auditor-key custody and a documented disclosure procedure, monitoring of the `disable_zk_elgamal_proof_program` feature gate, and explicit product copy stating that the off-ramp is the worker's own and that confidentiality covers amounts only.

## Revisit when

- A licensed partner signs. Trigger: the BRL last mile comes into scope and the auditor key transfers to them. This is the intended upgrade path, not a reversal.
- The legal review finds that orchestrating transfers is a VASP activity. Trigger: reopen the entire structure, including whether the product can operate at all in its current form.
- The `disable_zk_elgamal_proof_program` gate activates. Both it and `reenable_zk_elgamal_proof_program` remain ordinary feature gates activated at epoch boundaries after 95% stake adoption. Trigger: fall back to transparent transfers; the product still pays people.
- Upstream `token-wrap` adds a configurable auditor and authority. Trigger: drop the fork.

## Open items

| # | Item | Owner | Needed by |
|---|---|---|---|
| O1 | Who holds the auditor key long-term, now that there is no partner. Per-employer mints with the employer's own auditor is the privacy-maximal answer; it deepens the fork **and** forces proof generation back to the client (B10). | João | Before the mint is created |
| O2 | Does the embedded-wallet provider's custody model make us look like a custodian under Res. 519/520? B9 narrows this but does not close it. | TODO(João): assign | Before the wallet provider is locked |
| O3 | Confirm SPI participation and câmbio authorization rules against a primary source | João | With the legal review |
| O4 | Verify browser-side bulletproof range-proof cost, if O1 ever forces proof generation client-side. Unmeasured — it could be fine or several seconds per transfer. | João | Only if O1 moves |

## References

- [Res. BCB 561/2026 — Machado Meyer](https://www.machadomeyer.com.br/pt/inteligencia-juridica/publicacoes-ij/bancario-seguros-e-financeiro-ij/banco-central-altera-regras-do-efx) · [ABBC](https://abbc.org.br/resolucao-bcb-561-2026-amplia-regras-para-efx-e-abre-debates-sobre-cripto-tributacao-e-integracao-tecnologica/) · [Ledger Insights](https://www.ledgerinsights.com/brazil-imposes-partial-ban-on-stablecoins-crypto-for-cross-border-payments-and-fx/)
- [Brazil VASP licence rules and deadlines — FCM Law](https://fcm.law/brazil-vasp-license/)
- [ZK ElGamal Proof program post-mortem](https://solana.com/news/post-mortem-june-25-2025) · [re-enabling issue](https://github.com/solana-program/token-2022/issues/657)
- [Confidential Balances integration guide](https://solana.com/docs/tokens/extensions/confidential-transfer/integration-guide)
- [Token Wrap program](https://www.solana-program.com/docs/token-wrap) · [source](https://github.com/solana-program/token-wrap)
- [Agave 4.2 / transaction v1](https://solana.com/upgrades/larger-transaction-sizes)
- [Proof compute costs](https://xroot.dev/blog/solana-confidential-transfers-kill-switch-proof-cost)

Product definition: [PRD — Cadence](../prd-confidential-payroll-rail.md)
