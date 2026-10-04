import { describe, expect, it } from "vitest"
import { base58FromBytes } from "../base58"
import { signatureSchema } from "../schemas"
import { ME_WALLET } from "./db"
import { mockSignature, mockSigner } from "./signer"

const message = new TextEncoder().encode("a message to sign")

describe("mockSigner.signMessage", () => {
  it("returns 64 bytes that depend on the signer and the message", async () => {
    const bruno = mockSigner(ME_WALLET)
    const first = await bruno.signMessage!(message)
    expect(first).toHaveLength(64)
    expect(await bruno.signMessage!(message)).toEqual(first)
    expect(await bruno.signMessage!(Uint8Array.of(1, 2, 3))).not.toEqual(first)
    expect(
      await mockSigner("4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5")
        .signMessage!(message),
    ).not.toEqual(first)
  })

  it("is never all zero, even for an empty message", () => {
    expect(mockSignature(ME_WALLET, new Uint8Array())).toHaveLength(64)
    expect(
      mockSignature(ME_WALLET, new Uint8Array()).every((b) => b === 0),
    ).toBe(false)
  })

  it("encodes to a signature the contract accepts", async () => {
    const signature = base58FromBytes(
      await mockSigner(ME_WALLET).signMessage!(message),
    )
    expect(signatureSchema.safeParse(signature).success).toBe(true)
  })
})

describe("base58FromBytes", () => {
  it("writes bytes the way Solana does", () => {
    expect(base58FromBytes(Uint8Array.of(0, 0, 1))).toBe("112")
    expect(base58FromBytes(new TextEncoder().encode("hello"))).toBe("Cn8eVZg")
  })

  it("stays within the 88 characters of the contract for 64 bytes of 255", () => {
    expect(base58FromBytes(new Uint8Array(64).fill(255))).toHaveLength(88)
  })
})
