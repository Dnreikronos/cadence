import { viewerScopeId, type Viewer } from "./submissions"

// One tab at a time may send, or check what it sent, for a viewer's flow. Saved records
// are per tab, so a second tab cannot see the first one's: without this it could prepare
// and send the very amount or run the first has in flight. A Web Lock held for the whole
// window (from the prepare to the confirmation, and while saved records are looked up)
// is the mechanism. Where `navigator.locks` is missing, a BroadcastChannel ping only
// warns: it cannot be relied on to stop anything.

export type Lease = { release: () => void }

export type Acquired =
  | { status: "held"; lease: Lease }
  // Another tab holds it: refuse to start.
  | { status: "busy" }
  // No lock to take, and another tab answered a ping: warn, and go on.
  | { status: "maybe-busy"; lease: Lease }

// What a screen shows about the other tabs: "busy" refuses, "maybe" (no Web Locks, only a
// ping answered) warns.
export type OtherTab = "busy" | "maybe" | null

export type LockManagerLike = {
  request: (
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<void> | void,
  ) => Promise<unknown>
}

export type ChannelLike = {
  postMessage: (message: unknown) => void
  addEventListener: (
    type: "message",
    listener: (e: { data: unknown }) => void,
  ) => void
  close: () => void
}

export type LockEnv = {
  locks?: LockManagerLike | null
  channel?: (name: string) => ChannelLike | null
  // How long the fallback waits for another tab to answer.
  askMs?: number
  sleep?: (ms: number) => Promise<void>
}

export const flowLockName = (kind: string, viewer: Viewer) =>
  `cadence:flow:${kind}:${viewerScopeId(viewer)}`

export const otherTabMessage = (what: "withdrawal" | "run") =>
  `Another tab is sending or checking a ${what} for this account: wait for it to finish.`

export function browserLockEnv(): LockEnv {
  if (typeof navigator === "undefined") return {}
  return {
    locks:
      "locks" in navigator
        ? (navigator.locks as unknown as LockManagerLike)
        : null,
    channel: (name) =>
      typeof BroadcastChannel === "undefined"
        ? null
        : (new BroadcastChannel(name) as unknown as ChannelLike),
  }
}

const noLease: Lease = { release: () => {} }

// Takes the lock if it is free right now; never waits for it. The lease releases it once
// (further calls do nothing). A lock held by a tab that closes is released by the browser.
export async function acquireFlowLock(
  name: string,
  env: LockEnv = browserLockEnv(),
): Promise<Acquired> {
  if (env.locks) {
    try {
      return await new Promise<Acquired>((resolve, reject) => {
        env
          .locks!.request(name, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve({ status: "busy" })
              return
            }
            // The callback's promise is the lock: it is held until this settles.
            return new Promise<void>((done) => {
              let released = false
              resolve({
                status: "held",
                lease: {
                  release: () => {
                    if (released) return
                    released = true
                    done()
                  },
                },
              })
            })
          })
          .catch(reject)
      })
    } catch {
      // A lock manager that refuses (an insecure page) is as good as none.
    }
  }
  return fallback(name, env)
}

// Only a warning: ask whether another tab is holding the flow, answer others while this
// one does.
async function fallback(name: string, env: LockEnv): Promise<Acquired> {
  const channel = env.channel?.(name) ?? null
  if (!channel) return { status: "held", lease: noLease }
  let heard = false
  let holding = false
  channel.addEventListener("message", (event) => {
    const type = (event.data as { type?: unknown } | null)?.type
    if (type === "busy") heard = true
    if (type === "ask" && holding) channel.postMessage({ type: "busy" })
  })
  channel.postMessage({ type: "ask" })
  const sleep =
    env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  await sleep(env.askMs ?? 250)
  holding = true
  let released = false
  const lease: Lease = {
    release: () => {
      if (released) return
      released = true
      holding = false
      channel.close()
    },
  }
  return heard ? { status: "maybe-busy", lease } : { status: "held", lease }
}
