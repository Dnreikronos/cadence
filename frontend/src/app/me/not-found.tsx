import { homeLinks } from "@/components/app/nav"
import { NotFoundView } from "@/components/app/not-found-view"

// Rendered inside the shell, so the navigation is still there.
export default function NotFound() {
  return <NotFoundView className="max-w-3xl" {...homeLinks.recipient} />
}
