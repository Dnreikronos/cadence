"use client"

import { useSyncExternalStore } from "react"
import { apiConfig } from "@/lib/api/mode"
import { storageGate } from "./storage-guard"

const noop = () => () => {}

// Whether this browser can keep a record of what is sent (see `storage-guard.ts`): `blocks`
// in real mode, where the screen refuses to start; `warns` in the mock, where it only says
// so. The server render assumes it can, so the first paint matches.
export function useStorageGate() {
  const mode = apiConfig.mode
  const state = useSyncExternalStore(
    noop,
    () => {
      const gate = storageGate(mode)
      return gate.blocks ? "blocks" : gate.warns ? "warns" : "ok"
    },
    () => "ok",
  )
  return { blocks: state === "blocks", warns: state === "warns" }
}
