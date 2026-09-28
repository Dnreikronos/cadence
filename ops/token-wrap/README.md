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
