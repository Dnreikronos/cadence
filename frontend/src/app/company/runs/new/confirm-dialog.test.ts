import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { PayrollPerson } from "@/lib/runs/plan"

// The real config is read from the environment at import.
vi.mock("@/lib/api/mode", () => ({ apiConfig: { mode: "real", baseUrl: "" } }))

const { RecipientList } = await import("./confirm-dialog")

const person = (name: string, tokenAccount: string | null): PayrollPerson => ({
  id: `id-${name}`,
  name,
  email: `${name}@example.test`,
  kind: "employee",
  activation: "active",
  amount: "4200000000",
  tokenAccount,
})

const BRUNO = "GREQiTSSJfaTNi9k7B8Etk1JmDgPUek1GXChFWscp1Gh"

describe("RecipientList", () => {
  it("shows the whole account each payment goes to, under the name", () => {
    const html = renderToStaticMarkup(
      createElement(RecipientList, { recipients: [person("Bruno", BRUNO)] }),
    )
    expect(html).toContain("Bruno")
    expect(html).toContain(BRUNO)
    expect(html).toMatch(/To account/)
  })

  it("names no account for someone without one", () => {
    const html = renderToStaticMarkup(
      createElement(RecipientList, { recipients: [person("Mariana", null)] }),
    )
    expect(html).toContain("Mariana")
    expect(html).not.toMatch(/To account/)
  })
})
