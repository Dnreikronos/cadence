import {
  clearMock,
  freshRecipient,
  navLink,
  setMock,
  signInAs,
} from "./support/demo"
import { expect, test } from "./support/test"
import type { Page } from "@playwright/test"

const setUp = (page: Page) =>
  page.getByRole("button", { name: "Set up my account" })

const step = (page: Page, title: string) =>
  page.getByRole("listitem").filter({ hasText: title })

async function openFresh(page: Page) {
  await freshRecipient(page)
  await expect(page.getByRole("heading", { name: "Your setup" })).toBeVisible()
  await expect(setUp(page)).toBeEnabled()
}

test("a new recipient completes the setup and lands on their balance", async ({
  page,
}) => {
  await openFresh(page)
  await expect(step(page, "Create your wallet")).toContainText("not started")
  await setMock(page, "instant")

  await setUp(page).click()

  await expect(
    page.getByRole("heading", { name: "You're all set" }),
  ).toBeVisible()
  for (const title of [
    "Create your wallet",
    "Create your balance key",
    "Turn on private payments",
  ]) {
    await expect(step(page, title)).toContainText("done")
  }
  await page.getByRole("link", { name: "Go to your balance" }).click()
  await expect(page).toHaveURL("/me")
  await expect(
    page.getByRole("banner").getByText("Recipient", { exact: true }),
  ).toBeVisible()
})

test("resumes where it stopped after a failure at the last step", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409, /\/accounts\/configure\/confirm$/)
  await openFresh(page)
  // Every confirm is rejected: the wallet and the key steps do not confirm, the last does.
  await setMock(page, "instant", "tx-failed")

  await setUp(page).click()

  await expect(
    page.getByText("Turn on private payments didn't finish"),
  ).toBeVisible()
  await expect(page.getByText("Steps already done stay done.")).toBeVisible()
  await expect(step(page, "Create your wallet")).toContainText("done")
  await expect(step(page, "Create your balance key")).toContainText("done")
  await expect(step(page, "Turn on private payments")).toContainText("failed")

  await clearMock(page)
  await setMock(page, "instant")
  await page.getByRole("button", { name: "Try again" }).click()

  await expect(
    page.getByRole("heading", { name: "You're all set" }),
  ).toBeVisible()
  await expect(step(page, "Turn on private payments")).toContainText("done")
})

test("someone who is not set up is sent from their balance to the setup", async ({
  page,
}) => {
  await openFresh(page)

  await navLink(page, "Balance").click()

  await expect(page).toHaveURL("/activate")
  await expect(page.getByRole("heading", { name: "Your setup" })).toBeVisible()
})

test("a recipient who is set up sees that, not the steps again", async ({
  page,
}) => {
  await signInAs(page, "recipient")

  await page.goto("/activate")

  await expect(
    page.getByRole("heading", { name: "You're already set up" }),
  ).toBeVisible()
  await expect(setUp(page)).toHaveCount(0)
})
