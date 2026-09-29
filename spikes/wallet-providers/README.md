# Wallet provider spike

Issue [#51](https://github.com/Dnreikronos/cadence/issues/51).

## Provider decision — 2026-09-29

Select **Turnkey's transaction API** for confidential v1 signing. After the
Phantom capability check below failed, the user provisioned Turnkey credentials
and authorized a disposable devnet experiment. This supersedes the temporary
Phantom-only scope. Use `@turnkey/sdk-server` directly; the Solana SDK's local
v1 serialization failure remains reproducible.

The technical “done when” criterion is met: a selected provider authorized a
confirmed confidential transfer. The original checklist is not fully exercised:
Privy's remote signing remains untested without credentials. Production browser
onboarding (#77) and the O2 custody/recovery review remain separate open work.

### Live evidence

- Provider: `turnkey-api`, `@turnkey/sdk-server` 8.6.0.
- Wallet: `4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5`, newly created for
  this experiment; authenticated with the developer's root-user API key.
- [Confirmed devnet transfer](https://explorer.solana.com/tx/4AGRXsecEoxPdzvZoPn1rGSdKXMXTVTBofjSUXzTHG8wWdxdNPth2pRCiZ3QQGEqg2VQdstweLEKcvDLs1FRuHQn?cluster=devnet),
  slot **505677040**, version **1**, **2,491 bytes**, four instructions (transfer
  plus three proofs). Turnkey signed as the token-account owner; a separate
  disposable local key paid fees.
- The Rust bridge verified every signature, unchanged message bytes and the
  preserved fee-payer signature before broadcasting through
  `https://api.devnet.solana.com`.
- Independent retrieval through `https://solana-devnet.api.onfinality.io/public`
  returned the v1 confidential instruction and ciphertext. The sender retained
  5,800,000 units; the recipient decrypted 4,200,000 pending units.
- No remote instruction-parsing or signing rejection occurred for this root-key
  request. This does **not** establish non-root policy support, plaintext amount
  restrictions, end-user ownership, or production recovery controls.
- The first attempt stopped before setup because the devnet guard contained a
  truncated genesis hash. Both RPCs returned
  `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; the guard now compares the full
  value. Its regression test accepts that hash and rejects truncated, other and
  missing values. Never bypass the cluster check to work around a mismatch.

Validation after the fix: two targeted Rust provider tests, Rust formatting and
Clippy across all targets, JavaScript type checking, Biome and four provider
adapter tests passed. The live experiment exited successfully. Credentials are
stored outside the repository and are not part of this evidence.

## Earlier Phantom scope — superseded

The user selected Phantom to avoid provisioning embedded-wallet services.
The initial flow requires an existing Phantom wallet; automatic creation for
walletless recipients is deferred. The original Turnkey/Privy comparison below
is retained as historical research, not a prerequisite for this revised scope.

First inspect the installed Phantom extension's Wallet Standard
`solana:signTransaction.supportedTransactionVersions` on a localhost page.
This requires no connection, signature, account address or funds. Proceed to a
real devnet transfer only if it advertises transaction version **1**. Version 0
support does not establish version 1 support, and missing capabilities are
inconclusive. Do not downgrade the transaction or sign its bytes as a message to
work around an unsupported version. The final compatibility gate remains a
Phantom-authorized confidential transfer confirmed on devnet.

Run `rtk npm run phantom` from this directory, then open
<http://127.0.0.1:8787> in the browser/profile containing Phantom. The local
server serves only the check page and its two JavaScript modules, binds to
loopback, and exposes no credentials, RPC proxy or signing endpoint. It uses
the official `@wallet-standard/app` registry rather than assuming any globally
injected wallet is Phantom.

Results mean:

- `not-found`: Phantom has not registered on this page; check browser/profile
  and extension site access. This says nothing about its version support.
- `unknown`: signing metadata is absent; compatibility remains unverified.
- `unsupported`: the declared versions exclude numeric `1`; stop before signing.
- `advertised`: numeric `1` is present; proceed to the real devnet test, which is
  still required before claiming compatibility.

After the user installed Phantom, the live check in Brave at
`2026-09-29T21:39:24.377Z` returned `unsupported`, with advertised versions
`["legacy", 0]`. This supersedes the earlier `not-found` result. The installed
extension's Wallet Standard signing API does not advertise v1, so the current
Phantom approach is blocked before signing. This is capability evidence, not
an observed transaction rejection; no wallet connection, signature, or devnet
submission was requested. The extension release number was not collected.

The browser capability classifier and local HTTP route tests pass (four targeted
tests), along with JavaScript type checking and Biome. Recheck after an extension
update that adds v1 support, or choose a different signing path. Splitting the
proofs into separate transactions would change the atomic-transfer requirement;
it is not an interchangeable wallet fix.

## Embedded-provider experiment contract

Reuse the real proof generation and devnet setup from `../confidential-transfer`.
After funding its disposable sender, change that token account's owner to the
provider wallet. Keep the local disposable payer for fees. The provider must
sign as the transfer authority, not merely as an additional fee payer.
Confidential keys stay with the spike; changing the token owner does not change
the account's ElGamal public key. This is a transaction compatibility experiment,
not the production onboarding or key derivation flow.

Attempt Turnkey's Solana SDK, Turnkey's transaction API if its SDK cannot serialize
v1, and Privy's transaction API. Record SDK encoding failures separately from
remote policy/signing failures. Never silently fall back to raw-message signing.
Use each provider's own wallet and the same four-instruction transfer shape;
addresses, blockhashes and proofs necessarily differ between runs.

Before submission, reject any changed message, missing/invalid signature, or
transaction above 4,096 bytes. Require successful devnet confirmation and the
existing independent-RPC ciphertext check. Document an authenticated rejection
as a failure, missing credentials as untested, and local mocks as local only.

The live Turnkey run now satisfies the provider-signing gate. B6 and O2
distinguish technical compatibility from the production user-control/recovery
configuration and legal assessment.

## Findings — 2026-09-28

At the time of these initial findings, no provider credentials were available. No remote
signing request was made, no provider policy was evaluated, and no provider-signed
devnet transfer had been confirmed. Browser extension wallets do not supply these API
credentials. At that point, Turnkey was the first candidate to validate because its transaction
API explicitly documents v1. The live Turnkey result above supersedes these initial findings.

| Path | Locally observed result | What remains untested |
|---|---|---|
| `@turnkey/solana` 1.1.43 with `@solana/web3.js` 1.99.0 | Real `TurnkeySigner.signTransaction` fails before its API call: `Serialization of version 1 transaction messages is not supported` | Nothing in this failure establishes a provider-side rejection |
| `@turnkey/sdk-server` 8.6.0 `signTransaction` | Exact Rust wire bytes passed as hex; live root-key signing and devnet confirmation succeeded (evidence above) | Non-root policy evaluation and production user-control setup |
| `@privy-io/node` 0.35.0 `wallets().solana().signTransaction` | Real SDK passes the exact bytes as base64 to a mocked HTTP transport | Server acceptance of v1, confidential instructions, policy evaluation and devnet confirmation |

The SDK failure is reproducible using `fixture.json`: the original spike builds
real proofs over a synthetic balance, then clears its signatures. It is 2,395
bytes, starts with `0x81`, and contains the confidential transfer plus its three
proofs. It is not a devnet transaction and has no recoverable wallet keys.
`web3.js` can deserialize it, but `MessageV1.serialize()` explicitly throws;
`TurnkeySigner.signTransaction()` calls that serializer before making a request.
Use the transaction API adapter for the live Turnkey experiment. Prevent this
class of integration failure by testing the full Rust-wire → SDK → wire round
trip when upgrading wallet dependencies, not just checking whether v1 can decode.

[Turnkey's v1 documentation](https://docs.turnkey.com/features/networks/solana-transactions)
specifies a complete hex wire transaction, including trailing signature slots.
The signed message includes the version prefix and excludes those slots.
The API adapter follows that contract; it does not replace `signTransaction`
with raw-payload signing. This keeps the transaction-policy path under test.
The [Privy signing guide](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction)
accepts encoded transaction bytes but does not establish confidential-v1 support.

No instruction-parsing or policy-engine failure has been observed remotely, including the successful root-key experiment.
The live result establishes that the transaction API can sign this confidential
instruction shape. It does not establish how the policy engine parses it.
An encrypted amount cannot be checked by an ordinary
plaintext amount policy; whether instruction/account restrictions accept these
instructions must be tested with the intended **non-root** user policy. A root
test cannot demonstrate that policy. The bridge reports stage/error type without
printing provider response bodies or credentials; record sanitized provider
diagnostics from its dashboard when investigating a rejection.

## Custody comparison and decision gate

| | Turnkey | Privy |
|---|---|---|
| User-control model | Sub-organization with the end user as root; parent organization has read-only visibility | User-owned embedded wallet with user authorization; user key export is available |
| Configuration that changes the boundary | Giving Cadence root/quorum credentials, a signing API key, or recovery control | Developer-controlled wallets or delegated developer signing rights |
| What must be verified | Root membership, quorum, signing policies, recovery and export paths | Owner, additional signers, authorization quorum, recovery and export paths |

Sources: [Turnkey sub-organizations](https://docs.turnkey.com/features/sub-organizations),
[Privy flexible custody](https://docs.privy.io/wallets/overview/flexible-custody),
[Privy embedded wallets](https://docs.privy.io/wallets/overview/embedded).
Both products support configurations with materially different control rights.
Provider branding does not settle Cadence's custody posture. B9 requires user
signing without Cadence unilateral spending authority; no backend signing or
recovery credential should make that claim false. These are technical control
requirements, not a legal conclusion. O2 remains open pending the production setup
and its regulatory assessment. The CLI's dev-only authorization credentials do
not demonstrate the browser's production custody model or Supabase login flow.

## Reproduce local checks

Node 22+ and the Rust toolchain used by `../confidential-transfer` are required.
From this directory:

```sh
npm ci --ignore-scripts
rtk npm run check
rtk npm run lint
rtk npm run test
cd ../confidential-transfer
rtk cargo check --locked --all-targets
rtk cargo clippy --locked --all-targets -- -D warnings
rtk cargo fmt --check
rtk cargo test --locked provider_output_must_preserve_message_and_authorize_every_signer
WALLET_SPIKE_FIXTURE=../wallet-providers/fixture.json rtk cargo test --locked one_confidential_transfer_fits_in_a_v1_transaction
```

Fixture generation uses random proof inputs and rewrites the fixture; its address
and bytes will change. It never reads a funded wallet or contacts an RPC.
Locally executed: compiler/type checks, Rust formatting and Clippy, Biome,
four Node tests, and the two targeted Rust tests above all passed. The full
repository suite and remote CI were not run.

## Reproduce the live experiment

Create a disposable Solana wallet separately in each provider and authorize
signing for it. Do not import the Phantom/MetaMask wallet or its seed phrase.
Use dev-only credentials for this experiment. Install the Node dependencies
above and export the relevant environment variables in the shell:

| Variable | Use |
|---|---|
| `WALLET_PROVIDER` | `turnkey-api` or `privy`; `turnkey-sdk` reproduces the known SDK failure |
| `WALLET_ADDRESS` | Provider wallet's Solana public address |
| `TURNKEY_ORGANIZATION_ID` | Organization/sub-organization holding the signing wallet |
| `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY` | Authorized credential for that organization |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID` | Dev app and wallet identifiers; the bridge checks the wallet ID/address match |
| `PRIVY_USER_JWT` or `PRIVY_AUTHORIZATION_PRIVATE_KEY` | Authorization for the wallet's owner/signer; a user JWT is short-lived |
| `SPIKE_KEYPAIR` | Existing spike's disposable local fee payer, with about 0.2 devnet SOL |
| `SPIKE_RPC_URL`, `SPIKE_VERIFY_RPC_URL` | Optional devnet sending and independent verification endpoints |

```sh
node sign.mjs check
cd ../confidential-transfer
rtk cargo run --locked
```

The default RPC is devnet, and provider mode verifies its genesis hash before
spending. Leave `SPIKE_MINT` unset to create disposable test tokens. Setup remains
locally signed; `SetAuthority` assigns the sender account to the provider before
the confidential transfer. The live transaction has an additional provider signer
and will be larger than the one-signer 2,395-byte fixture. The Rust bridge verifies
every signature and exact message equality before broadcasting, then the original
spike confirms and checks ciphertext through an independent RPC. Viewing keys are
ephemeral; reruns create fresh accounts. Do not fund these accounts with real assets.

Run separately for each provider. The bridge never automatically retries with a
different signing mechanism. Record package versions, provider mode, wallet
address, non-root policy configuration, sanitized failure stage/details, and—on
success—transaction signature, confirmed slot, size and independent-RPC result
here. The Turnkey result above resolves B6's technical gate; O2 also
requires the user-control and recovery review above.
