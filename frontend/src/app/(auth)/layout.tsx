import Link from "next/link"
import { Wordmark } from "@/components/ui/logo"

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center bg-canvas px-4 py-10">
      <Link href="/" aria-label="Cadence home">
        <Wordmark />
      </Link>
      <main className="my-auto w-full max-w-sm py-10">{children}</main>
    </div>
  )
}
