import { Landmark } from "lucide-react"

// Cadence names no exchange or service and quotes no rate or fee (PRD): this leg is the person's own.
export function CashOutPanel() {
  return (
    <section
      aria-labelledby="cash-out-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <h2
        id="cash-out-heading"
        className="flex items-center gap-2 text-lead font-medium text-ink"
      >
        <Landmark aria-hidden className="size-4 text-ink-muted" />
        Cash out to reais
      </h2>
      <p className="mt-2 text-ui/normal text-ink-muted">
        Once the USDC is in your wallet, you can cash it out through an exchange
        or service you already use that supports Brazil and pays out by Pix.
      </p>
      <p className="mt-3 rounded-lg border border-line bg-surface-subtle p-3 text-ui/normal text-ink">
        This step is yours. You do it on your own account, at that
        service&apos;s rate. Cadence does not hold reais, convert currency or
        start a Pix payment, and it quotes no rate or fee.
      </p>
    </section>
  )
}
