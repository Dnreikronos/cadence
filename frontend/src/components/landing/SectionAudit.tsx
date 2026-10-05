import { FileKey2, ScrollText } from "lucide-react"
import { ReceiptPrint } from "./ReceiptPrint"
import { SectionFrame, SectionHeading } from "./SectionFrame"

const facts = [
  { label: "Viewing keys", value: "Encrypted at rest", icon: FileKey2 },
  {
    label: "Every decryption",
    value: "Meant to be logged",
    icon: ScrollText,
  },
]

export function SectionAudit() {
  return (
    <SectionFrame id="audit">
      <div className="grid lg:grid-cols-12">
        <div className="flex flex-col justify-between lg:col-span-6">
          <SectionHeading
            index="05"
            eyebrow="For your accountant"
            title="Hidden from the world."
            muted="Never from the books. Your auditor reads every amount, and every read, ours included, is meant to be logged."
          />
          <dl className="grid grid-cols-2 border-t border-line" data-reveal>
            {facts.map((fact) => (
              <div
                key={fact.label}
                className="border-line px-6 py-7 not-last:border-r sm:px-12"
              >
                <dt className="flex gap-3 text-ui text-ink-muted">
                  <fact.icon
                    className="mt-0.5 size-4 shrink-0 text-ink"
                    strokeWidth={1.75}
                  />
                  {fact.label}
                </dt>
                <dd className="mt-1 pl-7 text-[15px] text-ink">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="border-line bg-canvas px-6 py-16 max-lg:border-t sm:px-12 lg:col-span-6 lg:border-l lg:py-24">
          <ReceiptPrint />
        </div>
      </div>
    </SectionFrame>
  )
}
