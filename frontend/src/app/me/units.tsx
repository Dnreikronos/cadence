import { AmountDisplay } from "@/components/ui/amount-display"
import { exactUsdc, isSubCent } from "@/lib/me/amount"
import { unitsToUsd } from "@/lib/money"
import { cn } from "@/lib/utils"

// An amount in base units. A dollar figure rounds to cents, so one below a cent is
// written out exactly instead of reading as "$0.00".
export function Units({
  units,
  className,
}: {
  units: string
  className?: string
}) {
  if (isSubCent(units)) {
    return (
      <span className={cn("font-mono text-ink tabular-nums", className)}>
        {exactUsdc(units)}
      </span>
    )
  }
  return <AmountDisplay amount={unitsToUsd(units)} className={className} />
}
