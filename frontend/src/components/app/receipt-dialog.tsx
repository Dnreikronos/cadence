"use client"

import { useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { ExternalLink, Printer, X } from "lucide-react"
import { apiConfig } from "@/lib/api/mode"
import type { PaymentItem } from "@/lib/api/schemas"
import type { Role } from "@/lib/auth/guard"
import { cluster as appCluster, type ClusterName } from "@/lib/solana/cluster"
import { unitsToUsd, formatBaseUnits } from "@/lib/money"
import { printWithTitle } from "@/lib/receipts/print"
import {
  counterpartyLabel,
  explorerTxUrl,
  formatPaidAt,
  receiptSummary,
  receiptTitle,
  testDataNotice,
} from "@/lib/receipts/receipt"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { ButtonCopy } from "@/components/ui/button-copy"
import { Wordmark } from "@/components/ui/logo"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { WhoCanSee, whoCanSee } from "@/components/ui/who-can-see"

export type ReceiptDialogProps = {
  // Who is reading. The item is the same for everyone, the role changes the words:
  // - admin: the payee is the counterparty, "Paid to".
  // - auditor: the same payee-only item as the admin, "Paid to"; pass `company`
  //   to also show who paid.
  // - recipient: the counterparty is the paying company, "Paid by".
  role: Role
  // The payment to show, from any payments list. Null keeps the dialog closed.
  payment: PaymentItem | null
  onClose: () => void
  // Whether the company has an auditor, for the "who can read this amount"
  // sentence. Undefined means not known yet, and the sentence then says "anyone
  // the company has designated" rather than claiming there is none.
  hasAuditor?: boolean
  // The paying company's name, as a "Paid by" line. For an admin or an auditor,
  // whose item names only the payee; a recipient's counterparty already is the company.
  company?: string
}

// A receipt for one payment, built only from the payment item: no request of its own.
// "Download receipt" opens the browser's print dialog, whose "Save as PDF" is the
// download; while the dialog is open, `@media print` (globals.css) prints it alone.
export function ReceiptDialog({
  payment,
  onClose,
  ...rest
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
        {shown && <ReceiptPopup payment={shown} onClose={onClose} {...rest} />}
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// What marks the popup for `@media print` (globals.css) and lays it out on paper.
export const receiptPopupProps = {
  "data-receipt-print": true,
  className:
    "fixed top-1/2 left-1/2 z-50 max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-1/2 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-frame transition-[opacity,transform] duration-200 ease-out outline-none data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transition-none print:static print:max-h-none print:w-full print:max-w-none print:translate-none print:overflow-visible print:border-0 print:p-0 print:shadow-none",
}

function ReceiptPopup(
  props: Omit<ReceiptDialogProps, "payment"> & { payment: PaymentItem },
) {
  return (
    <Dialog.Popup {...receiptPopupProps}>
      <ReceiptContent {...props} />
    </Dialog.Popup>
  )
}

// Everything inside the popup, apart from the popup and the portal so a test can render it.
export function ReceiptContent({
  payment,
  onClose,
  ...rest
}: Omit<ReceiptDialogProps, "payment"> & { payment: PaymentItem }) {
  return (
    <>
      <Wordmark className="mb-4 hidden print:flex" />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Dialog.Title className="text-lead font-medium text-ink">
            Payment receipt
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-ui/normal text-ink-muted">
            {receiptSummary(payment)}
          </Dialog.Description>
        </div>
        <Dialog.Close
          aria-label="Close"
          className="-mt-1 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-canvas hover:text-ink print:hidden"
        >
          <X className="size-4" />
        </Dialog.Close>
      </div>

      <ReceiptBody payment={payment} className="mt-5" {...rest} />

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
            printWithTitle(
              receiptTitle(payment.counterparty.name, payment.paid_at),
            )
          }
          className={buttonVariants()}
        >
          <Printer className="size-4" />
          Download receipt
        </button>
      </div>
    </>
  )
}

// The receipt itself, apart from the dialog around it. `cluster` and `mock`
// default to the running build and decide the test-data line printed on it.
export function ReceiptBody({
  role,
  payment,
  hasAuditor,
  company,
  cluster = appCluster.name,
  mock = apiConfig.mode === "mock",
  className,
}: Omit<ReceiptDialogProps, "payment" | "onClose"> & {
  payment: PaymentItem
  cluster?: ClusterName
  mock?: boolean
  className?: string
}) {
  const explorer = explorerTxUrl(payment.signature, cluster)
  const testData = testDataNotice(cluster, mock)
  return (
    <article aria-label="Payment receipt" className={className}>
      <div className="rounded-lg border border-line bg-surface-subtle p-4 print:border-ink/30">
        <p className="text-label text-ink-muted uppercase">Amount</p>
        <div className="mt-1 flex items-center gap-1">
          <AmountDisplay
            amount={unitsToUsd(payment.amount)}
            className="text-amount"
          />
          {/* Its readers are listed only for an encrypted amount: a transparent one is public. */}
          {!payment.transparent && (
            <span className="print:hidden">
              <WhoCanSee viewerRole={role} hasAuditor={hasAuditor} />
            </span>
          )}
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
        {company && role !== "recipient" && (
          <Row label="Paid by">
            <span className="font-medium wrap-break-word text-ink">
              {company}
            </span>
          </Row>
        )}
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
          ? "This payment was sent as an ordinary transfer, so its amount is public on-chain."
          : whoCanSee(role, hasAuditor)}
      </p>
      {testData && (
        <p className="mt-3 hidden border border-ink/40 px-2 py-1 text-center font-mono text-caption font-semibold uppercase print:block">
          {testData}
        </p>
      )}
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
