import type { Signer } from "../sign"

// Stand-ins for the Turnkey signer (#77) and the RPC submit, so a screen can run
// the whole prepare, sign, confirm flow before either exists.
export function mockSigner(address: string): Signer {
  return {
    address,
    signTransaction: async (transaction) =>
      Uint8Array.from([...transaction, 1]),
    signMessage: async (message) => mockSignature(address, message),
  }
}

// 64 bytes that depend on the signer and the message, like a real signature, and
// are never all zero. It proves nothing: nothing checks it.
export function mockSignature(address: string, message: Uint8Array) {
  const salt = new TextEncoder().encode(address)
  return Uint8Array.from(
    { length: 64 },
    (_, i) =>
      (((message[i % message.length] ?? 0) * 31 +
        (salt[i % salt.length] ?? 0) * 7 +
        i * 13) %
        255) +
      1,
  )
}

let submitted = 0

export async function mockSubmit() {
  submitted += 1
  return `MockSignature${submitted}`.padEnd(44, "1")
}
