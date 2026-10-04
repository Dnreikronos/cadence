"use client"

import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { apiConfig } from "@/lib/api/mode"
import type { Role } from "@/lib/auth/guard"
import { bindSignAndConfirm } from "./sign-and-confirm"
import { realModeReason, unavailableWallet, type Wallet } from "./types"

// The literal check on the mode is what lets Next inline it, as in lib/api/index.ts:
// a real-mode build drops the import and the mock wallet never reaches the bundle.
function loadMockWallet(role: Role): Promise<Wallet> | null {
  if (
    process.env.NEXT_PUBLIC_API_MODE !== "real" &&
    apiConfig.mode === "mock"
  ) {
    return import("./mock").then((m) => m.mockWalletFor(role))
  }
  return null
}

const WalletContext = createContext<Wallet | null>(null)

// Mounted in the signed-in shell, with the role the server resolved. In mock mode
// the wallet is the demo role's mock signer, ready a moment after mount while the
// mock module loads; in real mode it stays unavailable until #78 and #80.
export function WalletProvider({
  role,
  children,
}: {
  role: Role
  children: React.ReactNode
}) {
  const [loaded, setLoaded] = useState<{ role: Role; wallet: Wallet } | null>(
    null,
  )

  useEffect(() => {
    let current = true
    loadMockWallet(role)?.then((wallet) => {
      if (current) setLoaded({ role, wallet })
    })
    return () => {
      current = false
    }
  }, [role])

  const wallet = useMemo(() => {
    if (apiConfig.mode !== "mock") return unavailableWallet(realModeReason)
    if (loaded?.role === role) return loaded.wallet
    return unavailableWallet("the mock wallet is still loading", true)
  }, [loaded, role])

  return <WalletContext value={wallet}>{children}</WalletContext>
}

export function useWallet(): Wallet {
  const wallet = useContext(WalletContext)
  if (!wallet) throw new Error("useWallet must be used inside a WalletProvider")
  return wallet
}

// `await run(prepared, confirm, onStep)`: sign with the wallet, submit, then confirm.
export function useSignAndConfirm() {
  const wallet = useWallet()
  return useMemo(() => bindSignAndConfirm(wallet), [wallet])
}
