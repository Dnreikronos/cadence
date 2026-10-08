import type { Metadata } from "next"
import { Instrument_Sans, JetBrains_Mono } from "next/font/google"
import { connection } from "next/server"
import { ClusterBadge } from "@/components/app/cluster-badge"
import { Providers } from "./providers"
import "./globals.css"

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
  axes: ["wdth"],
  style: "normal",
})
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  style: "normal",
})

export const metadata: Metadata = {
  // Each screen names itself (`metadata` in its page); the landing page and anything
  // without a name are just "Cadence".
  title: { template: "%s · Cadence", default: "Cadence" },
  description:
    "Confidential USDC payments for teams, freelancers and suppliers.",
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Every page renders per request, so its scripts carry the nonce the middleware minted
  // for it (src/lib/security-headers.ts). A prerendered page would carry none, and the
  // policy would block its scripts.
  await connection()
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} ${jetbrainsMono.variable}`}
    >
      <body className="antialiased">
        <Providers>{children}</Providers>
        <ClusterBadge />
      </body>
    </html>
  )
}
