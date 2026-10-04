"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { Plus, RotateCw, ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { ActivationPill } from "@/components/ui/activation-pill"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Modal } from "@/components/ui/modal"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { isApiError, messageFor } from "@/lib/api"
import { removalCopy } from "@/lib/auditors/copy"
import {
  canRetry,
  useAuditors,
  useInviteAuditor,
  useRevokeAuditor,
  type AuditorRow,
} from "@/lib/queries/auditors"
import { focusIfLost, useRestoreFocus } from "@/lib/restore-focus"
import { InviteAuditorModal } from "./invite-form"

const rowColumns =
  "md:grid-cols-[minmax(0,1.6fr)_128px_128px_160px] md:items-center md:gap-x-4"

export function AuditorsScreen() {
  // The row stays set while the dialog fades out, so its text does not vanish.
  const [removing, setRemoving] = useState<AuditorRow | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [inviting, setInviting] = useState(false)
  const auditors = useAuditors()
  const inviteRef = useRef<HTMLButtonElement>(null)
  // Closing a dialog returns focus to the button that opened it, or to "Invite
  // auditor" when that row is gone (a revoked auditor, a first invite).
  const restore = useRestoreFocus(() => inviteRef.current)
  // The email of a row whose "Invite again" just succeeded. A re-invite comes back
  // as a new row, so the row that replaces the old one takes focus when it mounts.
  const refocus = useRef<string | null>(null)
  useEffect(() => {
    if (!auditors.isFetching) refocus.current = null
  }, [auditors.isFetching, auditors.dataUpdatedAt])

  const hasAuditor =
    auditors.data?.rows.some((a) => a.status === "active") ?? false

  const inviteButton = (
    <button
      ref={inviteRef}
      type="button"
      onClick={() => {
        restore.remember()
        setInviting(true)
      }}
      className={buttonVariants()}
    >
      <Plus className="size-4" />
      Invite auditor
    </button>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-subtle p-4">
        <p className="min-w-0 flex-1 text-ui/normal text-ink-muted">
          An auditor reads <strong className="text-ink">every</strong> payment
          amount of your company, not a selection. Cadence can read amounts too,
          and logs every read.
        </p>
        <WhoCanSee viewerRole="admin" hasAuditor={hasAuditor} />
      </div>

      <AuditorsBody
        auditors={auditors}
        inviteButton={inviteButton}
        refocus={refocus}
        onRemove={(auditor) => {
          restore.remember()
          setRemoving(auditor)
          setRemoveOpen(true)
        }}
      />

      <InviteAuditorModal
        open={inviting}
        onOpenChange={setInviting}
        finalFocus={restore.finalFocus}
      />
      <RemoveModal
        auditor={removing}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        onRevoked={restore.originRemoved}
        finalFocus={restore.finalFocus}
      />
    </div>
  )
}

