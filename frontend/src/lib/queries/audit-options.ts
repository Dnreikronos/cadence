import { infiniteQueryOptions } from "@tanstack/react-query"
import type { ApiClient } from "@/lib/api/client"
import { csvFilename } from "@/lib/audit/csv"
import { queryKeys } from "./keys"

// Apart from the hooks so a test can run them against the mock without the app's API mode.
export const AUDIT_PAGE_SIZE = 20

type AuditApi = Pick<ApiClient, "audit">

export function auditPaymentsOptions(client: AuditApi, companyId: string) {
  const query = { limit: AUDIT_PAGE_SIZE }
  return infiniteQueryOptions({
    queryKey: queryKeys.payments.audit(companyId, query),
    queryFn: ({ pageParam, signal }) =>
      client.audit.payments(
        companyId,
        { ...query, cursor: pageParam },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })
}

export function accessLogOptions(client: AuditApi) {
  const query = { limit: AUDIT_PAGE_SIZE }
  return infiniteQueryOptions({
    queryKey: queryKeys.accessLog.list(query),
    queryFn: ({ pageParam, signal }) =>
      client.audit.accessLog({ ...query, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })
}

// Fetches the CSV and hands it to `save` under a dated name. Nothing of the file's content
// goes into the name.
export async function exportAudit(
  client: Pick<ApiClient, "exports">,
  companyId: string,
  company: string,
  save: (blob: Blob, filename: string) => void,
  now: Date = new Date(),
) {
  const blob = await client.exports.audit(companyId)
  const filename = csvFilename(company, now)
  save(blob, filename)
  return filename
}
