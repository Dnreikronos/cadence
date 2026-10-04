import { Landmark } from "lucide-react"

// Names are examples of exchanges that serve Brazil, not endorsements, and Cadence
// quotes no rate or fee for any of them (PRD): that leg is the person's own.
const exchanges = ["Mercado Bitcoin", "Foxbit", "Bitso", "Binance"]

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
        Once the USDC is in your wallet, you can sell it for reais at an
        exchange that serves Brazil and pays out by Pix.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Example exchanges">
        {exchanges.map((name) => (
          <li
            key={name}
            className="rounded-full border border-line bg-surface-subtle px-3 py-1 text-caption text-ink"
          >
            {name}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-caption/normal text-ink-muted">
        These are examples, not recommendations. Check that the exchange you
        pick accepts USDC on Solana.
      </p>
      <p className="mt-3 rounded-lg border border-line bg-surface-subtle p-3 text-ui/normal text-ink">
        This step is yours. You sell on your own account at that exchange, at
        its rate. Cadence does not quote a rate or take part in the sale.
      </p>
    </section>
  )
}
