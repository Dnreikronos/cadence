"use client"

import { useInfiniteQuery, useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { messageFor } from "@/lib/api/errors"
import { csvFilename, saveBlob } from "@/lib/audit/csv"
import { accessLogOptions, auditPaymentsOptions } from "./audit-options"

export const useAuditPayments = (companyId: string) =>
  useInfiniteQuery(auditPaymentsOptions(api, companyId))

export const useAccessLog = () => useInfiniteQuery(accessLogOptions(api))

// The save and the toasts belong to the mutation, so they survive the screen unmounting.
export function useExportAudit(companyId: string, company: string) {
  return useMutation({
    mutationFn: () => api.exports.audit(companyId),
    onSuccess: (blob) => {
      saveBlob(blob, csvFilename(company, new Date()))
      toast.success("Export ready", {
        description: "The export is recorded in the access log, like any read.",
      })
    },
    onError: (error) => toast.error(messageFor(error)),
  })
}
