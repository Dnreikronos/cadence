"use client"

import { useAuditors, useRemoveAuditor } from "@/lib/auditors/queries"
import { ActivationPill } from "@/components/ui/activation-pill"
import type { Auditor } from "@/lib/auditors/types"
import { Modal } from "@/components/ui/modal"
import { buttonVariants } from "@/components/ui/button"
import { toast } from "sonner"
import { useState } from "react"
import { Plus, ShieldCheck, Trash2 } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { InviteAuditorModal } from "./invite-form"

const rowColumns =
  "md:grid-cols-[minmax(0,1.6fr)_128px_128px_48px] md:items-center md:gap-x-4"

export function AuditorsScreen() {
  const [removing, setRemoving] = useState<Auditor | null>(null)
  const [inviting, setInviting] = useState(false)
  const auditors = useAuditors()

  if (auditors.isPending) return <AuditorsSkeleton />
  if (auditors.isError) {
    return (
      <ErrorState
        title="Couldn't load your auditors"
        description="Check your connection and try again."
        onRetry={() => auditors.refetch()}
      />
    )
  }

  const list = auditors.data
  const inviteButton = (
    <button
      type="button"
      onClick={() => setInviting(true)}
      className={buttonVariants()}
    >
      <Plus className="size-4" />
      Invite auditor
    </button>
  )

  return (
    <>
      {list.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No auditors yet"
          description="Invite your accountant to see every payment amount. They need no wallet."
          action={inviteButton}
        />
      ) : (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-ui text-ink-muted">
              {list.length} {list.length === 1 ? "auditor" : "auditors"}
            </p>
            {inviteButton}
          </div>

          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div
              className={`hidden border-b border-line bg-surface-subtle px-4 py-2 text-label text-ink-muted uppercase md:grid ${rowColumns}`}
            >
              <span>Email</span>
              <span>Status</span>
              <span>Invited</span>
              <span className="sr-only">Actions</span>
            </div>

            <ul>
              {list.map((auditor) => (
                <li
                  key={auditor.id}
                  className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-0 md:grid ${rowColumns}`}
                >
                  <span className="text-ui text-ink">{auditor.email}</span>
                  <span>
                    <ActivationPill activation={auditor.status} />
                  </span>
                  <span className="text-ui text-ink-muted">
                    {formatDate(auditor.invitedAt)}
                  </span>
                  <span>
                    <IconButton
                      label={`Remove ${auditor.email}`}
                      onClick={() => setRemoving(auditor)}
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <InviteAuditorModal open={inviting} onOpenChange={setInviting} />
      <RemoveModal auditor={removing} onClose={() => setRemoving(null)} />
    </>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-ink-muted transition-colors duration-150 hover:bg-canvas hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
    >
      {children}
    </button>
  )
}

function RemoveModal({
  auditor,
  onClose,
}: {
  auditor: Auditor | null
  onClose: () => void
}) {
  const remove = useRemoveAuditor()
  return (
    <Modal
      open={auditor !== null}
      onOpenChange={(open) => !open && onClose()}
      title={auditor ? `Remove ${auditor.email}?` : "Remove auditor"}
      description="They lose access to your payments right away. To give it back, send a new invite."
    >
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className={buttonVariants({ variant: "secondary" })}
        >
          Keep
        </button>
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (!auditor) return
            remove.mutate(auditor.id, {
              onSuccess: () => {
                toast.success(`${auditor.email} removed`)
                onClose()
              },
              onError: (error) => toast.error(error.message),
            })
          }}
          className={buttonVariants({
            className: "bg-danger-fg text-white hover:bg-danger-fg/90",
          })}
        >
          {remove.isPending ? "Removing…" : "Remove"}
        </button>
      </div>
    </Modal>
  )
}

function AuditorsSkeleton() {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <span className="sr-only">Loading auditors</span>
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0"
        >
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}
