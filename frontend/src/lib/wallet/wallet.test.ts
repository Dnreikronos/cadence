import { describe, expect, it, vi } from "vitest"
import { base64FromBytes } from "@/lib/api/base64"
import {
  mockAccountTransaction,
  recordOnMockChain,
} from "@/lib/api/mocks/chain"
import { COMPANY_WALLET, ME_WALLET } from "@/lib/api/mocks/db"
import type { Receipt } from "@/lib/api/schemas"
import type { SignStep } from "@/lib/api/sign"
import { mockWalletFor } from "./mock"
import { bindSignAndConfirm } from "./sign-and-confirm"
import { settleWallet } from "./settle"
import {
  WalletUnavailableError,
  realModeReason,
  unavailableWallet,
} from "./types"

const receipt: Receipt = {
  request_id: "a".repeat(64),
  signature: "MockSignature1".padEnd(44, "1"),
  slot: 1,
  status: "finalized",
}
const prepared = (signer: string) => ({
  transaction: base64FromBytes(
    mockAccountTransaction({ kind: "apply-pending", wallet: signer, n: 1 }),
  ),
  required_signers: [signer],
})

// A confirm that lands the transaction on the mock network, as the mock service does.
const landing = () =>
  vi.fn(async (signature: string) => {
    recordOnMockChain(signature, "finalized")
    return receipt
  })

describe("unavailableWallet", () => {
  it("is unavailable and refuses to sign or submit, naming the reason", async () => {
    const wallet = unavailableWallet(realModeReason)
    expect(wallet).toMatchObject({ status: "unavailable", loading: false })
    await expect(
      wallet.signer.signTransaction(Uint8Array.of(1)),
    ).rejects.toThrow(/#78.*#80/)
    await expect(wallet.submit(Uint8Array.of(1))).rejects.toThrow(
      WalletUnavailableError,
    )
  })

  it("can say it is still loading", () => {
    expect(unavailableWallet("soon", true).loading).toBe(true)
  })
})

describe("mockWalletFor", () => {
  it("gives the company admin the company wallet", () => {
    const wallet = mockWalletFor("admin")
    expect(wallet).toMatchObject({ status: "ready", loading: false })
    expect(wallet.address).toBe(COMPANY_WALLET)
    expect(wallet.signer.address).toBe(COMPANY_WALLET)
  })

  it("gives the recipient their own wallet", () => {
    const wallet = mockWalletFor("recipient")
    expect(wallet.status).toBe("ready")
    expect(wallet.address).toBe(ME_WALLET)
    expect(wallet.signer.address).toBe(ME_WALLET)
  })

  it("leaves the auditor without a wallet", async () => {
    const wallet = mockWalletFor("auditor")
    expect(wallet.status).toBe("unavailable")
    expect(wallet.address).toBe("")
    await expect(
      wallet.signer.signTransaction(Uint8Array.of(1)),
    ).rejects.toThrow(/auditors do not hold a wallet/)
  })

  it("signs and submits like the real flow will", async () => {
    const wallet = mockWalletFor("admin")
    const signed = await wallet.signer.signTransaction(Uint8Array.of(1, 2))
    expect([...signed]).toEqual([1, 2, 1])
    expect(await wallet.submit(signed)).toMatch(/^MockSignature\d+A1*$/)
  })
})

describe("bindSignAndConfirm", () => {
  it("signs, submits and confirms with the wallet's signer, reporting each step", async () => {
    const run = bindSignAndConfirm(mockWalletFor("recipient"))
    const steps: SignStep[] = []
    const confirm = landing()
    const result = await run(prepared(ME_WALLET), confirm, (s) => steps.push(s))
    expect(result).toBe(receipt)
    expect(steps).toEqual(["signing", "submitting", "confirming"])
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]).toEqual([
      expect.stringMatching(/^MockSignature/),
    ])
  })

  it("refuses a request for anyone else's signature", async () => {
    const run = bindSignAndConfirm(mockWalletFor("recipient"))
    const confirm = vi.fn(async () => receipt)
    await expect(run(prepared(COMPANY_WALLET), confirm)).rejects.toThrow(
      /not yours/,
    )
    expect(confirm).not.toHaveBeenCalled()
  })

  it("passes options such as a signal through", async () => {
    const run = bindSignAndConfirm(mockWalletFor("admin"))
    const confirm = vi.fn(async () => receipt)
    const controller = new AbortController()
    controller.abort(new Error("stopped"))
    await expect(
      run(prepared(COMPANY_WALLET), confirm, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("stopped")
  })

  it("fails with the wallet's reason before asking anything of the service", async () => {
    const run = bindSignAndConfirm(unavailableWallet(realModeReason))
    const confirm = vi.fn(async () => receipt)
    const onStep = vi.fn()
    await expect(run(prepared(ME_WALLET), confirm, onStep)).rejects.toThrow(
      /#78.*#80/,
    )
    expect(onStep).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe("settleWallet", () => {
  it("passes a loaded wallet through", async () => {
    const wallet = mockWalletFor("admin")
    expect(await settleWallet(Promise.resolve(wallet))).toBe(wallet)
  })

  it("turns a failed load into an unavailable wallet with the reason", async () => {
    const wallet = await settleWallet(
      Promise.reject(new Error("Loading chunk 42 failed")),
    )
    expect(wallet).toMatchObject({ status: "unavailable", loading: false })
    expect(wallet.reason).toMatch(/failed to load: Loading chunk 42 failed/)
    await expect(
      wallet.signer.signTransaction(Uint8Array.of(1)),
    ).rejects.toThrow(/failed to load/)
  })

  it("copes with a rejection that is not an Error", async () => {
    const wallet = await settleWallet(Promise.reject("offline"))
    expect(wallet.status).toBe("unavailable")
    expect(wallet.reason).toMatch(/failed to load/)
  })
})
