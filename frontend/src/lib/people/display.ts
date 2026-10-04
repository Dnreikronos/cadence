import type { Activation } from "./types"

// A dialog title has no room for a 200-character name.
export function shortName(name: string, max = 40) {
  const chars = Array.from(name)
  return chars.length <= max ? name : `${chars.slice(0, max - 1).join("")}…`
}

// Removal is final either way; what else it does depends on the invite.
export function removeDescription(activation: Activation) {
  const base =
    "Removal is final. They stop appearing in new payroll runs, payments already made stay in your history, and the email can't be added to your list again."
  if (activation === "invited" || activation === "invite-expired") {
    return `${base} Their pending invite stops working.`
  }
  return base
}
