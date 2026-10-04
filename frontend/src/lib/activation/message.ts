// The message the wallet signs to derive the balance key. The service derives the
// ElGamal and AES keys from the signature, so the signature is as secret as a key
// (API_CONTRACT, key enrollment).
//
// PLACEHOLDER: the contract says the real message is the SDK's key-derivation
// message for one token account, which the web app cannot build yet (the token
// account is not known to it, and the contract has no route that returns the
// message). Replace this with the canonical message when #80 integrates the signer.
export function keyDerivationMessage(wallet: string): Uint8Array {
  return new TextEncoder().encode(
    `Cadence confidential balance key v1\nwallet: ${wallet}`,
  )
}
