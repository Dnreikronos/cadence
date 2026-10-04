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

// Base58 has no "0", so a plain counter turned invalid at the tenth signature and every
// confirm after it was refused. Digits 1 to 9 only, still one per call.
function digits(n: number) {
  let out = ""
  for (let rest = n; rest > 0; rest = Math.floor(rest / 9)) {
    rest -= 1
    out = String((rest % 9) + 1) + out
  }
  return out
}

let submitted = 0
export async function mockSubmit() {
  submitted += 1
  // The letter ends the number, or 1, 11 and 111 would pad out to the same signature.
  return `MockSignature${digits(submitted)}A`.padEnd(44, "1")
}
