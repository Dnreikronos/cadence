# ~~Cadence — foreign employers run payroll to Brazil in one approval, without publishing what anyone earns~~

> **Superseded 2026-09-27 by [PRD — confidential USDC payments](prd-confidential-usdc-payments.md).**
>
> The recipient in this version still had to sell USDC on an exchange to reach
> reais, so the product improved the payer's experience and not theirs. The
> replacement serves people who hold dollars by preference, which removes the
> last mile instead of deferring it.
>
> Kept rather than deleted: the Brazilian licensing analysis becomes live again
> unchanged the moment a fiat corridor is added. The Context section of the
> [ADR](decisions/2026-09-27-confidential-payroll-rail-architecture.md) carries
> the same material in maintained form — prefer that over this file.

Status: superseded
Date: 2026-09-27 · Owner: João
Architecture decisions: [ADR 2026-09-27](decisions/2026-09-27-confidential-payroll-rail-architecture.md)

## The problem

A US company with four Brazilian contractors pays them through Deel, Wise, or Payoneer. The money takes two to five days and loses several percent to FX spread and wire fees. TODO(João): measure the real all-in cost on five actual payslips before this number goes anywhere near a deck — the 5–7% figure we have been repeating is an estimate nobody has verified.

The companies that already route around this do it by hand. The employer opens a wallet, looks up four addresses in a spreadsheet, sends four transfers, and writes down what they sent. There is no payroll run, no approval step, no record either side's accountant will accept, and every amount is legible on-chain to anyone who knows a worker's address. That last part is why this stays at four contractors and never becomes forty. No finance team will publish its salary band, and no worker wants their pay visible to everyone they have ever transacted with.

Nobody has shipped the version where the amounts are private, because until 2026-09-15 a confidential transfer on Solana did not fit in a single transaction.

## What we're building

A payroll product for companies outside Brazil paying people inside Brazil. The employer adds their workers once, funds a run in USDC, and approves it. Each worker receives USDC in their wallet within seconds, along with a payroll record both sides can give to an accountant.

The amounts are encrypted on the ledger. A worker's pay is visible to the worker, to the employer, and to a designated auditor holding the disclosure key — and to nobody else.

Workers convert to reais on the exchange where they are already a customer. Cadence never holds reais, never converts currency, and never initiates a Pix payment.

## Not building

- **The BRL last mile.** Pix access requires SPI participation and currency conversion requires câmbio authorization; both are licensed activities and we hold neither licence. See ADR Fork 1. This is the largest scope cut and the one most likely to be challenged.
- **An exchange integration.** Documenting or linking the off-ramp is fine. Integrating makes us a party to the conversion, which is the line the whole design exists to stay behind.
- **A USD fiat on-ramp.** Employers fund in USDC.
- **Brazilian domestic payroll.** *Folha* carries FGTS, INSS and eSocial obligations and sells to a different buyer.
- **Our own wallet.** Embedded wallets come from a provider.
- **Anonymity.** Only amounts and balances are encrypted. Account addresses, the mint and account owners stay public, so the fact that a given employer paid a given worker remains visible. User-facing copy must say this plainly.
- **A custom on-chain program in v1.**
- **Corridors other than Brazil.**

## How it behaves

**An employer runs payroll.** They add workers once, each with a name and an amount. They fund the run with a single USDC transfer and approve it. They see a per-worker breakdown, a total, and a status per payment. They do not see a seed phrase, a gas setting, or the word "blockchain" anywhere in the flow.

**A worker joins.** They open a link, sign in, and a wallet is created behind the scenes without them choosing to create one.

**A worker gets paid.** USDC arrives in their wallet within seconds. They get a notification and a record showing the amount, the date, and the employer. Their history shows every past payment.

**A worker cashes out.** Cadence shows them where — the exchanges that serve Brazil and settle to Pix — and states plainly that this leg is theirs, on their account, at that exchange's rate. We do not quote a rate we do not control.

**A worker checks their balance.** The dashboard decrypts and displays it. A third party querying the same on-chain account sees ciphertext.

**An auditor needs the numbers.** The holder of the auditor key decrypts amounts for the accounts in scope, without the worker or employer handing anything over, and without that capability extending to the public.

**The proof program goes away.** If the `disable_zk_elgamal_proof_program` gate activates, the product falls back to transparent transfers and keeps paying people. Payments never depend on confidentiality being available.

## Requirements

| # | Requirement | Done when |
|---|---|---|
| R1 | An employer funds one run and every listed worker receives USDC | A mainnet run of ≥3 workers completes from a single approval, and all three confirm receipt |
| R2 | Per-worker amounts are encrypted on-chain | A block explorer and a third-party RPC both return ciphertext for the transfer amount; our dashboard shows cleartext to the worker |
| R3 | A confidential transfer executes in one transaction | The transfer lands as a single v1 transaction under 4,096 bytes, resolving to one confirmed signature rather than a chain |
| R4 | A designated auditor can decrypt amounts without worker or employer action | An auditor-key holder decrypts a test transfer; a non-holder with identical RPC access cannot |
| R5 | Balance display does not block the UI | The dashboard reads the AES `decryptable_available_balance`; balance renders under 300ms on a mid-range Android device |
| R6 | Cadence holds no BRL, converts no currency, and initiates no Pix payment | A written description of the money flow shows the worker's own exchange account as the only conversion point, reviewed by a Brazilian fintech lawyer |
| R7 | The product degrades safely if confidentiality is unavailable | With the proof program simulated unavailable, a run still completes using transparent transfers |
| R8 | A worker onboards without seeing wallet mechanics | A user who has never used crypto completes onboarding unassisted — observed, not self-reported |
| R9 | Both sides can produce a payment record | Employer and worker can each export a run with amounts, dates and counterparties |
| R10 | The cash-out step does not lose people | ≥70% of paid workers complete a first cash-out; measured by asking them, since we cannot see the exchange leg |
| R11 | Real people are using it | ≥30 completed mainnet payments across ≥10 distinct workers, with total volume reportable |
| R12 | No tenant can read another tenant's data | A worker session attempting to read another worker's rows fails; an employer session attempting to read another employer's roster fails. Both covered by tests that run on every migration |
| R13 | No plaintext amount is stored off-chain | A dump of every Postgres table contains no column holding a readable payroll amount |

