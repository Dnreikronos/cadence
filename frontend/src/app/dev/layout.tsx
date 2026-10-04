import { notFound } from "next/navigation"
import { devToolsEnabled } from "@/lib/dev-tools"
import { devToolsEnv } from "@/lib/dev-tools-env"

// Dev tooling renders fake data and is reachable without a session: a 404 on mainnet and,
// in a production build, unless NEXT_PUBLIC_DEV_TOOLS=1 (see `devToolsEnabled`). The
// middleware answers first; this is the second guard, for a request that reaches here.
export default function DevLayout({ children }: { children: React.ReactNode }) {
  if (!devToolsEnabled(devToolsEnv())) notFound()
  return children
}
