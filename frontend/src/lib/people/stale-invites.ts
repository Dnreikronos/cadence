import { useSyncExternalStore } from "react"

// People whose email changed while an invite was out. The table keeps that
// invite (an admin cannot delete it), so the row would keep saying "Invite sent"
// for a link that no longer works. This remembers, for this tab, that it needs a
// new one; a reload forgets, because nothing in the table says it.
const stale = new Set<string>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function markInviteStale(personId: string) {
  if (stale.has(personId)) return
  stale.add(personId)
  emit()
}

export function clearInviteStale(personId: string) {
  if (stale.delete(personId)) emit()
}

export function isInviteStale(personId: string) {
  return stale.has(personId)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useInviteStale(personId: string) {
  return useSyncExternalStore(
    subscribe,
    () => stale.has(personId),
    () => false,
  )
}
