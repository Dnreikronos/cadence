import type { Signer } from "../sign"

// Stand-ins for the Turnkey signer (#77) and the RPC submit, so a screen can run
// the whole prepare, sign, confirm flow before either exists.
export function mockSigner(address: string): Signer {
  return {
    address,
    signTransaction: async (transaction) =>
      Uint8Array.from([...transaction, 1]),
  }
}

let submitted = 0
export async function mockSubmit() {
  submitted += 1
  return `MockSignature${submitted}`.padEnd(44, "1")
}
