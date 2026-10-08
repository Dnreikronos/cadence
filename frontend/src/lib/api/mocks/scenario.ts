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
  // In a run: the network rejects the second payment (position 1) on its first
  // attempt, so the run stops there and a retry of it confirms.
  "partial-failure",
  // In a run: the second payment (position 1) cannot be prepared on its first
  // attempt; a retry prepares it.
  "prepare-failed",
  // Apply-pending finds a credit that arrived mid-flight.
  "credit-mismatch",
  // The chain read behind the public USDC balance fails, and /health answers
  // `unavailable`, as the service does when it cannot reach the RPC.
  "rpc-down",
  // The wallet refuses to sign, as when the person cancels the prompt: nothing is sent.
  "sign-cancelled",
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
