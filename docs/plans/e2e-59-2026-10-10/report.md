# Live devnet auditor acceptance

On 2026-10-10, all three required headed Chromium scenarios passed after local
bootstrap fixes. There were no automatic retries or weakened assertions. The
migration was applied to local Supabase, with a dedicated audit LOGIN role that
has BYPASSRLS disabled. No hosted migration or deployment was performed.

A fresh confidential devnet payment sent **12345 base units, or 0.012345 wrapped
USDC**. The proof service prepared it, a disposable fixture wallet signed it, and
the indexer stored the finalized receipt. An independent finalized RPC read
returned the same signature and slot 509631000 with no transaction error.
The receipt was not synthesized or marked finalized by fixture SQL.

[Devnet transaction](https://explorer.solana.com/tx/46DAmvoGED98e8AjZ5tj42W3zTyboEHwrY3qMvep2bZgPoMkBjkeNq2x3bJ7it6w17Z2ExTjQLm4nPW3qYAJqfk5?cluster=devnet).
[Payment metadata](devnet-payment.json) and [independent chain read](chain-evidence.json).

| Flow | Result | Observed outcome |
|---|---|---|
| Read finalized payment | Pass, 3.784 s | Real response returned exactly 12345 base units and the finalized signature. The payment page and receipt displayed it. Reload returned a fresh 200 and each read added one audit row. |
| Revoke with the same bearer | Pass, 8.812 s | The identical bearer returned 200 before revocation and 404 afterward. Auth still returned 200 for the same user. Browser reload, API and database rereads showed no grant or amount. Denied reads added no audit row. |
| Deny another company | Pass, 3.291 s | Admin created a persisted grant with 201. The same auditor received 404 for a different real company. Auth remained valid and no audit row was added. Cleanup revoked the grant and a reload still denied access. |

[Same-bearer evidence](revocation-evidence.json) and
[cross-company evidence](wrong-company-evidence.json) contain sanitized assertions.
The final grant count was zero; auditor membership and the finalized receipt
remained. The audit actor had five company rows from successful reads and two
setup probes. Grant actions and denied reads added none.

The UI rounds this small payment to $0.01; the response assertion checked the exact
base-unit amount. Grant operations and the other-company denial used real browser
fetches because #85 owns the designation UI and the audit page has no company
switch. This run does not cover product-wallet signing or invitation email.

## Serving checkout

The browser run used the original working checkout at
`b092365e1e9dfa35f2765580163112332e4bece5`, with uncommitted auditor work.
Source fingerprint `d4172b74a0471ff6726ad492ec3fa8ea4c4d02f42a98b44848f9a2496805442b`
matched before and after the scenarios. The existing Next development service
served the real payment page. Proof-origin requests were forwarded from the old
service port to a separately built current proof service, preserving real request
and response contents. No API response was mocked.

The fresh backend binary SHA256 was
`98db1fefc362c8a4eacdf857cc81758715e00a345879b51143fd4a3c13270aa3`.
The applied auditor migration SHA256 was
`b6940a52f3c6aa01c9ed49bb78c02d257a56afd37ad934f5fbdb1368308ed24d`.
This acceptance run predates the shipping branch, which starts from main at
`175c91c748f796e999277a5dbdf9268da400f393`. Its fourteen auditor implementation
and test files were compared byte for byte with the tested working source.
Targeted Rust and database checks were repeated in the shipping checkout.

## Setup and validation

The initial temporary Playwright configuration accidentally kept the demo server
launcher. It failed before any scenario ran. The first real read then returned
503 because the local database connection lacked explicit loopback
`sslmode=disable` and the migration runner could not grant usage on managed Auth.
Replaying the migration's Auth schema grant as local `supabase_admin` and correcting
the private connection fixed it. The unchanged amount assertion then passed.
The frontend renders the 404 as its generic payment-load error, with no amount.

All-target Rust compilation, formatting and Clippy with warnings denied passed in
the shipping checkout. Targeted tests passed for the sender ciphertext, audit
HTTP/configuration, existing recipient ciphertext and audit attribution. The real
Vault storage integration passed using the same disposable-image setup as CI.
All 21 auditor pgTAP checks and 46 invitation regression checks passed; the latter
used the disposable Auth fixture matched to Supabase's confirmed-email column
and claims fallback. The full suite was not run. The existing vendored token-client
deprecation warning remains.

Temporary browser scenarios passed strict TypeScript validation. An ancillary
frontend ESLint run was blocked by the installed configuration not resolving
`eslint-plugin-react-hooks`; no dependencies were installed. The temporary proof
service and scenario files were removed after the run. Existing development
services and local Supabase were preserved.

Only sanitized assertions and public devnet metadata are committed here. Bearer
headers, session storage, passwords, wallet keypairs and raw browser traces remain
in ignored local fixtures.
