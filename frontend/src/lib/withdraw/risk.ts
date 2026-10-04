import type { RevealRiskLevel } from "@/lib/api/schemas"

// The warning is written here, from the level the service reports. The service only
// sends a structured flag, and its text (if it ever sent any) is never shown.

// The 409 carries a code and no level, so before the person agrees the screen can
// only say that a link is possible.
export const acknowledgePrompt = {
  title: "This amount can be linked to a payment you received",
  body: "A withdrawal is public: anyone can read its amount on the chain. If it matches or comes close to a payment you were paid, they can connect the two, and that reveals how much the payment was.",
  hint: "To avoid this, change the amount above. Or go ahead if you accept the link.",
  checkbox:
    "I understand this withdrawal can be linked to a payment I received.",
}

export type RiskView = {
  level: RevealRiskLevel
  label: string
  // Empty for `none`: no match, no warning.
  explanation: string
  isWarning: boolean
}

const views: Record<RevealRiskLevel, Omit<RiskView, "level">> = {
  exact: {
    label: "Exact match",
    explanation:
      "This amount is the same as a payment you received, so anyone reading the chain can link the two.",
    isWarning: true,
  },
  near: {
    label: "Close match",
    explanation:
      "This amount is close to a payment you received, so someone reading the chain could link the two.",
    isWarning: true,
  },
  none: {
    label: "No match",
    explanation: "",
    isWarning: false,
  },
}

// An unknown level reads as `exact`, the safest class (API contract, "Evolving the contract").
export function riskView(level: string): RiskView {
  const known: RevealRiskLevel =
    level === "none" || level === "near" ? level : "exact"
  return { level: known, ...views[known] }
}
