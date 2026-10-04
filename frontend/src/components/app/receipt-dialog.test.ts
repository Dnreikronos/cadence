import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Dialog } from "@base-ui/react/dialog"
import { describe, expect, it, vi } from "vitest"
import type { PaymentItem } from "@/lib/api/schemas"
import {
  ReceiptBody,
  ReceiptContent,
  receiptPopupProps,
} from "./receipt-dialog"

// The real config is read from the environment at import.
vi.mock("@/lib/api/mode", () => ({ apiConfig: { mode: "real", baseUrl: "" } }))

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
    hasAuditor?: boolean
    company?: string
    mock?: boolean
  } = {},
) {
  return renderToStaticMarkup(
    createElement(ReceiptBody, {
      role: props.role ?? "admin",
      cluster: props.cluster ?? "devnet",
      mock: props.mock ?? false,
      hasAuditor: props.hasAuditor,
      company: props.company,
      payment: { ...base, ...payment },
    }),
  )
}

// The popup is rendered inside an open dialog root, without the portal.
function renderPopup(payment: Partial<PaymentItem> = {}) {
  return renderToStaticMarkup(
    createElement(
      Dialog.Root,
      { open: true },
      createElement(ReceiptContent, {
        role: "admin",
        payment: { ...base, ...payment },
        onClose() {},
      }),
    ),
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
    expect(render({}, { role: "admin", hasAuditor: false })).toContain(
      "Your company, the recipient and Cadence can read this amount",
    )
    expect(render({}, { role: "recipient", hasAuditor: false })).toContain(
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

  it("keeps the explorer link to signatures of the right length and alphabet", () => {
    const valid88 = "5".repeat(88)
    expect(render({ signature: valid88 })).toContain(
      `href="https://explorer.solana.com/tx/${valid88}?cluster=devnet"`,
    )
    for (const signature of ["A".repeat(31), "A".repeat(129)]) {
      const html = render({ signature })
      expect(html, String(signature.length)).toContain(signature)
      expect(html, String(signature.length)).not.toContain(
        "explorer.solana.com",
      )
    }
  })

  describe("who can read the amount", () => {
    it("never says an encrypted amount can be read by the public", () => {
      const html = render()
      expect(html).toContain("ciphertext")
      expect(html).toContain("Who can see this amount")
    })

    it("says only that a transparent amount is public, with no ciphertext and no readers popover", () => {
      const html = render({ transparent: true })
      expect(html).toContain("its amount is public on-chain")
      expect(html).not.toContain("ciphertext")
      expect(html).not.toContain("The public cannot")
      expect(html).not.toContain("can read this amount")
      expect(html).not.toContain("Who can see this amount")
    })

    it("names the auditor when there is one", () => {
      expect(render({}, { hasAuditor: true })).toContain(
        "Your company, the recipient, your auditor and Cadence can read this amount",
      )
      expect(render({}, { hasAuditor: false })).toContain(
        "Your company, the recipient and Cadence can read this amount",
      )
    })

    it("does not claim there is no auditor while that is not known", () => {
      const html = render({}, { hasAuditor: undefined })
      expect(html).toContain(
        "Your company, the recipient, anyone your company has designated and Cadence can read this amount",
      )
      expect(
        render({}, { role: "recipient", hasAuditor: undefined }),
      ).toContain("anyone the company has designated")
    })
  })

  describe("company", () => {
    it("names who paid, for a reader whose item names only the payee", () => {
      for (const role of ["admin", "auditor"] as const) {
        const html = render({}, { role, company: "Solaris" })
        expect(html, role).toContain("Paid by")
        expect(html, role).toContain("Solaris")
        expect(html, role).toContain("Paid to")
      }
    })

    it("leaves it out for a recipient, whose counterparty already is the company", () => {
      const html = render(
        { counterparty: { ...base.counterparty, name: "Solaris" } },
        { role: "recipient", company: "Solaris" },
      )
      expect(html.match(/Solaris/g)).toHaveLength(1)
    })

    it("adds no line when it is not given", () => {
      expect(render()).not.toContain("Paid by")
    })
  })

  describe("test data line for print", () => {
    it("marks devnet and mock builds, so a paper copy cannot pass for a real one", () => {
      expect(render({}, { cluster: "devnet" })).toContain("Devnet: test funds")
      const mock = render({}, { cluster: "devnet", mock: true })
      expect(mock).toContain("Mock data")
      expect(mock).toContain("Devnet: test funds")
      // Drawn on paper only.
      expect(mock).toMatch(/class="[^"]*\bhidden\b[^"]*print:block[^"]*"/)
    })

    it("prints nothing extra on mainnet with the real service", () => {
      const html = render({}, { cluster: "mainnet", mock: false })
      expect(html).not.toContain("test funds")
      expect(html).not.toContain("Mock data")
    })
  })
})

describe("ReceiptContent", () => {
  it("marks the popup for the print styles, which lay it out on paper", () => {
    expect(receiptPopupProps["data-receipt-print"]).toBe(true)
    const classes = receiptPopupProps.className.split(" ")
    for (const paper of ["print:static", "print:w-full", "print:shadow-none"]) {
      expect(classes, paper).toContain(paper)
    }
  })

  it("hides every copy button and the explorer link on paper", () => {
    const html = renderPopup({ run_id: runId })
    const copyButtons = html.match(/aria-label="Copy [^"]+"/g) ?? []
    expect(copyButtons).toHaveLength(3)
    const insideHidden =
      html.match(/<span class="print:hidden"><button[^>]*aria-label="Copy /g) ??
      []
    expect(insideHidden).toHaveLength(copyButtons.length)
    expect(html).toMatch(/<a href="https:\/\/explorer[^>]*print:hidden/)
    // Close and Download are not part of the receipt either.
    expect(html).toMatch(/print:hidden"><button[^>]*>Close/)
  })

  it("says what the payment is without claiming it was sent when it was not", () => {
    expect(renderPopup()).toContain("Encrypted transfer.")
    expect(renderPopup({ transparent: true })).toContain(
      "Ordinary transfer, public on-chain.",
    )
    for (const status of ["pending", "failed"] as const) {
      const html = renderPopup({ status, signature: null })
      expect(html, status).not.toMatch(/\bSent\b/)
      expect(html, status).not.toContain("Encrypted transfer.")
    }
    expect(renderPopup({ status: "pending" })).toContain(
      "Waiting for the network to confirm.",
    )
    expect(renderPopup({ status: "failed" })).toContain(
      "This payment did not go through.",
    )
  })
})
