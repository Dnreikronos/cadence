"use client"

import { TurnkeyProvider } from "@turnkey/react-wallet-kit"

// No Auth Proxy: login goes through our own route, so only the parent organization id is needed.
const config = { organizationId: process.env.NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID }

export function Providers({ children }) {
  return <TurnkeyProvider config={config}>{children}</TurnkeyProvider>
}
