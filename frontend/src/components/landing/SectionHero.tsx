import Link from "next/link"
import { ArrowLeftRight, ArrowRight, Binary, Eye, KeyRound, Scale, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { buttonPrimary, buttonSecondary, iconNudge } from "./button-styles"
import { HeroGlass } from "./HeroGlass"
import { HeroProduct } from "./HeroProduct"
import { SplitWords } from "./LandingMotion"

export function SectionHero() {
  return (
    <section className="border-b border-line">
      <div className="relative mx-auto max-w-[1248px] border-x border-line bg-white">
        <GridCells />
        <div className="relative px-6 pt-16 text-center sm:pt-24">
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase" data-reveal>
            Confidential payments on Solana
          </p>
          <h1 className="font-display mx-auto mt-6 max-w-[820px] text-[46px] leading-[0.98] font-semibold tracking-[-0.032em] text-balance text-ink sm:text-[76px]">
            <SplitWords>Private dollars on a public chain.</SplitWords>
          </h1>
          <p className="mx-auto mt-7 max-w-[560px] text-[17px] leading-[1.6] text-ink-muted sm:text-[18px]" data-reveal>
            Cadence seals the amount of every USDC payment your company sends. The people you choose can read it.
            Everyone else sees that a payment happened, and nothing more.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3" data-reveal>
            <Link href="/sign-in" className={buttonPrimary}>
              Start paying privately <ArrowRight className={cn("size-4", iconNudge)} />
            </Link>
            <a href="#vault" className={buttonSecondary}>
              <Eye className="size-4 text-ink-muted group-hover/btn:scale-110" /> See who sees what
            </a>
          </div>
        </div>
        <div className="relative mt-6 sm:mt-2" data-reveal>
          <HeroGlass />
        </div>
        <dl className="relative grid grid-cols-2 border-t border-line lg:grid-cols-4">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className="group/fact border-line px-6 py-7 not-last:border-r max-lg:nth-2:border-r-0 max-lg:nth-[-n+2]:border-b sm:px-10"
            >
              <dt className="flex items-center gap-2 text-[13px] text-ink-muted">
                <fact.icon className="size-4 transition-transform duration-300 ease-[var(--ease-out)] group-hover/fact:-translate-y-0.5" strokeWidth={1.75} />
                {fact.label}
              </dt>
              <dd className="mt-3 font-mono text-[26px] font-medium tracking-[-0.03em] text-ink tabular-nums">
                {fact.count === undefined ? fact.text : <span data-count={fact.count}>{fact.count.toLocaleString("en-US")}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <div className="relative border-t border-line px-3 pt-12 pb-12 sm:px-10 sm:pt-16 sm:pb-16" data-reveal>
          <HeroProduct />
        </div>
      </div>
    </section>
  )
}

function GridCells() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[640px] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_30%,transparent)]">
      <div className="absolute inset-0 bg-[linear-gradient(var(--color-line)_1px,transparent_1px),linear-gradient(90deg,var(--color-line)_1px,transparent_1px)] [background-position:-1px_-1px] [background-size:64px_64px] opacity-70" />
      {cells.map(([column, row, delay]) => (
        <span
          key={`${column}-${row}`}
          className="absolute size-[63px] animate-[cell_7s_ease-in-out_infinite] bg-ink/[0.035]"
          style={{ left: column * 64, top: row * 64, animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  )
}

const cells: [number, number, number][] = [
  [1, 1, 0], [2, 3, 2.4], [3, 0, 4.1], [5, 2, 1.2], [14, 1, 3.3], [16, 3, 0.6], [17, 0, 5.2], [15, 5, 2], [0, 4, 4.6], [18, 6, 1.7],
]

const facts: { label: string; count?: number; text?: string; icon: LucideIcon }[] = [
  { label: "Transactions per payment", count: 1, icon: ArrowLeftRight },
  { label: "Bytes per sealed payment", count: 2897, icon: Binary },
  { label: "Signing keys we hold", count: 0, icon: KeyRound },
  { label: "USDC backing", text: "1:1", icon: Scale },
]