function AuditorsBody({
  auditors,
  inviteButton,
  refocus,
  onRemove,
}: {
  auditors: ReturnType<typeof useAuditors>
  inviteButton: React.ReactNode
  refocus: RefObject<string | null>
  onRemove: (auditor: AuditorRow) => void
}) {
  if (auditors.isPending) return <AuditorsSkeleton />
  if (auditors.isError) {
    return (
      <ErrorState
        title="Couldn't load your auditors"
        description={messageFor(auditors.error)}
        onRetry={
          canRetry(auditors.error) ? () => auditors.refetch() : undefined
        }
      />
    )
  }

  const { rows: list, truncated } = auditors.data
  if (list.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No auditors yet"
        description="Invite your accountant to see every payment amount. They need no wallet."
        action={inviteButton}
      />
    )
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ui text-ink-muted">
          {list.length} {list.length === 1 ? "auditor" : "auditors"}
        </p>
        {inviteButton}
      </div>

      {truncated && (
        <p role="status" className="text-ui text-ink-muted">
          Showing the first {list.length} auditors. The rest are not listed
          here.
        </p>
      )}

      <div
        role="table"
        aria-label="Auditors"
        className="overflow-hidden rounded-xl border border-line bg-surface"
      >
        <div role="rowgroup" className="hidden md:block">
          <div
            role="row"
            className={`border-b border-line bg-surface-subtle px-4 py-2 text-label text-ink-muted uppercase md:grid ${rowColumns}`}
          >
            <span role="columnheader">Email</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Invited</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
        </div>

        <div role="rowgroup">
          {list.map((auditor) => (
            <AuditorListRow
              key={auditor.id}
              auditor={auditor}
              refocus={refocus}
              onRemove={() => onRemove(auditor)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function AuditorListRow({
  auditor,
  refocus,
  onRemove,
}: {
  auditor: AuditorRow
  refocus: RefObject<string | null>
  onRemove: () => void
}) {
  const invite = useInviteAuditor()
  const copy = removalCopy(auditor.status)
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (refocus.current !== auditor.email) return
    refocus.current = null
    focusIfLost(rowRef.current)
  }, [refocus, auditor.email])

  return (
    <div
      ref={rowRef}
      role="row"
      // Focusable so focus has somewhere to go when "Invite again" goes away.
      tabIndex={-1}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 outline-none last:border-0 md:grid ${rowColumns}`}
    >
      <span
        role="cell"
        className="min-w-0 basis-full text-ui break-all text-ink md:basis-auto"
      >
        {auditor.email}
      </span>
      <span role="cell">
        <ActivationPill activation={auditor.status} />
      </span>
      <span role="cell" className="text-ui text-ink-muted">
        <span className="md:sr-only">Invited </span>
        <time dateTime={auditor.invited_at}>
          {formatDate(auditor.invited_at)}
        </time>
      </span>
      <span role="cell" className="ml-auto flex items-center justify-end gap-1">
        {auditor.status === "invite-expired" && (
          <button
            type="button"
            // Not `disabled`: that would drop focus to the page while it sends.
            aria-disabled={invite.isPending}
            onClick={(event) => {
              if (invite.isPending) return
              const button = event.currentTarget
              invite.mutate(auditor.email, {
                // The invite is pending now, so this button is about to be replaced.
                onSuccess: () => {
                  refocus.current = auditor.email
                  focusIfLost(rowRef.current, button)
                },
                onError: (error) => toast.error(messageFor(error)),
              })
            }}
            className={buttonVariants({
              variant: "secondary",
              size: "sm",
              className:
                "aria-disabled:pointer-events-none aria-disabled:opacity-50",
            })}
          >
            <RotateCw className="size-3.5" aria-hidden />
            {invite.isPending ? "Inviting…" : "Invite again"}
            <span className="sr-only"> {auditor.email}</span>
          </button>
        )}
        <IconButton
          label={`${copy.action} ${auditor.email}`}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      </span>
    </div>
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
  open,
  onOpenChange,
  onRevoked,
  finalFocus,
}: {
  auditor: AuditorRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  // The row that opened the dialog is gone.
  onRevoked: () => void
  finalFocus: () => HTMLElement | boolean
}) {
  const revoke = useRevokeAuditor()
  if (!auditor) return null
  const copy = removalCopy(auditor.status)

  // The request cannot be cancelled, so the dialog stays until it answers. The
  // toast on success is the hook's, not this component's.
  function change(next: boolean) {
    if (revoke.isPending) return
    if (!next) revoke.reset()
    onOpenChange(next)
  }

  const retryable = revoke.isError && canRetry(revoke.error)

  return (
    <Modal
      open={open}
      onOpenChange={change}
      finalFocus={finalFocus}
      title={
        <>
          {copy.action}{" "}
          <span className="min-w-0 break-all">{auditor.email}</span>?
        </>
      }
      description={copy.description}
    >
      {revoke.isError && (
        <p role="alert" className="mb-4 text-ui/normal text-danger-fg">
          {messageFor(revoke.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={revoke.isPending}
          onClick={() => change(false)}
          className={buttonVariants({ variant: "secondary" })}
        >
          {copy.keep}
        </button>
        <button
          type="button"
          disabled={revoke.isPending}
          onClick={() =>
            revoke.mutate(auditor, {
              onSuccess: () => {
                onRevoked()
                change(false)
              },
              // Already gone: nothing is left to confirm, and the hook says so.
              onError: (error) => {
                if (isApiError(error) && error.code === "auditor_not_found") {
                  onRevoked()
                  change(false)
                }
              },
            })
          }
          className={buttonVariants({
            className: "bg-danger-fg text-white hover:bg-danger-fg/90",
          })}
        >
          {revoke.isPending
            ? copy.pending
            : retryable
              ? "Try again"
              : copy.confirm}
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
