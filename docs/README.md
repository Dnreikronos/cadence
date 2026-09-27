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

- [Cadence](prd-confidential-payroll-rail.md) — foreign employers run payroll to Brazil in one approval, without publishing what anyone earns. Status: draft.

## Decisions

- [Cadence stops at the worker's wallet; the regulated last mile belongs to the exchange they already use](decisions/2026-09-27-confidential-payroll-rail-architecture.md) — 2026-09-27. The three licensing walls between a foreign employer and reais in a Brazilian bank account, why v1 stops short of all of them, and why the confidential mint is a forked `token-wrap`. Status: accepted.
