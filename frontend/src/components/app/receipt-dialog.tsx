"use client"

import { useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { ExternalLink, Printer, X } from "lucide-react"
import type { PaymentItem } from "@/lib/api/schemas"
import type { Role } from "@/lib/auth/guard"
import { cluster as appCluster, type ClusterName } from "@/lib/solana/cluster"
import { unitsToUsd, formatBaseUnits } from "@/lib/money"
import {
  counterpartyLabel,
  explorerTxUrl,
  formatPaidAt,
  receiptTitle,
} from "@/lib/receipts/receipt"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { ButtonCopy } from "@/components/ui/button-copy"
import { Wordmark } from "@/components/ui/logo"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { WhoCanSee, whoCanSee } from "@/components/ui/who-can-see"

export type ReceiptDialogProps = {
  // Who is reading. It decides the label of the counterparty ("Paid to" for a
  // company or an auditor, "Paid by" for a recipient) and who can read the amount.
  role: Role
  // The payment to show, from any payments list. Null keeps the dialog closed.
  payment: PaymentItem | null
  onClose: () => void
  // Whether the company has an auditor, for the "who can see" sentence.
  hasAuditor?: boolean
}

// A receipt for one payment, built only from the payment item: no request of its own.
// "Download receipt" opens the browser's print dialog, whose "Save as PDF" is the
// download; while the dialog is open, `@media print` (globals.css) prints it alone.
export function ReceiptDialog({
  role,
  payment,
  onClose,
  hasAuditor = false,
}: ReceiptDialogProps) {
  // Keep showing the last payment while the dialog fades out.
  const [shown, setShown] = useState(payment)
  if (payment && payment !== shown) setShown(payment)

  return (
    <Dialog.Root
      open={payment !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-ink/30 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 print:hidden" />
        <Dialog.Popup
          data-receipt-print
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-1/2 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-frame transition-[opacity,transform] duration-200 ease-out outline-none data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transition-none print:static print:max-h-none print:w-full print:max-w-none print:translate-none print:overflow-visible print:border-0 print:p-0 print:shadow-none"
        >
          <Wordmark className="mb-4 hidden print:flex" />
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lead font-medium text-ink">
                Payment receipt
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-ui/normal text-ink-muted">
                {shown?.transparent
                  ? "Sent as an ordinary transfer."
                  : "Sent as an encrypted transfer."}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              className="-mt-1 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-canvas hover:text-ink print:hidden"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>

          {shown && (
            <ReceiptBody
              role={role}
              payment={shown}
              hasAuditor={hasAuditor}
              className="mt-5"
            />
          )}

          {shown && (
            <div className="mt-5 flex flex-wrap justify-end gap-2 print:hidden">
              <button
                type="button"
                onClick={onClose}
                className={buttonVariants({ variant: "secondary" })}
              >
                Close
              </button>
              <button
                type="button"
                onClick={() =>
                  printReceipt(
                    receiptTitle(shown.counterparty.name, shown.paid_at),
                  )
                }
                className={buttonVariants()}
              >
                <Printer className="size-4" />
                Download receipt
              </button>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// The page title names the PDF the browser offers to save, so it is set for the
// print and put back afterwards.
function printReceipt(title: string) {
  const previous = document.title
  const restore = () => {
    document.title = previous
    window.removeEventListener("afterprint", restore)
  }
  document.title = title
  window.addEventListener("afterprint", restore)
  window.print()
}

// The receipt itself, apart from the dialog around it.
export function ReceiptBody({
  role,
  payment,
  hasAuditor = false,
  cluster = appCluster.name,
  className,
}: {
  role: Role
  payment: PaymentItem
  hasAuditor?: boolean
  cluster?: ClusterName
  className?: string
}) {
  const explorer = explorerTxUrl(payment.signature, cluster)
  return (
    <article aria-label="Payment receipt" className={className}>
      <div className="rounded-lg border border-line bg-surface-subtle p-4 print:border-ink/30">
        <p className="text-label text-ink-muted uppercase">Amount</p>
        <div className="mt-1 flex items-center gap-1">
          <AmountDisplay
            amount={unitsToUsd(payment.amount)}
            className="text-amount"
          />
          <span className="print:hidden">
            <WhoCanSee viewerRole={role} hasAuditor={hasAuditor} />
          </span>
        </div>
        <p className="mt-0.5 font-mono text-caption text-ink-muted">
          {formatBaseUnits(BigInt(payment.amount))} USDC
        </p>
      </div>

      <dl className="mt-4 grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 text-ui">
        <Row label={counterpartyLabel(role)}>
          <span className="font-medium wrap-break-word text-ink">
            {payment.counterparty.name}
          </span>
        </Row>
        <Row label="Status">
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusPill status={payment.status} />
            {payment.transparent && <TransparentBadge />}
          </span>
        </Row>
        <Row label="Date">
          <time dateTime={payment.paid_at} className="text-ink">
            {formatPaidAt(payment.paid_at)}
          </time>
        </Row>
        <Row label="Payment ID">
          <Copyable value={payment.payment_id} noun="payment ID" />
        </Row>
        {payment.run_id && (
          <Row label="Payroll run">
            <Copyable value={payment.run_id} noun="run ID" />
          </Row>
        )}
        <Row label="Signature" top>
          {payment.signature ? (
            <div className="min-w-0 space-y-1.5">
              <Copyable value={payment.signature} noun="signature" />
              {explorer && (
                <a
                  href={explorer}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-caption text-ink underline underline-offset-2 print:hidden"
                >
                  View on Solana Explorer
                  <ExternalLink aria-hidden className="size-3" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              )}
            </div>
          ) : (
            <span className="text-ink-muted">Not on the network yet</span>
          )}
        </Row>
      </dl>

      <p className="mt-4 border-t border-line pt-3 text-caption/normal text-ink-muted">
        {payment.transparent
          ? "This payment was sent as an ordinary transfer, so its amount is public on-chain. "
          : ""}
        {whoCanSee(role, hasAuditor)}
      </p>
    </article>
  )
}

function Row({
  label,
  top,
  children,
}: {
  label: string
  top?: boolean
  children: React.ReactNode
}) {
  return (
    <>
      <dt className={`text-ink-muted ${top ? "self-start" : ""}`}>{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

// A long identifier wraps instead of widening the receipt.
function Copyable({ value, noun }: { value: string; noun: string }) {
  return (
    <span className="flex items-start gap-2">
      <span className="min-w-0 font-mono text-caption/normal break-all text-ink">
        {value}
      </span>
      <span className="print:hidden">
        <ButtonCopy
          value={value}
          label={`Copy ${noun}`}
          toastTitle={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} copied`}
        />
      </span>
    </span>
  )
}
