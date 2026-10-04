// What saving a file needs from the browser, so a test can stand in for it.
export type DownloadEnv = {
  document: Pick<Document, "createElement" | "body">
  url: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">
}

// "cadence-payments-2026-10-04.csv": the day in the viewer's own calendar.
export function datedFilename(
  prefix: string,
  extension: string,
  date = new Date(),
): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${prefix}-${day}.${extension}`
}

// Hands a Blob to the browser's download, which a request with a bearer token
// cannot do through a plain link.
export function saveBlob(
  blob: Blob,
  filename: string,
  env: DownloadEnv = { document, url: URL },
) {
  const url = env.url.createObjectURL(blob)
  const link = env.document.createElement("a")
  link.href = url
  link.download = filename
  env.document.body.append(link)
  link.click()
  link.remove()
  // Some browsers start the download after click returns.
  setTimeout(() => env.url.revokeObjectURL(url), 10_000)
}
