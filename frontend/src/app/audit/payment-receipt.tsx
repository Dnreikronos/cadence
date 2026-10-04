"use client"

import { ExternalLink } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { ButtonCopy } from "@/components/ui/button-copy"
import { buttonVariants } from "@/components/ui/button"
import { Modal } from "@/components/ui/modal"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { WhoCanSee } from "@/components/ui/who-can-see"
import type { AuditRow } from "@/lib/audit/payments"
import { explorerTxUrl } from "@/lib/audit/receipt"
import { cluster } from "@/lib/solana/cluster"
import { Time, timeFormat } from "./list-parts"

// Kept inline and small: the shared receipt (components/app/receipt-dialog.tsx, task D)
// replaces it once on main, with the auditor role's "Paid by" and "Paid to" labels.
export function PaymentReceipt({
  row,
  company,
  onClose,
}: {
  row: AuditRow | null
  company: string
  onClose: () => void
}) {
  return (
    <Modal
      open={row !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Payment receipt"
      description="As the auditor you read the amount; the public sees ciphertext unless the payment is marked transparent."
    >
      {row && (
        <div className="space-y-4">
          <dl className="space-y-3 text-ui">
            <Detail label="Paid by">{company}</Detail>
            <Detail label="Paid to">{row.name}</Detail>
            <Detail label="Amount">
              <span className="inline-flex items-center gap-1.5">
                <AmountDisplay amount={row.usd} />
                <WhoCanSee viewerRole="auditor" hasAuditor />
              </span>
            </Detail>
            <Detail label="Status">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <StatusPill status={row.status} />
                {row.transparent && <TransparentBadge />}
              </span>
            </Detail>
            <Detail label="Date">
              <Time iso={row.paidAt} format={timeFormat} />
            </Detail>
            <Detail label="Signature">
              {row.signature ? (
                <span className="flex items-start gap-2">
                  <span className="min-w-0 font-mono text-caption break-all">
                    {row.signature}
                  </span>
                  <ButtonCopy
                    value={row.signature}
                    label="Copy signature"
                    toastTitle="Signature copied"
                  />
                </span>
              ) : (
                <span className="text-ink-muted">Not on-chain yet</span>
              )}
            </Detail>
          </dl>
          <div className="flex justify-end gap-2">
            {row.signature && (
              <a
                href={explorerTxUrl(row.signature, cluster.name)}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "secondary" })}
              >
                View on explorer
                <ExternalLink className="size-3.5" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className={buttonVariants()}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Detail({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 wrap-break-word text-ink">{children}</dd>
    </div>
  )
}
