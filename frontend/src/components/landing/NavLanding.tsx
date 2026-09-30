import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { buttonVariants, iconNudge } from "@/components/ui/button"
import { Wordmark } from "@/components/ui/logo"

export function NavLanding() {
  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-white/95 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-[1248px] items-center justify-between border-x border-line px-6">
        <Link href="/">
          <Wordmark />
        </Link>
        <ul className="hidden items-center gap-8 text-sm text-ink-muted md:flex">
          {links.map((link) => (
            <li key={link.href}>
              <a href={link.href} className="link-underline pb-0.5 hover:text-ink">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-5">
          <Link href="/sign-in" className="link-underline hidden pb-0.5 text-sm text-ink-muted hover:text-ink sm:block">
            Sign in
          </Link>
          <Link href="/sign-in" className={buttonVariants({ className: "gap-1.5 pr-3.5 pl-4 text-sm" })}>
            Start paying <ArrowRight className={cn("size-3.5", iconNudge)} />
          </Link>
        </div>
      </nav>
      <span data-progress className="absolute bottom-[-1px] left-0 h-px w-full origin-left scale-x-0 bg-ink" aria-hidden />
    </header>
  )
}

const links = [
  { href: "#private", label: "Product" },
  { href: "#how", label: "How it works" },
  { href: "#audit", label: "Auditors" },
  { href: "#faq", label: "FAQ" },
]
