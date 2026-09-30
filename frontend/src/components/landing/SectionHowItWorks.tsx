import { SectionFrame, SectionHeading } from "./SectionFrame"
import { StepsDemo } from "./StepsDemo"

export function SectionHowItWorks() {
  return (
    <SectionFrame id="how">
      <SectionHeading
        index="04"
        eyebrow="How it works"
        title="Three steps. One approval."
        muted="No seed phrases or gas settings for anyone you pay."
      />
      <StepsDemo />
    </SectionFrame>
  )
}
