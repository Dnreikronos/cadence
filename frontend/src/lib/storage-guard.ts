import { persisted } from "./submissions"

// A money flow that cannot keep a record of what it sent must not send in real mode: a
// reload would forget a transaction that may have landed, and the same money could go
// out twice. In the mock nothing real moves, so the screen only warns.

export const storageBlockedMessage =
  "Your browser is blocking storage, so Cadence cannot safely send this: enable site storage or leave private browsing"

export type ApiMode = "mock" | "real"

export class StorageUnavailableError extends Error {
  constructor() {
    super(storageBlockedMessage)
    this.name = "StorageUnavailableError"
  }
}

// What a screen shows before anything is started: `blocks` refuses the start (real
// mode), `warns` says so without refusing (mock mode).
export function storageGate(
  mode: ApiMode,
  probe: () => boolean = persisted,
): { ok: boolean; blocks: boolean; warns: boolean } {
  const ok = probe()
  return { ok, blocks: !ok && mode === "real", warns: !ok && mode === "mock" }
}

// For the moment just before the send: a record that did not reach storage (or storage
// that stopped working since the probe) stops a real-mode flow before `submit` runs.
export function requireDurable(
  mode: ApiMode,
  stored: boolean | (() => boolean) = persisted,
) {
  const ok = typeof stored === "function" ? stored() : stored
  if (!ok && mode === "real") throw new StorageUnavailableError()
}
