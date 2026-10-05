import {
  ArrowUpFromLine,
  EyeOff,
  Fingerprint,
  Mail,
  Plus,
  Power,
  type LucideIcon,
} from "lucide-react"
import { SectionFrame, SectionHeading } from "./SectionFrame"

export function SectionFaq() {
  return (
    <SectionFrame id="faq">
      <div className="grid lg:grid-cols-12">
        <div className="lg:col-span-5">
          <SectionHeading
            index="06"
            eyebrow="Straight answers"
            title="What we hide,"
            muted="and what we don't."
          />
        </div>
        <div className="border-line px-6 pb-16 sm:px-12 lg:col-span-7 lg:border-l lg:pt-28 lg:pb-24">
          <div className="divide-y divide-line border-y border-line">
            {faqs.map((faq, index) => (
              <details
                key={faq.question}
                className="faq group"
                open={index === 0}
              >
                <summary className="flex cursor-pointer list-none items-center gap-4 rounded-lg py-5 text-[16px] font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink/30 [&::-webkit-details-marker]:hidden">
                  <faq.icon
                    className="size-4 shrink-0 text-ink-muted transition-colors duration-200 group-open:text-ink"
                    strokeWidth={1.75}
                  />
                  <span className="flex-1">{faq.question}</span>
                  <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line text-ink-muted transition-[transform,background-color,color,border-color] duration-200 ease-out group-open:rotate-45 group-open:border-ink group-open:bg-ink group-open:text-white group-hover:border-ink/20 group-hover:text-ink">
                    <Plus className="size-3.5" />
                  </span>
                </summary>
                <p className="faq-answer max-w-140 pb-6 pl-8 text-[15px] leading-[1.65] text-ink-muted">
                  {faq.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </SectionFrame>
  )
}

const faqs: { question: string; answer: string; icon: LucideIcon }[] = [
  {
    question: "Can Cadence see my amounts?",
    icon: EyeOff,
    answer:
      "Yes. Cadence generates the proofs, so it holds viewing keys and can read amounts. Payments are signed in your wallet, and Cadence is not designed to hold your funds or store your signing key. Viewing keys are encrypted at rest, and reads are meant to be recorded in an audit log with who and why.",
  },
  {
    question: "Is this anonymous?",
    icon: Fingerprint,
    answer:
      "No. Amounts and balances are encrypted. Wallet addresses, the token, and the fact that Solaris paid Bruno stay public. It is confidentiality, the way a bank works: the bank and the accountant know, the neighbour doesn't.",
  },
  {
    question: "When does an amount become public?",
    icon: ArrowUpFromLine,
    answer:
      "Deposits into private USDC and withdrawals out of it are public. Everything in between is sealed. If someone withdraws exactly what they were paid, an observer can infer it, so Cadence warns before that happens.",
  },
  {
    question: "What does someone need to get paid?",
    icon: Mail,
    answer:
      "An email. They sign in with it, and a wallet is created for them behind the scenes, without a seed phrase in sight.",
  },
  {
    question: "What if Solana switches confidential transfers off?",
    icon: Power,
    answer:
      "Payments keep going out as ordinary transfers. Getting paid never depends on confidentiality being available.",
  },
]
