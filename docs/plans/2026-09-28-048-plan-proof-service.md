# Proof service scaffold

Issue: [#48](https://github.com/Dnreikronos/cadence/issues/48).

The deliverable is a standalone `services/proof` Rust crate with an axum HTTP
server, validated environment configuration, one HTTP error mapping, a Solana
RPC client, a container image, and a GitHub Actions workflow. This issue does
not add proof endpoints, key storage, transaction submission, or signing.

## Contract

- Require `PROOF_RPC_URL` (HTTP or HTTPS) and `BUILD_SHA` (a full Git SHA).
  Reject missing, empty, or invalid values before binding a socket. Do not log
  the RPC URL, which may contain a provider credential.
- Default `PROOF_BIND_ADDR` to `0.0.0.0:3000` and `PROOF_RPC_TIMEOUT_MS` to
  5000. Reject invalid addresses and timeouts outside 1–60000 ms.
- `GET /health` calls Solana `getHealth`. Return HTTP 200 with `status: "ok"`,
  `build_sha`, and `rpc_reachable: true` only for a valid `"ok"` response.
  Return HTTP 503 with the same build identity, `status: "unavailable"`, and
  `rpc_reachable: false` for timeouts, transport errors, unhealthy nodes, or
  malformed responses. Here reachability means a usable, healthy RPC.
- Bound RPC requests by the configured timeout. Never expose upstream bodies
  or URLs in public errors. The shared error type maps RPC failures to 503 and
  internal failures to 500.
- Expose transaction and block reads with `maxSupportedTransactionVersion: 1`
  set centrally. Do not add that parameter to methods that do not accept it.
- Drain active requests on SIGINT or SIGTERM.
- Build a non-root runtime image with TLS certificates. Supply `BUILD_SHA`
  when building the image and RPC configuration when running it.

## Dependency decision

Confirmed with João: retain `spl-token-client` through a pinned local patch of
0.19.1. Make the legacy RPC implementation optional and expose confidential
transfer instructions before transaction packaging or signing. Keep upstream
proof generation and balance helpers unchanged. Use a read-only ProgramClient
adapter and public-key-only payer; compile unsigned v1 transactions with both
compute and loaded-account budgets set. The browser remains the signer.

Compatibility is a gate: resolve and compile the combined dependency graph,
exercise the actual patched helper with real proofs, check instruction offsets
and signature placeholders, and run a devnet transfer through that path before
calling the integration verified. Preserve the upstream license and document
exact patch provenance and the maintenance obligation.

## Verification

Run format checks, the compiler, Clippy with warnings denied, and targeted
tests for configuration, HTTP health behavior, RPC failure handling, and v1
read parameters. Mock RPC tests run without network access or a funded key.
CI also builds the container and probes `/health` against public devnet, with
bounded retries for transient provider failures. Locally test the running
container, missing configuration, and graceful shutdown. A public endpoint
outage must fail the live smoke check rather than manufacture success.

## Evidence collected locally

- The patched client resolves alongside `solana-message`/`solana-transaction`
  5.1 and the service compiles. Only the vendored manifest and two source files
  differ from the release; upstream proof modules are unchanged.
- The patched helper generated a 2,395-byte transfer with inline proofs, then
  the service compiled unsigned v1 bytes. An external test signer signed and
  submitted it to devnet. It confirmed at slot 505330225; the recipient
  decrypted 4,200,000 units. Signature and limitations are in the service README.
- Local format, compiler, Clippy, and targeted tests passed. One existing
  upstream deprecation warning remains in the vendored account-creation code.
- The Docker image built and ran as UID 65532. Its `/health` returned 200 with
  a reachable public devnet RPC and the supplied SHA. Omitting `PROOF_RPC_URL`
  caused immediate failure before listening.
- Both SIGTERM and SIGINT were tested with a health request in flight: the
  request completed successfully and the process exited with status 0.
- The GitHub Actions workflow is added; a remote CI run has not been claimed.
