import { PageHeader } from "@/components/app/page-header"
import { idSchema } from "@/lib/api/schemas"
import { RunNotFound, RunScreen } from "./run-screen"

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // The id goes into a request path: only a guid reaches the client. Anything else is
  // the same screen as a run that does not exist, not a bare 404.
  const valid = idSchema.safeParse(id).success
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Payroll run"
        title="Run progress"
        description="Where each payment in this run stands."
      />
      {valid ? <RunScreen runId={id} /> : <RunNotFound />}
    </div>
  )
}
