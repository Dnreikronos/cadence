// The first stop for a keyboard user: hidden until it has focus, then a way past the
// header and the navigation to the page. Points at the `main` that carries `mainId`.
export const mainId = "main"

export function SkipLink() {
  return (
    <a
      href={`#${mainId}`}
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-60 focus-visible:rounded-lg focus-visible:bg-ink focus-visible:px-4 focus-visible:py-2 focus-visible:text-ui focus-visible:font-medium focus-visible:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      Skip to content
    </a>
  )
}
