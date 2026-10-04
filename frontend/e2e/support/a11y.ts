import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"

// Accessibility violations that exist today and are not fixed in this suite's pull
// request. Each entry names the screen and the axe rule, so nothing is hidden: the pull
// request lists them as follow-ups, and an entry is deleted when its fix lands (a stale
// entry shows up as a note on the test run). `screen` is the `name` in support/screens.ts,
// or a dialog's name below.
export type KnownIssue = { screen: string; rule: string; note: string }

export const knownIssues: KnownIssue[] = []

const failing = new Set(["serious", "critical"])

// Runs axe on the page as it is now and fails on any serious or critical violation that
// is not in the allow-list. Moderate and minor ones are reported as test annotations.
export async function expectNoSeriousA11yViolations(
  page: Page,
  screen: string,
  viewport: "desktop" | "mobile",
) {
  // A dialog that is still fading in has half-transparent text: wait for every finite
  // animation and transition to end (a spinner never does, and is left alone).
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  )
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()

  const allowed = knownIssues.filter((issue) => issue.screen === screen)
  const serious = violations.filter((v) => failing.has(v.impact ?? ""))
  const unexpected = serious.filter(
    (v) => !allowed.some((issue) => issue.rule === v.id),
  )

  for (const issue of allowed) {
    if (!serious.some((v) => v.id === issue.rule)) {
      test.info().annotations.push({
        type: "stale a11y allow-list entry",
        description: `${issue.screen}: ${issue.rule} no longer occurs (${viewport}); remove it`,
      })
    }
  }
  for (const v of violations.filter((v) => !failing.has(v.impact ?? ""))) {
    test.info().annotations.push({
      type: "a11y (not failing)",
      description: `${screen} (${viewport}): ${v.id} [${v.impact}] on ${v.nodes.length} node(s)`,
    })
  }

  expect(
    unexpected.map((v) => ({
      rule: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.map((node) => node.target.join(" ")),
    })),
    `serious accessibility violations on ${screen} (${viewport})`,
  ).toEqual([])
}
