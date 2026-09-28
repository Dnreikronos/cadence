# Token Wrap, deployed by Cadence

Issue [#47](https://github.com/Dnreikronos/cadence/issues/47). ADR B1 has
Cadence wrap USDC through `token-wrap`, and the issue assumes the program is
already on devnet. It is not on any cluster. The canonical program ID,
`TwRapQCDhWkZRrDaHfZGuHxkZ91gHDRkyuzNqeU5MgR`, has no account on devnet,
testnet or mainnet, and the upstream docs list mainnet and testnet as "not yet
deployed". So this directory deploys our own copy.

The copy is upstream `program@v1.0.0` with one line changed, the program ID.
`build.sh` is the whole fork and refuses to build if the patch touched anything
else.

## Devnet

| | |
|---|---|
| Program | [`8vc29A8ztm3pE5qJ43paHTMGtBTnf5jXvyqcPQcTjJZc`](https://explorer.solana.com/address/8vc29A8ztm3pE5qJ43paHTMGtBTnf5jXvyqcPQcTjJZc?cluster=devnet) |
| Upstream | `program@v1.0.0`, commit `4e4e1d0ed63e1e49d43de2db9ad533c2863b3598` |
| Toolchain | Solana 2.3.4, as upstream builds this tag |
| `.so` SHA-256 | `079bd8b05bbdd885f6a68c2d18dd38439faeaf754ad078780c56c5dd4496c345` |
| Upgrade authority | `DLk4sKdCznkrXX7QP51vQEcLRtgTuTv5P3pG86kKo1cY`, the spike's devnet payer |
| Deployed | 2026-09-28, slot 505168490 |

The hash is of the program as dumped back from devnet, and it matches a local
build. To check it yourself:

```bash
solana program dump -u devnet 8vc29A8ztm3pE5qJ43paHTMGtBTnf5jXvyqcPQcTjJZc deployed.so && shasum -a 256 deployed.so
```

The upgrade authority is a throwaway key that lives on one laptop. Fine for
devnet. It is the first thing to replace before anything like this goes near
mainnet.

## Building and deploying

Needs the Solana 2.3.4 CLI on `PATH` and `program-keypair.json` beside this
file. That keypair is gitignored, and after the first deploy it only fixes the
address; upgrades go through the upgrade authority.

```bash
ops/token-wrap/build.sh
```

```bash
solana program deploy -u devnet -k <payer> --program-id ops/token-wrap/program-keypair.json --max-len 462120 ops/token-wrap/target/spl_token_wrap.so
```

`--max-len` is the exact size of the binary, so the program account has no room
to grow. An upgrade to a bigger binary needs `solana program extend` first. The
deploy peaks at about 4.7 SOL (the program account plus the upload buffer) and
settles at about 2.35 SOL once the buffer is closed.

## What this changes about O1

- **Wrapped mints are one per deployment.** The wrapped mint is a PDA over
  the unwrapped mint and the wrapped token program, under the wrap program's
  ID. Stock `token-wrap` therefore gives exactly one Token-2022 wrapped USDC
  per deployment, shared by everyone who uses it. A mint per company needs a
  fork.
- **"No fork needed" lost its main benefit.** The point of using stock
  `token-wrap` was to share the canonical wrapped USDC with everyone else. With
  no canonical deployment there is nothing to share, and we run our own copy
  either way. Swapping in a customizer with an auditor is a small change on top
  of that.
- **Circle can freeze wrapped USDC.** The default customizer copies USDC's
  freeze authority onto the wrapped mint. Circle can also freeze the escrow
  that holds the real USDC, under any deployment. Upstream `main` expects this.
  Its unreleased `SetCanonicalPointer` lets a mint authority point at a
  preferred fork and freeze the escrow of the others.
