import { PageHeader } from "@/components/app/page-header"
import { PageTitle } from "@/components/app/page-title"
import { RunNotFound } from "./run-screen"

// A run id that is not a guid: a real 404, in the shell, saying what an unknown run says.
export default function NotFound() {
  return (
    <div className="space-y-6">
      <PageTitle title="Page not found" />
      <PageHeader
        eyebrow="Payroll run"
        title="Run progress"
        description="Where each payment in this run stands."
      />
      <RunNotFound />
    </div>
  )
}