## Constraints

- **Pix access requires SPI participation and currency conversion requires câmbio authorization.** Both are restricted to BCB-authorized institutions. This is why R6 exists and why the last mile is out of scope. TODO(João): confirm against a primary source during the legal review.
- **Resolução BCB 561/2026 takes effect 2026-10-01** — virtual assets may not settle between a Brazilian eFX provider and its foreign counterparty (art. 50 of Res. BCB 277/2022, as amended). Under this design we are not an eFX provider, which is the point. Source: [Machado Meyer](https://www.machadomeyer.com.br/pt/inteligencia-juridica/publicacoes-ij/bancario-seguros-e-financeiro-ij/banco-central-altera-regras-do-efx).
- **VASP authorization filings are due 2026-10-30**, and from that date BCB-supervised institutions may not facilitate virtual-asset operations with unauthorized VASP counterparties. Whether we perform a VASP activity is open — see Q2. Source: [FCM Law](https://fcm.law/brazil-vasp-license/).
- **Confidential amounts are capped at 48 bits** — about 281M tokens for a 6-decimal mint. Not binding for payroll. Source: [Confidential Balances docs](https://solana.com/docs/tokens/extensions/confidential-transfer).
- **The confidential extension must exist at mint creation**, with no migration path, so native USDC can never be used confidentially. This forces the wrapped-mint design.
- **A confidential transfer costs roughly two orders of magnitude more compute than a plain one** — range proofs run 111k CU (64-bit) to 368k CU (256-bit) against a 1.4M CU ceiling. Not binding at payroll volume. Source: [proof cost breakdown](https://xroot.dev/blog/solana-confidential-transfers-kill-switch-proof-cost).
- **Amounts may not exist in plaintext anywhere off-chain.** Encrypting on-chain and mirroring into a database column would defeat the product's only differentiated claim. This constrains the schema, the logs and any analytics. See R13.
- **Row-level security is the only authorization tier.** The client reads Postgres directly, so a missing policy is a data breach rather than a code smell. See R12 and ADR B13.
- **Colosseum submission closes 2026-10-12, 23:59 PT**, one submission per team, with mandatory disclosure of pre-existing development. Cadence has none — everything ships from scratch.

## Risks

| Risk | Likelihood | If it happens | Mitigation |
|---|---|---|---|
| Orchestrating transfers is judged a VASP activity under Res. 519/520 | Medium, high impact | The structure needs rebuilding or cannot operate | Legal review before mainnet volume beyond demo amounts; choose the wallet provider on custody model (ADR B6) |
| Workers drop off at the cash-out step | Medium | The product is technically complete and commercially dead | R10 measures it explicitly; if it fails, the partner path (ADR A5) stops being an upgrade and becomes necessary |
| `token-wrap` fork costs more than estimated | Medium | Confidential path slips | Fall back to stock `token-wrap`, shipping without an auditor key and stating the gap |
| Embedded-wallet provider chokes on confidential-transfer instructions | Medium | Signing fails for the core flow | Spike before committing; direct keypair signing is the fallback |
| `disable_zk_elgamal_proof_program` activates | Low | Confidential transfers stop network-wide | R7 — transparent fallback is a requirement, not a contingency |
| Judges read "no BRL delivery" as an incomplete product | Medium | Weaker scoring | Frame the cut as judgment, with Res. 561 and the licensing walls named; a team that knows why it stopped there beats one that did not know the line existed |
| Amounts-only confidentiality is oversold | Medium | Trust damage, and a judge will probe it | Explicit copy in-product and in the pitch; listed under Not building for that reason |

## Open questions

Resolved 2026-09-27: **Q1** — João has used Token-2022 before, Rust-side, so the `token-wrap` fork proceeds. **Q4** — three teammates on the frontend, backing João on the backend as needed; numbering below is left unchanged so earlier references still resolve.

| # | Question | Owner | Needed by |
|---|---|---|---|
| Q2 | Does orchestrating non-custodial transfers constitute a VASP activity under Res. 519/520? Client-side signing (ADR B9) narrows this but does not close it | João | Before mainnet volume beyond demo amounts |
| Q3 | Who holds the auditor key long-term, with no partner to hand it to? Per-employer mints is the privacy-maximal answer, and it also forces proof generation back to the client — a transfer-path rewrite, not a key rotation | João | Before the mint is created |
| Q5 | Real measured all-in cost of the incumbent rails, from actual payslips | TODO(João): assign | Before any external deck |
| Q6 | Which exchanges do our first ten workers already use? Determines what the cash-out screen says | TODO(João): assign | Before the first user test |
