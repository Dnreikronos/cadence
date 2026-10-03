// Switches that make the mock service misbehave on purpose, so every screen can
// be exercised against the failures that change its UI. Several can be active.
export const scenarioNames = [
  // Confirm answers right away instead of "not finalized" twice.
  "instant",
  // Every response takes a second and a half.
  "slow",
  "unauthenticated",
  "rate-limited",
  "service-down",
  // /wrap needs the activation artifacts first.
  "setup-required",
  // Every confirm is rejected by the network.
  "tx-failed",
  // In a run: payment 2 fails, payment 3 expires, the rest confirm.
  "partial-failure",
  // Apply-pending finds a credit that arrived mid-flight.
  "credit-mismatch",
] as const
export type Scenario = (typeof scenarioNames)[number]

const active = new Set<Scenario>()

export const scenarios = {
  has: (name: Scenario) => active.has(name),
  set: (...names: Scenario[]) => {
    active.clear()
    for (const name of names) active.add(name)
  },
  clear: () => active.clear(),
  list: () => [...active],
}

export function isScenario(value: string): value is Scenario {
  return (scenarioNames as readonly string[]).includes(value)
}
