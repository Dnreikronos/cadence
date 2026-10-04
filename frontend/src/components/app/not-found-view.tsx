import Link from "next/link"
import { SearchX } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"

// A page that is not there, in the same neutral words whether it never existed or is
// not the viewer's to see (a run of another company): the copy never says which.
export function NotFoundView({
  href,
  label,
  className,
}: {
  href: string
  label: string
  className?: string
}) {
  return (
    <>
      {/* The page has no heading of its own: the card's title is a paragraph. */}
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        className={className}
        icon={SearchX}
        title="Page not found"
        description="This page doesn't exist, or it isn't available to your account."
        action={
          <Link href={href} className={buttonVariants()}>
            {label}
          </Link>
        }
      />
    </>
  )
}
