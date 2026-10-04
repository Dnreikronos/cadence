import Link from "next/link"
import { Wordmark } from "@/components/ui/logo"
import { SkipLink, mainId } from "@/components/ui/skip-link"

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center bg-canvas px-4 py-10">
      <SkipLink />
      <Link href="/" aria-label="Cadence home">
        <Wordmark />
      </Link>
      <main
        id={mainId}
        tabIndex={-1}
        className="my-auto w-full max-w-sm py-10 outline-none"
      >
        {children}
      </main>
    </div>
  )
}
