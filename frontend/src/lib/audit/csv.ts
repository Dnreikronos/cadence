// "cadence-audit-solaris-2026-10-04.csv": the company, so exports of two audits do not collide.
export function csvFilename(company: string, now: Date) {
  const slug =
    company
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "company"
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-")
  return `cadence-audit-${slug}-${day}.csv`
}

export const REVOKE_AFTER_MS = 10_000

// The export needs the bearer header, so it arrives as a Blob and is saved from here.
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.rel = "noopener"
  document.body.append(link)
  link.click()
  link.remove()
  // Some browsers read the blob after the click returns: revoking at once can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}
