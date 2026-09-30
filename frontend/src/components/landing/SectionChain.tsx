import { CompareChain } from "./CompareChain"
import { SectionFrame, SectionHeading } from "./SectionFrame"

export function SectionChain() {
  return (
    <SectionFrame>
      <SectionHeading
        index="03"
        eyebrow="What the chain sees"
        title="Public ledger. Private amounts."
        muted="Same payment, seen twice. Only the amount differs."
      />
      <CompareChain />
    </SectionFrame>
  )
}
