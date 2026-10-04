import type { RevealRiskLevel } from "@/lib/api/schemas"

// The warning is written here, from the level the service reports. The service only
// sends a structured flag, and its text (if it ever sent any) is never shown.

// The 409 carries a code and no level, so before the person agrees the screen can
// only say that a link is possible.
export const acknowledgePrompt = {
  title: "This amount can be linked to a payment you received",
  body: "A withdrawal is public: anyone can read its amount on the chain. If it matches or comes close to a payment you were paid, they can connect the two, and that reveals how much the payment was.",
  hint: "A different amount may avoid a match. Or go ahead if you accept the link.",
  checkbox:
    "I understand this withdrawal can be linked to a payment I received.",
}

export type RiskView = {
  level: RevealRiskLevel
  label: string
  // For `none`, only a caveat: no match is not the same as private.
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
    explanation:
      "No match with what you received. A withdrawal is still public.",
    isWarning: false,
  },
}

// An unknown level never gets here: the schema reads it as `exact`, the safest class.
export function riskView(level: RevealRiskLevel): RiskView {
  return { level, ...views[level] }
}
