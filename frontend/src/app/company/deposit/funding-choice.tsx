import type { FundingMode } from "@/lib/deposit/make-private"

export function FundingChoice({
  mode,
  onChange,
  disabled,
}: {
  mode: FundingMode
  onChange: (mode: FundingMode) => void
  disabled: boolean
}) {
  return (
    <fieldset
      disabled={disabled}
      className="mt-5 space-y-2 disabled:opacity-60"
    >
      <legend className="mb-2 text-ui font-medium">How to fund payments</legend>
      {(
        [
          [
            "confidential",
            "Private balance",
            "Make USDC private for confidential payments.",
          ],
          [
            "public",
            "Public payment reserve",
            "Keep a visible reserve for payments during a privacy-service outage.",
          ],
        ] as const
      ).map(([value, title, hint]) => (
        <label
          key={value}
          className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-ui/normal"
        >
          <input
            type="radio"
            name="funding-mode"
            value={value}
            checked={mode === value}
            onChange={() => onChange(value)}
            className="mt-1 accent-primary"
          />
          <span>
            <span className="block font-medium">{title}</span>
            <span className="text-ink-muted">{hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}
