import Link from "next/link"
import { NotFoundView } from "@/components/app/not-found-view"
import { Wordmark } from "@/components/ui/logo"
import { SkipLink, mainId } from "@/components/ui/skip-link"

export default function NotFound() {
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
        <NotFoundView href="/" label="Back to the home page" />
      </main>
    </div>
  )
}
