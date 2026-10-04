// Whether a click on a link leaves the page for another one in this app. A new tab, a
// download, a modified click, an in-page anchor or the same address do not.
export type LinkClick = {
  href: string | null
  target?: string | null
  download?: boolean
  button?: number
  modified?: boolean
  defaultPrevented?: boolean
}

export function leavesPage(click: LinkClick, current: string) {
  if (click.defaultPrevented || click.modified || click.download) return false
  if (click.button !== undefined && click.button !== 0) return false
  if (click.target && click.target !== "_self") return false
  if (!click.href) return false
  let to: URL
  let from: URL
  try {
    from = new URL(current)
    to = new URL(click.href, from)
  } catch {
    return false
  }
  // Another origin is a real navigation, which `beforeunload` already guards.
  if (to.origin !== from.origin) return false
  return to.pathname !== from.pathname || to.search !== from.search
}
