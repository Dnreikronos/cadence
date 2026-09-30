import { Globe, Lock, UserRound, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { ButtonCopy } from "@/components/ui/button-copy"
import { formatUsd, payments, recipientId } from "./landing-data"
import { Redacted } from "./Redacted"
import { SealGuilloche } from "./SealGuilloche"

const bruno = payments.find((payment) => payment.id === recipientId)!
const cipherText = `0x${bruno.cipher.replaceAll("·", "")}8e0a…c3f1`

export function CompareChain() {
  return (
    <div className="grid gap-3 px-3 pb-3 sm:px-6 sm:pb-6 md:grid-cols-2">
      <PanelView
        icon={Globe}
        label="What anyone sees"
        note="solscan.io"
        rows={<DetailRows to="7xKX…gAsU" />}
      >
        <div>
          <p className="font-display text-[52px] leading-none font-semibold tracking-tighter text-ink tabular-nums sm:text-[64px]">
            <Redacted isRevealed={false}>{formatUsd(bruno.amount)}</Redacted>
          </p>
          <span className="mt-3 flex items-center gap-3">
            <span className="min-w-0 truncate font-mono text-caption text-ink-muted">
              {cipherText}
            </span>
            <ButtonCopy
              value={cipherText}
              label="Copy ciphertext"
              toastTitle="Ciphertext copied"
              toastDescription="That's all anyone can read from this payment."
            />
          </span>
        </div>
      </PanelView>

      <PanelView
        icon={UserRound}
        label="What Bruno sees"
        note="his Cadence receipt"
        rows={<DetailRows to="Bruno · 7xKX…gAsU" avatar />}
        hasTexture
      >
        <div>
          <p className="font-display text-[52px] leading-none font-semibold tracking-tighter text-ink tabular-nums sm:text-[64px]">
            {formatUsd(bruno.amount)}
          </p>
          <p className="mt-3 flex items-center gap-2 text-ui text-ink-muted">
            <span className="size-1.5 rounded-full bg-success-dot" /> Readable
            by Bruno, Solaris and their auditor
          </p>
        </div>
      </PanelView>
    </div>
  )
}

function PanelView({
  icon: Icon,
  label,
  note,
  hasTexture = false,
  rows,
  children,
}: {
  icon: LucideIcon
  label: string
  note: string
  hasTexture?: boolean
  rows: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      data-reveal
      className={cn(
        "relative flex flex-col overflow-hidden rounded-[24px] border border-line p-6 sm:p-8",
        hasTexture ? "bg-surface" : "bg-canvas",
      )}
    >
      {hasTexture && (
        <SealGuilloche
          className="pointer-events-none absolute top-1/2 -right-40 size-130 -translate-y-1/2 text-ink/[0.07]"
          rings={10}
        />
      )}
      <div className="relative flex items-center justify-between gap-3">
        <span className="flex shrink-0 items-center gap-2 text-[14px] font-medium text-ink">
          <span className="grid size-7 place-items-center rounded-lg border border-line bg-surface text-ink">
            <Icon className="size-3.5" strokeWidth={1.75} />
          </span>
          {label}
        </span>
        <span className="truncate font-mono text-[11px] text-ink-muted">
          {note}
        </span>
      </div>
      <p className="relative mt-8 flex items-center gap-1.5 text-eyebrow tracking-[0.08em] text-ink-muted">
        <Lock className="size-3" /> Amount
      </p>
      <div className="relative mt-3 flex min-h-28 flex-1 flex-col justify-center">
        {children}
      </div>
      {rows}
    </div>
  )
}

function DetailRows({ to, avatar = false }: { to: string; avatar?: boolean }) {
  const rows = [
    { label: "From", value: "Solaris · 4Nd1…mB7z" },
    { label: "To", value: to },
    { label: "Date", value: "31 Mar 2026 · 14:02 UTC" },
    { label: "Transaction", value: "5Kq…9sV · 2,897 bytes" },
  ]
  return (
    <dl className="relative mt-8 divide-y divide-dashed divide-line border-t border-line">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between gap-4 py-3"
        >
          <dt className="text-eyebrow tracking-[0.08em] text-ink-muted">
            {row.label}
          </dt>
          <dd className="flex items-center gap-2 font-mono text-[12.5px] text-ink">
            {avatar && row.label === "To" && (
              <AvatarPerson initials={bruno.initials} size={20} />
            )}
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
