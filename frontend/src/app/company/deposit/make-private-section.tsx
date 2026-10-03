"use client"

import { useId, useState } from "react"
import { Check, Eye, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { fieldClass } from "@/components/ui/field"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { formatUsd } from "@/lib/format"
import { makePrivateSchema, parseAmount } from "@/lib/deposit/schema"
import { useMakePrivate } from "@/lib/deposit/queries"
import {
  makePrivateSteps,
  stepLabels,
  type DepositInfo,
} from "@/lib/deposit/types"
import { cn } from "@/lib/utils"
import { StepHeading } from "./receive-section"

export function MakePrivateSection({ info }: { info: DepositInfo }) {
  const id = useId()
  const run = useMakePrivate()
  const [amount, setAmount] = useState("")
  const [error, setError] = useState<string>()
  const isBusy = run.isPending
  const hasFunds = info.publicUsdc > 0

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const parsed = makePrivateSchema(info.publicUsdc).safeParse(
      parseAmount(amount),
    )
    if (!parsed.success) {
      setError(parsed.error.issues[0].message)
      return
    }
    setError(undefined)
    run.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(`${formatUsd(parsed.data)} is now private`)
        setAmount("")
      },
      onError: (failure) => toast.error(failure.message),
    })
  }

  return (
    <section
      aria-labelledby="private-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <StepHeading n={2} id="private-heading">
        Make it private
      </StepHeading>

      <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
        <Balance label="Public USDC" hint="Visible to anyone on-chain">
          <AmountDisplay amount={info.publicUsdc} className="text-amount" />
        </Balance>
        <Balance
          label="Private USDC"
          hint={
            info.pendingUsdc > 0
              ? `${formatUsd(info.pendingUsdc)} still becoming available`
              : "Available to pay people"
          }
          adornment={<WhoCanSee viewerRole="admin" hasAuditor={false} />}
        >
          <AmountDisplay amount={info.privateUsdc} className="text-amount" />
        </Balance>
      </dl>

      <form onSubmit={submit} noValidate className="mt-5 space-y-3">
        <label htmlFor={`${id}-amount`} className="text-ui font-medium">
          Amount to make private (USDC)
        </label>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              disabled={!hasFunds || isBusy}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value)
                setError(undefined)
              }}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
              className={cn(
                fieldClass,
                "h-10 pr-14 font-mono tabular-nums disabled:opacity-50",
              )}
            />
            <button
              type="button"
              disabled={!hasFunds || isBusy}
              onClick={() => {
                setAmount(String(info.publicUsdc))
                setError(undefined)
              }}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md px-2 py-1 text-caption font-medium text-ink-muted hover:bg-canvas hover:text-ink disabled:opacity-50"
            >
              Max
            </button>
          </div>
          <button
            type="submit"
            disabled={!hasFunds || isBusy}
            className={buttonVariants({ size: "lg" })}
          >
            {isBusy && <Loader2 className="size-4 animate-spin" />}
            {isBusy ? "Working…" : "Make private"}
          </button>
        </div>
        {error && (
          <p
            id={`${id}-error`}
            role="alert"
            className="text-caption text-danger-fg"
          >
            {error}
          </p>
        )}
        {!hasFunds && (
          <p className="text-caption/normal text-ink-muted">
            You hold no public USDC yet. Send some to the address above first.
          </p>
        )}
      </form>

      {isBusy && <Progress step={run.step} />}

      <p className="mt-5 flex gap-2 rounded-lg border border-warning-border bg-warning-bg p-3 text-ui/normal text-warning-fg">
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          This step is public. The amount you move to private USDC is visible
          on-chain, and so is your deposit. What you pay out from your private
          balance afterwards stays encrypted.
        </span>
      </p>
    </section>
  )
}

function Balance({
  label,
  hint,
  adornment,
  children,
}: {
  label: string
  hint: string
  adornment?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="bg-surface-subtle p-4">
      <dt className="flex items-center justify-between text-label text-ink-muted uppercase">
        {label}
        {adornment}
      </dt>
      <dd className="mt-1.5">
        {children}
        <p className="mt-1 text-caption text-ink-muted">{hint}</p>
      </dd>
    </div>
  )
}

function Progress({
  step,
}: {
  step: (typeof makePrivateSteps)[number] | null
}) {
  const current = step ? makePrivateSteps.indexOf(step) : -1
  return (
    <ol aria-live="polite" className="mt-4 space-y-1.5">
      {makePrivateSteps.map((name, index) => {
        const state =
          index < current ? "done" : index === current ? "active" : "todo"
        return (
          <li
            key={name}
            className={cn(
              "flex items-center gap-2 text-ui",
              state === "todo" ? "text-ink-muted" : "text-ink",
            )}
          >
            <span className="grid size-4 place-items-center">
              {state === "done" && (
                <Check className="size-3.5 text-success-dot" />
              )}
              {state === "active" && (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {state === "todo" && (
                <span className="size-1.5 rounded-full bg-line" />
              )}
            </span>
            {stepLabels[name]}
          </li>
        )
      })}
    </ol>
  )
}
