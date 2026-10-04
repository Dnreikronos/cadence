import { notFound } from "next/navigation"

// An address under this area that no page answers: Next would render the app-level 404,
// outside the shell. Throwing here renders this area's not-found inside it.
export default function UnknownPage() {
  notFound()
}
