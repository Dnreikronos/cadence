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
import { homeFor } from "@/lib/auth/guard"
import { currentViewer } from "@/lib/auth/viewer"

// Public for everyone; a signed-in member is offered their dashboard.
export default async function Home() {
  const viewer = await currentViewer()
  return (
    <div className="min-h-screen bg-canvas">
      <LandingMotion />
      <NavLanding home={viewer && homeFor(viewer.membership.role)} />
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
