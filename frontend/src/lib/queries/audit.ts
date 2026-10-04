"use client"

import { useInfiniteQuery, useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { messageFor } from "@/lib/api/errors"
import { saveBlob } from "@/lib/audit/csv"
import {
  accessLogOptions,
  auditPaymentsOptions,
  exportAudit,
} from "./audit-options"

export const useAuditPayments = (companyId: string) =>
  useInfiniteQuery(auditPaymentsOptions(api, companyId))

export const useAccessLog = () => useInfiniteQuery(accessLogOptions(api))

// The save and the toasts belong to the mutation, so they survive the screen unmounting.
export function useExportAudit(companyId: string, company: string) {
  return useMutation({
    mutationFn: () => exportAudit(api, companyId, company, saveBlob),
    onSuccess: () => {
      toast.success("Export ready", {
        description: "Cadence records exports as reads.",
      })
    },
    onError: (error) => toast.error(messageFor(error)),
  })
}
