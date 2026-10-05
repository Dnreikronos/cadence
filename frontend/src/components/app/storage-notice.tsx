"use client"

import { storageBlockedMessage } from "@/lib/storage-guard"
import { useStorageGate } from "@/lib/use-storage-gate"
import { cn } from "@/lib/utils"

// Says that this browser cannot keep a record of what is sent. In real mode that refuses
// the start (the screen disables its button too); in the mock it only warns, because
// nothing real moves.
export function StorageNotice({ className }: { className?: string }) {
  const gate = useStorageGate()
  if (gate.blocks) {
    return (
      <p
        role="alert"
        className={cn("text-ui/normal text-danger-fg", className)}
      >
        {storageBlockedMessage}.
      </p>
    )
  }
  if (gate.warns) {
    return (
      <p
        role="status"
        className={cn("text-ui/normal text-warning-fg", className)}
      >
        {storageBlockedMessage}. This is the demo, so nothing real is sent; with
        real money Cadence would refuse.
      </p>
    )
  }
  return null
}
