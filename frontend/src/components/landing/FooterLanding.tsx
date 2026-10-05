import Link from "next/link"
import { ArrowRight, ArrowUpRight, BookOpenText } from "lucide-react"
import { cn } from "@/lib/utils"
import { buttonVariants, iconNudge } from "@/components/ui/button"
import { SplitWords } from "./LandingMotion"
import { SealGuilloche } from "./SealGuilloche"

export function FooterLanding() {
  return (
    <footer>
      <div className="mx-auto max-w-312 overflow-hidden border-x border-line bg-surface px-3 pt-3 sm:px-6 sm:pt-6">
        <div className="relative overflow-hidden rounded-[24px] bg-night px-6 py-20 text-white sm:px-14 sm:py-28">
          <FlowLines />
          <div
            aria-hidden
            className="absolute top-1/2 -right-40 size-160 -translate-y-1/2 sm:-right-24"
            data-parallax="0.08"
          >
            <SealGuilloche
              className="size-full animate-[spin_120s_linear_infinite] text-glow/25"
              rings={10}
            />
          </div>
          <div className="absolute inset-0 bg-linear-to-r from-night via-night/80 to-transparent" />
          <div className="relative max-w-140">
            <p className="text-eyebrow tracking-[0.14em] text-white/50">
              Pilot program
            </p>
            <h2 className="font-display mt-5 text-[40px] leading-[0.98] font-semibold tracking-[-0.04em] sm:text-[64px]">
              <SplitWords>Make your next payment private.</SplitWords>
            </h2>
            <p
              className="mt-6 max-w-110 text-lead leading-[1.6] text-white/60"
              data-reveal
            >
              Free for pilot companies while we onboard the first teams. Your
              first private payment takes about ten minutes to set up.
            </p>
            <div className="mt-9 flex flex-wrap gap-3" data-reveal>
              <Link
                href="/sign-up"
                className={buttonVariants({
                  size: "lg",
                  className: "bg-white text-ink hover:bg-white/90",
                })}
              >
                Start a pilot <ArrowRight className={cn("size-4", iconNudge)} />
              </Link>
              <a
                href="#faq"
                className={buttonVariants({
                  variant: "secondary",
                  size: "lg",
                  className:
                    "border-white/20 bg-transparent text-white hover:border-white/50",
                })}
              >
                <BookOpenText
                  className="size-4 opacity-70"
                  strokeWidth={1.75}
                />{" "}
                Read the straight answers
              </a>
            </div>
          </div>
        </div>

        <div className="grid gap-10 px-3 pt-16 pb-12 text-sm sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <p className="max-w-[320px] text-ink-muted">
              Cadence does not custody your funds or store your signing keys.
              Built on Solana Token-2022 confidential balances.
            </p>
          </div>
          {columns.map((column) => (
            <div key={column.title}>
              <p className="text-eyebrow tracking-widest text-ink-muted">
                {column.title}
              </p>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="group/link inline-flex items-center gap-1 text-ink"
                    >
                      <span className="link-underline pb-0.5">
                        {link.label}
                      </span>
                      <ArrowUpRight className="size-3.5 -translate-x-1 translate-y-1 opacity-0 transition-[opacity,translate] duration-200 ease-out group-hover/link:translate-0 group-hover/link:opacity-100" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p
          aria-hidden
          className="font-display mb-[-3vw] bg-[radial-gradient(circle_at_center,color-mix(in_oklab,var(--ink)_30%,transparent)_1.6px,transparent_1.8px)] bg-size-[9px_9px] bg-clip-text text-center text-[25vw] leading-[0.8] font-semibold tracking-[-0.07em] text-transparent select-none lg:text-[300px]"
        >
          cadence
        </p>
      </div>
    </footer>
  )
}

function FlowLines() {
  return (
    <svg
      aria-hidden
      className="absolute inset-0 size-full"
      preserveAspectRatio="none"
      viewBox="0 0 1200 520"
    >
      {[80, 150, 220, 290, 360, 430].map((y, index) => (
        <path
          key={y}
          d={`M-20 ${y} C 300 ${y}, 520 ${260 + (y - 260) * 0.25}, 1220 ${260 + (y - 260) * 0.25}`}
          fill="none"
          stroke="white"
          strokeOpacity={0.09 + (index % 2) * 0.05}
          strokeWidth={1}
          strokeDasharray="2 8"
          className="motion-safe:animate-[dash-flow_2.4s_linear_infinite]"
          style={{ animationDuration: `${2 + index * 0.35}s` }}
        />
      ))}
    </svg>
  )
}

const columns = [
  {
    title: "Product",
    links: [
      { label: "Who sees what", href: "#vault" },
      { label: "How it works", href: "#how" },
      { label: "Auditors", href: "#audit" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "FAQ", href: "#faq" },
      { label: "Sign in", href: "/sign-in" },
    ],
  },
]
