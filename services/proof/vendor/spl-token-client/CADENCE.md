# Cadence patch to spl-token-client

Upstream: `spl-token-client` **0.19.1**, Apache-2.0, distributed under the
included `LICENSE`. Library source and the normalized Cargo manifest came
from the crates.io release archive. Upstream integration tests and lockfile
are not vendored; the service owns its lockfile and compatibility tests.

- Archive: <https://static.crates.io/crates/spl-token-client/spl-token-client-0.19.1.crate>
- Archive SHA-256: `44952d7260cbceda11934539efab518babe9e88ac961ebf01d893b20b77e8e34`
- Release VCS revision: `f6b32ad49b61a91a3ef1fa141ec18838177eee36`
- Upstream directory: `clients/rust-legacy`

Only three upstream files change:

1. `Cargo.toml`: add an `rpc` feature for the two RPC crates, retain it in the
   defaults and `display`, and explicitly enable `solana-transaction/bincode`
   (previously enabled transitively). Cadence disables default features.
2. `src/client.rs`: gate concrete RPC/offline clients and their imports behind
   `rpc`. The generic `ProgramClient` traits stay available for our adapter.
3. `src/token.rs`: extract `confidential_transfer_transfer_instructions` from
   the existing transfer helper, returning its instructions before
   `process_ixs`. Accept signer public keys instead of signing objects. The
   original helper delegates to it and retains its existing sending behavior.

All four `src/zk_proofs` files, `src/lib.rs`, and `src/output.rs` are byte-for-byte
upstream. No cryptographic algorithms, proof locations, or balance calculations
were changed. Compare these three files with the verified archive to review
the patch. Avoid formatting or refactoring unrelated upstream code.

Why: the release's RPC dependency graph conflicts with v1's `solana-hash`
version, and its `construct_tx` builds and partially signs a legacy transaction.
An instruction-returning API bypasses that path and lets the service return
unsigned v1 bytes to the browser. A plain transport replacement would still
need to undo legacy packaging and handle signatures; this exposes the needed
boundary directly.

The service tests the no-default-features configuration it ships, not the full
upstream default-feature matrix. Upstream currently emits a deprecation warning
for `get_required_init_account_extensions` in an unrelated account-creation
helper; service code passes Clippy with warnings denied. Do not silence that
warning globally or mistake it for a new service warning.

On upgrades, reapply this minimal patch, verify untouched proof sources, run
the service compatibility and health tests, and repeat a devnet transfer
before accepting the new version. Remove the patch when upstream exposes an
unsigned builder and a compatible dependency graph. This is a Rust library
patch, not a change to the deployed token-wrap or Token-2022 programs.
