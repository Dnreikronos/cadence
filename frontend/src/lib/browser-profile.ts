import type { SubmissionStorage } from "./submissions"

// One browser profile for tests: a store every "tab" shares, with a view per tab. A write
// through one tab tells the other tabs' subscribers (what the `storage` event does), never
// its own.
export function browserProfile() {
  const items = new Map<string, string>()
  const tabs: { listeners: Set<(key: string | null) => void> }[] = []
  const tell = (from: object | null, key: string | null) => {
    for (const tab of tabs) {
      if (tab === from) continue
      for (const listener of [...tab.listeners]) listener(key)
    }
  }
  return {
    items,
    tab(): SubmissionStorage {
      const me = { listeners: new Set<(key: string | null) => void>() }
      tabs.push(me)
      return {
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => {
          items.set(key, value)
          tell(me, key)
        },
        removeItem: (key) => {
          if (items.delete(key)) tell(me, key)
        },
        keys: () => [...items.keys()],
        subscribe: (listener) => {
          me.listeners.add(listener)
          return () => void me.listeners.delete(listener)
        },
      }
    },
    // What clearing the whole store does to the others.
    wipe() {
      items.clear()
      tell(null, null)
    },
  }
}
