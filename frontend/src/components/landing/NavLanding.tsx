import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { buttonPrimary, iconNudge } from "./button-styles"

export function NavLanding() {
  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-white/95 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-[1248px] items-center justify-between border-x border-line px-6">
        <Link href="/" className="font-display flex items-center gap-2 text-[21px] font-semibold tracking-[-0.04em] text-ink">
          <LogoMark className="size-[18px] text-ink" />
          cadence
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
          <Link href="/sign-in" className={cn(buttonPrimary, "h-9 gap-1.5 pr-3.5 pl-4 text-sm")}>
            Start paying <ArrowRight className={cn("size-3.5", iconNudge)} />
          </Link>
        </div>
      </nav>
      <span data-progress className="absolute bottom-[-1px] left-0 h-px w-full origin-left scale-x-0 bg-ink" aria-hidden />
    </header>
  )
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 1.75a8.25 8.25 0 0 0 0 16.5Z" fill="currentColor" />
    </svg>
  )
}

const links = [
  { href: "#private", label: "Product" },
  { href: "#how", label: "How it works" },
  { href: "#audit", label: "Auditors" },
  { href: "#faq", label: "FAQ" },
]
