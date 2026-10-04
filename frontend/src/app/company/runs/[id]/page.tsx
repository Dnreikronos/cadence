import { notFound } from "next/navigation"
import { PageHeader } from "@/components/app/page-header"
import { idSchema } from "@/lib/api/schemas"
import { RunScreen } from "./run-screen"

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // The id goes into a request path: only a guid reaches the client. Anything else is a
  // real 404 that renders this route's not-found, the same "Run not found" as an unknown run.
  if (!idSchema.safeParse(id).success) notFound()
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Payroll run"
        title="Run progress"
        description="Where each payment in this run stands."
      />
      <RunScreen runId={id} />
    </div>
  )
}
