"use client"

import { useState } from "react"
import { Check, Globe, Info, Lock, Minus } from "lucide-react"
import { cn } from "@/lib/utils"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { LogoMark } from "@/components/ui/logo"
import {
  canSee,
  formatUsd,
  payments,
  perspectives,
  type Perspective,
} from "./landing-data"
import { Redacted } from "./Redacted"
import { SealGuilloche } from "./SealGuilloche"

const rowStagger = 110

export function VaultKeys() {
  const [perspective, setPerspective] = useState<Perspective>("public")
  const active = perspectives.find((item) => item.id === perspective)!
  const readable = payments.filter((payment) =>
    canSee(perspective, payment),
  ).length

  function selectWithArrows(event: React.KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
      event.key
    ]
    if (!step) return
    event.preventDefault()
    const index = perspectives.findIndex((item) => item.id === perspective)
    const next =
      perspectives[(index + step + perspectives.length) % perspectives.length]
        .id
    setPerspective(next)
    document
      .querySelector<HTMLButtonElement>(`[data-perspective="${next}"]`)
      ?.focus()
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Whose key reads the ledger"
        onKeyDown={selectWithArrows}
        className="grid grid-cols-2 gap-3 lg:grid-cols-5"
      >
        {perspectives.map((item) => (
          <CardKey
            key={item.id}
            item={item}
            isActive={item.id === perspective}
            onSelect={() => setPerspective(item.id)}
          />
        ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-12">
        <div
          role="tabpanel"
          aria-label={`${active.label} key`}
          className="relative overflow-hidden rounded-2xl border border-white/10 bg-night-raised lg:col-span-8"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
            <p className="text-eyebrow tracking-widest text-night-muted">
              Solaris · payments · March 2026
            </p>
            <p
              key={perspective}
              className="flex animate-[fade-in_300ms_var(--ease-out)] items-center gap-2 text-ui text-white/70"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  readable
                    ? "bg-glow shadow-[0_0_8px_var(--glow)]"
                    : "bg-white/25",
                )}
              />
              {readable} of {payments.length} amounts readable
            </p>
          </div>
          <div className="relative">
            <span
              key={perspective}
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px animate-[scan-down_760ms_var(--ease-in-out)_forwards] bg-uv shadow-[0_0_18px_3px_var(--uv)] [--scan-distance:330px] motion-reduce:hidden"
            />
            <ul>
              {payments.map((payment, index) => {
                const isReadable = canSee(perspective, payment)
                return (
                  <li
                    key={payment.id}
                    className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-white/[0.07] px-5 py-3.5 last:border-0 sm:grid-cols-[1.3fr_0.8fr_1fr]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <AvatarPerson
                        initials={payment.initials}
                        size={28}
                        className="ring-white/10"
                      />
                      <span className="truncate text-[14px] text-white/85">
                        {payment.name}
                      </span>
                    </span>
                    <span className="hidden text-ui text-night-muted sm:block">
                      {payment.kind}
                    </span>
                    <span className="flex items-center justify-end gap-2 font-mono text-[14px] text-white tabular-nums">
                      <Lock
                        className={cn(
                          "size-3 text-white/35 transition-opacity duration-300",
                          isReadable ? "opacity-0" : "opacity-100",
                        )}
                        style={{
                          transitionDelay: `${120 + index * rowStagger}ms`,
                        }}
                      />
                      <Redacted
                        isRevealed={isReadable}
                        delay={120 + index * rowStagger}
                      >
                        {formatUsd(payment.amount)}
                      </Redacted>
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>

        <div
          key={perspective}
          className="rounded-2xl border border-white/10 bg-white/2 p-5 lg:col-span-4"
        >
          <p className="text-eyebrow tracking-widest text-night-muted">
            {active.label} key can
          </p>
          <dl>
            {abilities[perspective].map((ability, index) => (
              // A group of one term and its detail: the icon lives in the term, so the
              // list holds only dt and dd.
              <div
                key={ability.label}
                className="animate-[fade-in_400ms_var(--ease-out)_both] border-b border-white/[0.07] py-4 last:border-0"
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <dt className="flex items-start gap-3 text-[14px] text-white">
                  <span
                    className={cn(
                      "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
                      ability.isAllowed
                        ? "bg-glow text-ink"
                        : "bg-white/8 text-white/45",
                    )}
                  >
                    {ability.isAllowed ? (
                      <Check className="size-3" strokeWidth={2.5} />
                    ) : ability.isInfo ? (
                      // A statement about how Cadence is built, not a guarantee: no denial.
                      <Info className="size-3" strokeWidth={2.5} />
                    ) : (
                      <Minus className="size-3" strokeWidth={2.5} />
                    )}
                  </span>
                  {ability.label}
                </dt>
                <dd className="mt-0.5 pl-8 text-ui/normal text-night-muted">
                  {ability.note}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  )
}

function CardKey({
  item,
  isActive,
  onSelect,
}: {
  item: (typeof perspectives)[number]
  isActive: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      data-perspective={item.id}
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "group/key relative flex h-34.5 flex-col justify-between overflow-hidden rounded-2xl border p-4 text-left transition-[border-color,background-color,transform] duration-200 ease-out outline-none focus-visible:ring-2 focus-visible:ring-glow/60 active:scale-[0.98] max-lg:last:col-span-2 sm:p-5",
        isActive
          ? "border-glow/50 bg-white/6"
          : "border-white/10 bg-white/2 hover:border-white/20 hover:bg-white/4",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-5 top-0 h-px bg-glow transition-transform duration-300 ease-out",
          isActive ? "scale-x-100" : "scale-x-0",
        )}
      />
      <SealGuilloche
        rings={6}
        className={cn(
          "pointer-events-none absolute -right-10 -bottom-12 size-40 transition-[color,rotate] duration-700 ease-out",
          isActive
            ? "rotate-45 text-glow/35"
            : "text-white/8 group-hover/key:rotate-12",
        )}
      />
      <span className="relative flex items-center gap-2.5">
        {item.initials ? (
          <AvatarPerson
            initials={item.initials}
            size={30}
            className="ring-white/10"
          />
        ) : (
          <span className="grid size-7.5 place-items-center rounded-full bg-white/8 text-white/70">
            {item.id === "cadence" ? (
              <LogoMark className="size-3.5" />
            ) : (
              <Globe className="size-3.5" strokeWidth={1.75} />
            )}
          </span>
        )}
        <span
          className={cn(
            "text-button transition-colors",
            isActive ? "text-white" : "text-white/70",
          )}
        >
          {item.label}
        </span>
      </span>
      <span className="relative">
        <span
          className={cn(
            "block text-ui transition-colors",
            isActive ? "text-white/75" : "text-night-muted",
          )}
        >
          {item.holder}
        </span>
        <span className="mt-0.5 block text-label text-night-muted">
          {keyIds[item.id]}
        </span>
      </span>
    </button>
  )
}

const keyIds: Record<Perspective, string> = {
  company: "key 4Nd1…mB7z",
  recipient: "key 7xKX…gAsU",
  auditor: "key a4…9f",
  cadence: "viewing keys only",
  public: "no key",
}

const abilities: Record<
  Perspective,
  { label: string; note: string; isAllowed: boolean; isInfo?: boolean }[]
> = {
  company: [
    {
      label: "Read every amount",
      note: "Every payment Solaris made, and the treasury balance.",
      isAllowed: true,
    },
    {
      label: "Move funds",
      note: "Payments are signed in Solaris' own wallet.",
      isAllowed: true,
    },
    {
      label: "Add an auditor",
      note: "Grant read access, and revoke it later.",
      isAllowed: true,
    },
  ],
  recipient: [
    {
      label: "Read his own payments",
      note: "Amount, date and sender, in Cadence and by email.",
      isAllowed: true,
    },
    {
      label: "Read anyone else's",
      note: "Colleagues' pay stays sealed to him.",
      isAllowed: false,
    },
    {
      label: "Withdraw",
      note: "Signed with his own wallet. Withdrawals are public.",
      isAllowed: true,
    },
  ],
  auditor: [
    {
      label: "Read every amount",
      note: "And export the month as a spreadsheet.",
      isAllowed: true,
    },
    {
      label: "Move funds",
      note: "An auditor key can read, never sign.",
      isAllowed: false,
    },
    {
      label: "Audit log",
      note: "Reads are meant to be recorded in an audit log.",
      isAllowed: false,
      isInfo: true,
    },
  ],
  cadence: [
    {
      label: "Read every amount",
      note: "The proof service needs viewing keys to seal each payment.",
      isAllowed: true,
    },
    {
      label: "Move funds",
      note: "Your wallet signs every transaction. Cadence is not designed to hold your funds or store your signing key.",
      isAllowed: false,
      isInfo: true,
    },
    {
      label: "Audit log",
      note: "Cadence can read amounts. Reads are meant to be recorded in an audit log.",
      isAllowed: false,
      isInfo: true,
    },
  ],
  public: [
    {
      label: "See that payments happened",
      note: "Addresses, times and signatures are public.",
      isAllowed: true,
    },
    {
      label: "Read any amount",
      note: "Only ciphertext reaches the chain.",
      isAllowed: false,
    },
    {
      label: "Read balances",
      note: "Balances are sealed the same way.",
      isAllowed: false,
    },
  ],
}
