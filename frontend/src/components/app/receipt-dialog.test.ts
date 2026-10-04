import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { PaymentItem } from "@/lib/api/schemas"
import { ReceiptBody } from "./receipt-dialog"

const signature = "5SigMockSignature1111111111111111111111111111"
const runId = "c1000000-0000-4000-8000-000000000009"

const base: PaymentItem = {
  payment_id: "b0000000-0000-4000-8000-000000000001",
  run_id: null,
  counterparty: {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "Bruno Costa",
  },
  amount: "4200500000",
  status: "confirmed",
  transparent: false,
  paid_at: "2026-09-01T12:30:00Z",
  signature,
}

function render(
  payment: Partial<PaymentItem> = {},
  props: {
    role?: "admin" | "recipient" | "auditor"
    cluster?: "devnet" | "mainnet"
  } = {},
) {
  return renderToStaticMarkup(
    createElement(ReceiptBody, {
      role: props.role ?? "admin",
      cluster: props.cluster ?? "devnet",
      payment: { ...base, ...payment },
    }),
  )
}

describe("ReceiptBody", () => {
  it("shows the payment: who, how much, status, when and the signature", () => {
    const html = render()
    expect(html).toContain("Paid to")
    expect(html).toContain("Bruno Costa")
    expect(html).toContain("$4,200.50")
    // The exact amount, which the cents above would round.
    expect(html).toContain("4200.5 USDC")
    expect(html).toContain("Confirmed")
    expect(html).toContain('dateTime="2026-09-01T12:30:00Z"')
    expect(html).toContain(base.payment_id)
    expect(html).toContain(signature)
  })

  it("links the signature to the explorer for the cluster, in a new tab", () => {
    expect(render({}, { cluster: "devnet" })).toContain(
      `href="https://explorer.solana.com/tx/${signature}?cluster=devnet"`,
    )
    const mainnet = render({}, { cluster: "mainnet" })
    expect(mainnet).toContain(
      `href="https://explorer.solana.com/tx/${signature}"`,
    )
    expect(mainnet).toContain('rel="noopener noreferrer"')
    expect(mainnet).toContain('target="_blank"')
  })

  it("says a payment with no signature is not on the network, and links nothing", () => {
    const html = render({ signature: null, status: "pending" })
    expect(html).toContain("Not on the network yet")
    expect(html).toContain("Pending")
    expect(html).not.toContain("explorer.solana.com")
  })

  it("does not turn an odd signature into a link, but still shows it", () => {
    const html = render({ signature: "not a signature" })
    expect(html).toContain("not a signature")
    expect(html).not.toContain("explorer.solana.com")
  })

  it("labels the counterparty by who is reading", () => {
    expect(render({}, { role: "admin" })).toContain("Paid to")
    expect(render({}, { role: "auditor" })).toContain("Paid to")
    const recipient = render({}, { role: "recipient" })
    expect(recipient).toContain("Paid by")
    expect(recipient).not.toContain("Paid to")
  })

  it("names the readers of the amount for the viewer's role, Cadence among them", () => {
    expect(render({}, { role: "admin" })).toContain(
      "Your company, the recipient and Cadence can read this amount",
    )
    expect(render({}, { role: "recipient" })).toContain(
      "You, the company that paid you and Cadence can read this amount",
    )
  })

  it("flags a transparent payment and says its amount is public", () => {
    const transparent = render({ transparent: true })
    expect(transparent).toContain("Transparent")
    expect(transparent).toContain("its amount is public on-chain")
    const encrypted = render({ transparent: false })
    expect(encrypted).not.toContain("Transparent")
    expect(encrypted).not.toContain("is public on-chain")
  })

  it("shows the payroll run only when the payment belongs to one", () => {
    expect(render()).not.toContain("Payroll run")
    const html = render({ run_id: runId })
    expect(html).toContain("Payroll run")
    expect(html).toContain(runId)
  })

  it("offers copy buttons for the identifiers", () => {
    const html = render({ run_id: runId })
    for (const label of ["Copy payment ID", "Copy signature", "Copy run ID"]) {
      expect(html).toContain(`aria-label="${label}"`)
    }
  })

  it("lets a long name wrap instead of widening the receipt", () => {
    const html = render({
      counterparty: { ...base.counterparty, name: "x".repeat(200) },
    })
    expect(html).toContain("x".repeat(200))
    expect(html).toMatch(/class="[^"]*wrap-break-word[^"]*"[^>]*>x{200}/)
  })
})
