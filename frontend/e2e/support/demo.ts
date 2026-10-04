import { expect, type Page } from "@playwright/test"

export type Role = "admin" | "recipient" | "auditor"

// The mock scenarios of `window.cadenceMock` (src/lib/api/mocks/scenario.ts).
export type Scenario =
  | "instant"
  | "slow"
  | "unauthenticated"
  | "rate-limited"
  | "service-down"
  | "setup-required"
  | "tx-failed"
  | "partial-failure"
  | "credit-mismatch"
  | "rpc-down"

declare global {
  interface Window {
    cadenceMock?: {
      set: (...names: Scenario[]) => void
      clear: () => void
      active: () => Scenario[]
      setRole: (role: Role | null) => void
      reset: () => void
    }
  }
}

export const homes: Record<Role, string> = {
  admin: "/company",
  recipient: "/me",
  auditor: "/audit",
}

// The demo panel's buttons (src/app/(auth)/demo-panel.tsx), by their visible titles.
const demoButtons: Record<Role, RegExp> = {
  admin: /^Company admin/,
  recipient: /^Recipient/,
  auditor: /^Auditor/,
}

export const demoEmails: Record<Role, string> = {
  admin: "ana@solaris.test",
  recipient: "bruno@solaris.test",
  auditor: "carla@acme-audit.test",
}

// Signs in through the demo panel, the way a person does, and waits for the role's area.
// `next` is not needed: a test that wants another page navigates there afterwards. The
// mock lives in the page's memory, so every full navigation starts from the seed data.
export async function signInAs(page: Page, role: Role) {
  await page.goto("/sign-in")
  await page.getByRole("button", { name: demoButtons[role] }).click()
  await page.waitForURL(`**${homes[role]}`)
}

// A recipient with nothing set up: "New recipient (shows activation)".
export async function freshRecipient(page: Page) {
  await page.goto("/sign-in")
  await page.getByRole("button", { name: /^New recipient/ }).click()
  await page.waitForURL("**/activate")
}

// Turns scenarios on (replacing the ones already on). `window.cadenceMock` exists once the
// page has made its first API call, so this waits for it. A full navigation (`page.goto`,
// a form post, a reload) resets the mock: set the scenario after the page you test has
// loaded, or after client-side navigation only.
export async function setMock(page: Page, ...scenarios: Scenario[]) {
  await page.waitForFunction(() => window.cadenceMock !== undefined)
  await page.evaluate((names) => window.cadenceMock?.set(...names), scenarios)
  await expect
    .poll(() => page.evaluate(() => window.cadenceMock?.active() ?? []))
    .toEqual(scenarios)
}

export async function clearMock(page: Page) {
  await page.waitForFunction(() => window.cadenceMock !== undefined)
  await page.evaluate(() => window.cadenceMock?.clear())
}

// A link of the sidebar (desktop viewport), by its label: a client-side navigation, so the
// mock keeps its scenarios.
export function navLink(page: Page, name: string) {
  return page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name, exact: true })
}

// The sidebar, with the private balance card (hidden below the lg breakpoint, where the
// drawer holds a second copy: tests of it run on a desktop viewport).
export function sidebar(page: Page) {
  return page.getByRole("complementary")
}

// A page must never scroll sideways: its content has to fit the viewport.
export async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const root = document.documentElement
          return {
            overflow: root.scrollWidth - root.clientWidth,
            body: document.body.scrollWidth - root.clientWidth,
          }
        }),
      { message: "the page scrolls horizontally" },
    )
    .toEqual({ overflow: 0, body: 0 })
}
