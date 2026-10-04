// Switches that make the mock service misbehave on purpose, so every screen can
// be exercised against the failures that change its UI. Several can be active.
export const scenarioNames = [
  // Confirm answers right away instead of "not finalized" twice.
  "instant",
  // Every response takes a second and a half (`timing.slowMs`).
  "slow",
  "unauthenticated",
  "rate-limited",
  // Every route answers 503 `service_unavailable`.
  "service-down",
  // Every route answers 503 `auth_unavailable`: the sign-in provider is down.
  "auth-down",
  // /wrap needs the activation artifacts first.
  "setup-required",
  // Every confirm is rejected by the network.
  "tx-failed",
  // In a run: payment 2 fails and payment 3 expires on their first attempt, so
  // a retry of either confirms. The rest confirm.
  "partial-failure",
  // Apply-pending finds a credit that arrived mid-flight.
  "credit-mismatch",
  // The chain read behind the public USDC balance fails (not a proof-service call).
  "rpc-down",
] as const
export type Scenario = (typeof scenarioNames)[number]

// A knob so a test does not wait out the real delay.
export const timing = { slowMs: 1500 }

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
