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
