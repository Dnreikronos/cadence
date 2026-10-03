"use client"

import { QRCodeSVG } from "qrcode.react"
import { ButtonCopy } from "@/components/ui/button-copy"
import { cluster } from "@/lib/solana/cluster"

export function ReceiveSection({ walletAddress }: { walletAddress: string }) {
  return (
    <section
      aria-labelledby="receive-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <StepHeading n={1} id="receive-heading">
        Send USDC to your company wallet
      </StepHeading>
      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="shrink-0 self-start rounded-lg border border-line bg-white p-2.5">
          <QRCodeSVG
            value={walletAddress}
            size={132}
            level="M"
            title="QR code of the company wallet address"
          />
        </div>
        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-label text-ink-muted uppercase">
              Wallet address
            </p>
            <div className="mt-1.5 flex items-start gap-2">
              <p className="min-w-0 font-mono text-ui/normal break-all text-ink">
                {walletAddress}
              </p>
              <ButtonCopy
                value={walletAddress}
                label="Copy wallet address"
                toastTitle="Address copied"
              />
            </div>
          </div>
          <p className="text-ui/normal text-ink-muted">
            Send {cluster.isMainnet ? "USDC" : "Circle devnet USDC"} on Solana{" "}
            {cluster.name} only, from any wallet or exchange. Other tokens or
            networks can be lost for good. The wallet also needs a little SOL
            for network fees.
          </p>
        </div>
      </div>
    </section>
  )
}

export function StepHeading({
  n,
  id,
  children,
}: {
  n: number
  id: string
  children: React.ReactNode
}) {
  return (
    <h2 id={id} className="flex items-center gap-2.5 text-body font-medium">
      <span
        aria-hidden
        className="grid size-5 place-items-center rounded-full bg-ink font-mono text-[11px] text-glow"
      >
        {n}
      </span>
      {children}
    </h2>
  )
}
