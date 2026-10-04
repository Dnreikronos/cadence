import { getBase58Decoder } from "@solana/kit"

// Solana's text form of a signature or key. (The codec calls bytes -> text "decode".)
export function base58FromBytes(bytes: Uint8Array): string {
  return getBase58Decoder().decode(bytes)
}
