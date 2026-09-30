import { NoiseTexture } from "@/components/ui/noise-texture"
import { SectionHeading } from "./SectionFrame"
import { VaultKeys } from "./VaultKeys"

export function SectionVault() {
  return (
    <section id="vault" className="perforated relative overflow-hidden bg-night pb-24 text-white sm:pb-32">
      <NoiseTexture className="opacity-[0.22] mix-blend-soft-light" frequency={0.85} />
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.07)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_50%_70%,#000,transparent_70%)]"
      />
      <div className="relative mx-auto max-w-[1248px] border-x border-white/[0.07]">
        <SectionHeading
          index="02"
          eyebrow="Who sees what"
          title="One ledger. Four keys."
          muted="What you can read depends on the key you hold."
          isDark
        />
        <div className="px-4 sm:px-12" data-reveal>
          <VaultKeys />
        </div>
      </div>
    </section>
  )
}
