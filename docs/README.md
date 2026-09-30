# Docs router

Proposed layout, following the convention used in `supa-skeleton`. Nothing here
is established yet — if this doc set moves into an existing repo, match that
repo's paths instead of these.

| Genre | Path |
|---|---|
| PRD | `docs/prd-<slug>.md` |
| ADR / decision log | `docs/decisions/YYYY-MM-DD-<slug>.md` |
| Implementation plan | `docs/plans/YYYY-MM-DD-NNN-plan-<slug>.md` |
| Design deep-dive | `docs/dev/<UPPER_SNAKE_CASE>.md` |
| Spike / POC report | `docs/dev/spikes/YYYY-MM-DD-<slug>.md` |
| Past-problem writeup | `docs/solutions/<category>/<claim-as-sentence-slug>.md` |

## Product

- [Cadence — confidential USDC payments](prd-confidential-usdc-payments.md) — companies pay their team and suppliers in dollars without showing the amounts to the world. Status: draft.
- ~~[Payroll rail for Brazil](prd-confidential-payroll-rail.md)~~ — superseded 2026-09-27. Kept for the Brazilian licensing analysis, which applies again if a fiat corridor is ever added.

## Decisions

- [Cadence pays people who already hold dollars, so no part of the product is a regulated activity](decisions/2026-09-27-confidential-payroll-rail-architecture.md) — 2026-09-27, decision log. Why the Brazil corridor was abandoned, why proof generation moved to the browser, and what is still open on the wrapped mint. Status: accepted.

## Implementation plans

- [Company wallets sign the USDC wrap transaction](plans/2026-09-29-052-plan-wrap.md) — 2026-09-29, #52. Implemented and tested locally; browser-wallet devnet acceptance remains unverified. [API contract](dev/WRAP_API.md).

## Spikes

- [One confidential transfer is 2,395 bytes on devnet, and `spl-token-client` cannot send it](dev/spikes/2026-09-27-confidential-transfer.md) — 2026-09-27. Verdict: go, conditional on superseding B18. R2 and R3 confirmed on chain; the client the ADR picks cannot build a v1 transaction.
