import { ArrowRight, BriefcaseBusiness, Eye, EyeOff, FileSignature, Landmark, ReceiptText, type LucideIcon } from "lucide-react"
import { formatUsd } from "./landing-data"
import { SectionFrame, SectionHeading } from "./SectionFrame"

export function SectionPrivate() {
  return (
    <SectionFrame id="private">
      <SectionHeading
        index="01"
        eyebrow="Private by default"
        title="Every amount you send, sealed."
        muted="Salaries, invoices, payouts and balances stay off the public record."
        aside={
          <a href="#faq" className="group/link inline-flex items-center gap-1.5 text-[14px] text-ink">
            <span className="link-underline pb-0.5">What stays public</span>
            <ArrowRight className="size-3.5 transition-transform duration-200 ease-[var(--ease-out)] group-hover/link:translate-x-0.5" />
          </a>
        }
      />
      <ul className="grid border-t border-line sm:grid-cols-2 lg:grid-cols-4">
        {cases.map((item) => (
          <li
            key={item.title}
            tabIndex={0}
            className="group/case relative flex flex-col border-line px-6 pt-8 pb-7 outline-none focus-visible:bg-white max-sm:not-last:border-b sm:px-8 sm:nth-[-n+2]:border-b sm:nth-[odd]:border-r lg:nth-[-n+2]:border-b-0 lg:not-last:border-r [@media(hover:hover)]:hover:bg-white"
          >
            <span
              aria-hidden
              className="absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-ink transition-transform duration-500 ease-[var(--ease-out)] group-hover/case:scale-x-100 group-focus-visible/case:scale-x-100"
            />
            <item.icon className="size-5 text-ink" strokeWidth={1.6} />
            <h3 className="mt-10 text-[17px] font-medium tracking-[-0.01em] text-ink">{item.title}</h3>
            <p className="mt-2 flex-1 text-[14.5px] leading-[1.55] text-ink-muted">{item.body}</p>

            <div className="mt-10 rounded-xl border border-line bg-white px-3.5 py-3 transition-[border-color,box-shadow] duration-300 group-hover/case:border-ink/15 group-hover/case:shadow-[0_12px_24px_-16px_rgba(20,20,10,0.3)]">
              <div className="flex items-center justify-between font-mono text-[11px] text-ink-muted">
                <span className="truncate">{item.line}</span>
                <span className="relative flex h-4 w-[84px] shrink-0 justify-end">
                  <ViewLabel icon={EyeOff} label="Public view" className="group-hover/case:opacity-0 group-hover/case:blur-[2px] group-focus-visible/case:opacity-0" />
                  <ViewLabel
                    icon={Eye}
                    label="Your view"
                    className="text-ink opacity-0 blur-[2px] group-hover/case:opacity-100 group-hover/case:blur-none group-focus-visible/case:opacity-100 group-focus-visible/case:blur-none"
                  />
                </span>
              </div>
              <p className="mt-1.5 font-mono text-[19px] font-medium tracking-[-0.02em] text-ink tabular-nums">
                <span className="inline-block opacity-55 blur-[6px] transition-[filter,opacity] duration-500 ease-[var(--ease-out)] select-none group-hover/case:opacity-100 group-hover/case:blur-none group-focus-visible/case:opacity-100 group-focus-visible/case:blur-none">
                  {formatUsd(item.amount)}
                </span>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </SectionFrame>
  )
}

function ViewLabel({ icon: Icon, label, className }: { icon: LucideIcon; label: string; className: string }) {
  return (
    <span className={`absolute right-0 flex items-center gap-1 whitespace-nowrap transition-[opacity,filter] duration-300 ${className}`}>
      <Icon className="size-3" /> {label}
    </span>
  )
}

const cases: { title: string; body: string; line: string; amount: number; icon: LucideIcon }[] = [
  { title: "Salaries", body: "Each person sees their own pay. Colleagues and competitors don't.", line: "Bruno · March", amount: 4200, icon: BriefcaseBusiness },
  { title: "Supplier invoices", body: "Other suppliers never learn what you pay this one.", line: "Northwind Audit", amount: 9500, icon: ReceiptText },
  { title: "Contractor payouts", body: "Freelancers can't price you off what your wallet shows.", line: "Diego · invoice 14", amount: 6300, icon: FileSignature },
  { title: "Treasury balance", body: "What you hold stays yours to know. Only deposits and withdrawals are public.", line: "Solaris · balance", amount: 84000, icon: Landmark },
]
