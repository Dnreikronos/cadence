// Two letters for the avatar. Names come from the company, so they can be empty or odd.
export function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
  return Array.from(letters).slice(0, 2).join("").toUpperCase() || "?"
}
