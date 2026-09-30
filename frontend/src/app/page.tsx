import { FooterLanding } from "@/components/landing/FooterLanding"
import { LandingMotion } from "@/components/landing/LandingMotion"
import { NavLanding } from "@/components/landing/NavLanding"
import { SectionAudit } from "@/components/landing/SectionAudit"
import { SectionChain } from "@/components/landing/SectionChain"
import { SectionFaq } from "@/components/landing/SectionFaq"
import { SectionHero } from "@/components/landing/SectionHero"
import { SectionHowItWorks } from "@/components/landing/SectionHowItWorks"
import { SectionPrivate } from "@/components/landing/SectionPrivate"
import { SectionVault } from "@/components/landing/SectionVault"

export default function Home() {
  return (
    <div className="min-h-screen bg-canvas bg-[radial-gradient(circle_at_center,color-mix(in_oklab,var(--ink)_9%,transparent)_1px,transparent_1px)] [background-size:12px_12px]">
      <LandingMotion />
      <NavLanding />
      <main>
        <SectionHero />
        <SectionPrivate />
        <SectionVault />
        <SectionChain />
        <SectionHowItWorks />
        <SectionAudit />
        <SectionFaq />
      </main>
      <FooterLanding />
    </div>
  )
}
