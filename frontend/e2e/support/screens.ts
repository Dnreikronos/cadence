import { expect, type Locator, type Page } from "@playwright/test"
import { freshRecipient, signInAs, type Role } from "./demo"

// The main screens of the merged work, for the specs that visit every one of them
// (responsive, a11y). `ready` is what proves the data has loaded; `primary` is the
// action a person came to the screen for. When a new screen merges (for example
// /me/history), add it here and both specs cover it.
export type Screen = {
  name: string
  role: Role | "new-recipient" | null
  path: string
  ready: (page: Page) => Locator
  primary: ((page: Page) => Locator) | null
}

const main = (page: Page) => page.getByRole("main")

export const screens: Screen[] = [
  {
    name: "sign-in",
    role: null,
    path: "/sign-in",
    ready: (page) => page.getByRole("heading", { name: "Try the demo" }),
    primary: (page) => page.getByRole("button", { name: /^Company admin/ }),
  },
  {
    name: "company payments",
    role: "admin",
    path: "/company",
    ready: (page) => main(page).getByText("Northwind Audit"),
    primary: (page) => page.getByRole("link", { name: "New payroll run" }),
  },
  {
    name: "company people",
    role: "admin",
    path: "/company/people",
    ready: (page) => main(page).getByText("Northwind Audit"),
    primary: (page) => page.getByRole("button", { name: "Add person" }),
  },
  {
    name: "company deposit",
    role: "admin",
    path: "/company/deposit",
    ready: (page) => main(page).getByText("$12,500.00"),
    primary: (page) => page.getByRole("button", { name: "Make private" }),
  },
  {
    name: "new payroll run",
    role: "admin",
    path: "/company/runs/new",
    ready: (page) => page.getByRole("button", { name: /^Pay 3 people/ }),
    primary: (page) => page.getByRole("button", { name: /^Pay 3 people/ }),
  },
  {
    name: "company receipts",
    role: "admin",
    path: "/company/receipts",
    ready: (page) => main(page).getByText("4 payments"),
    primary: (page) => page.getByRole("button", { name: "Export CSV" }),
  },
  {
    name: "company auditors",
    role: "admin",
    path: "/company/auditors",
    ready: (page) => main(page).getByText("3 auditors"),
    primary: (page) => page.getByRole("button", { name: "Invite auditor" }),
  },
  {
    name: "activation",
    role: "new-recipient",
    path: "/activate",
    ready: (page) => page.getByRole("heading", { name: "Your setup" }),
    primary: (page) => page.getByRole("button", { name: "Set up my account" }),
  },
  {
    // The balance and history screen (task H) replaces this placeholder; give it a
    // `primary` then.
    name: "recipient home",
    role: "recipient",
    path: "/me",
    ready: (page) => main(page).getByRole("heading", { level: 1 }),
    primary: null,
  },
  {
    name: "recipient withdraw",
    role: "recipient",
    path: "/me/withdraw",
    ready: (page) => main(page).getByText("$8,000.00").first(),
    primary: (page) =>
      page.getByRole("button", { name: "Withdraw", exact: true }),
  },
  {
    name: "audit payments",
    role: "auditor",
    path: "/audit",
    ready: (page) => main(page).getByText("Northwind Audit"),
    primary: (page) =>
      page.getByRole("button", { name: "Export all payments (CSV)" }),
  },
  {
    name: "audit access log",
    role: "auditor",
    path: "/audit/access-log",
    ready: (page) => main(page).getByRole("table", { name: "Access log" }),
    primary: (page) => page.getByRole("button", { name: "Load more" }),
  },
]

// Signs in as the screen's role (when it has one), opens it and waits until it has loaded.
export async function openScreen(page: Page, screen: Screen) {
  if (screen.role === "new-recipient") {
    await freshRecipient(page)
  } else {
    if (screen.role) await signInAs(page, screen.role)
    await page.goto(screen.path)
  }
  await expect(screen.ready(page).first()).toBeVisible()
}
