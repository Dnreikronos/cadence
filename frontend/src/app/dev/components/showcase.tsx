"use client";

import { ArrowRight, Plus, Send } from "lucide-react";
import { AmountDisplay, type AmountState } from "@/components/ui/amount-display";
import { AvatarPerson } from "@/components/ui/avatar-person";
import { buttonVariants, iconNudge } from "@/components/ui/button";
import { ButtonCopy } from "@/components/ui/button-copy";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LogoMark, Wordmark } from "@/components/ui/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill, type PaymentStatus } from "@/components/ui/status-pill";
import { TransparentBadge } from "@/components/ui/transparent-badge";
import { WhoCanSee, whoCanSee } from "@/components/ui/who-can-see";
import type { Role } from "@/lib/auth/guard";
import { cn } from "@/lib/utils";

const statuses: PaymentStatus[] = ["pending", "confirmed", "failed"];
const amountStates: AmountState[] = ["revealed", "hidden", "loading"];
const roles: Role[] = ["admin", "recipient", "auditor"];
const colors = ["ink", "ink-muted", "night", "night-raised", "canvas", "surface", "surface-subtle", "line", "glow", "uv"];
// Literal class names, so Tailwind can find them.
const typeScale = {
  label: "text-label",
  eyebrow: "text-eyebrow",
  caption: "text-caption",
  ui: "text-ui",
  body: "text-body",
  button: "text-button",
  lead: "text-lead",
  title: "text-title",
  amount: "text-amount",
};

export function Showcase() {
  return (
    <div className="min-h-svh bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[1120px] items-center justify-between px-4 sm:px-6">
          <Wordmark />
          <span className="text-label text-ink-muted uppercase">/dev/components</span>
        </div>
      </header>
      <main className="mx-auto max-w-[1120px] space-y-10 px-4 py-10 sm:px-6">
        <Section title="Colors">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {colors.map((color) => (
              <div key={color}>
                <div className="h-12 rounded-lg ring-1 ring-line" style={{ background: `var(--${color})` }} />
                <p className="mt-1.5 text-label text-ink-muted">{color}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type scale">
          <div className="space-y-2">
            {Object.entries(typeScale).map(([size, className]) => (
              <p key={size} className={cn(className, "flex items-baseline gap-4 text-ink")}>
                <span className="w-20 shrink-0 font-mono text-[11px] tracking-normal text-ink-muted normal-case">{size}</span>
                {size === "amount" ? "$84,000.00" : "Private dollars on a public chain"}
              </p>
            ))}
          </div>
        </Section>

        <Section title="Buttons">
          <div className="space-y-3">
            {(["primary", "secondary"] as const).map((variant) => (
              <div key={variant} className="flex flex-wrap items-center gap-3">
                {(["sm", "md", "lg"] as const).map((size) => (
                  <button key={size} type="button" className={buttonVariants({ variant, size })}>
                    {variant} {size} <ArrowRight className={cn("size-3.5", iconNudge)} />
                  </button>
                ))}
                <button type="button" disabled className={buttonVariants({ variant })}>
                  disabled
                </button>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Identity">
          <div className="flex flex-wrap items-center gap-6">
            <Wordmark />
            <LogoMark className="size-6 text-ink" />
            <span className="flex gap-2">
              {["BC", "AL", "MS", "DM", "NA"].map((initials) => (
                <AvatarPerson key={initials} initials={initials} size={32} />
              ))}
            </span>
            <span className="flex items-center gap-2 font-mono text-caption text-ink-muted">
              0x9f3ae71b…c3f1 <ButtonCopy value="0x9f3ae71b04c2c21e8e0ac3f1" label="Copy ciphertext" toastTitle="Ciphertext copied" />
            </span>
          </div>
        </Section>

        <Section title="StatusPill and TransparentBadge">
          <div className="flex flex-wrap items-center gap-3">
            {statuses.map((status) => (
              <StatusPill key={status} status={status} />
            ))}
            <TransparentBadge />
            <span className="flex gap-1.5">
              <StatusPill status="confirmed" />
              <TransparentBadge />
            </span>
          </div>
        </Section>

        <Section title="AmountDisplay">
          <div className="grid gap-4 sm:grid-cols-3">
            {amountStates.map((state) => (
              <div key={state} className="rounded-xl border border-line bg-surface p-4">
                <p className="text-label text-ink-muted">{state}</p>
                <AmountDisplay amount={state === "loading" ? undefined : 4200} state={state} className="mt-2 text-amount" />
                <AmountDisplay amount={state === "loading" ? undefined : 4200} state={state} className="mt-1 block text-ui" />
              </div>
            ))}
          </div>
        </Section>

        <Section title="WhoCanSee">
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {roles.flatMap((role) =>
              (role === "auditor" ? [true] : [true, false]).map((hasAuditor) => (
                <li key={`${role}-${hasAuditor}`} className="flex items-start gap-3 px-4 py-3">
                  <span className="w-40 shrink-0 text-label text-ink-muted">
                    {role}
                    {role !== "auditor" && (hasAuditor ? " · auditor" : " · no auditor")}
                  </span>
                  <span className="flex items-center gap-1">
                    <AmountDisplay amount={4200} className="text-ui" />
                    <WhoCanSee viewerRole={role} hasAuditor={hasAuditor} />
                  </span>
                  <span className="text-caption text-ink-muted">{whoCanSee(role, hasAuditor)}</span>
                </li>
              )),
            )}
          </ul>
        </Section>

        <Section title="EmptyState">
          <div className="grid gap-4 md:grid-cols-2">
            <EmptyState icon={Send} title="No payments yet" description="Deposit USDC, then pay your first recipient." />
            <EmptyState
              icon={Send}
              title="No payments yet"
              description="Deposit USDC, then pay your first recipient."
              action={
                <button type="button" className={buttonVariants({ size: "sm" })}>
                  <Plus className="size-3.5" /> New payment
                </button>
              }
            />
          </div>
        </Section>

        <Section title="Skeleton">
          <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <Skeleton className="size-7 rounded-full" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-3.5 w-20" />
              </div>
            ))}
          </div>
        </Section>

        <Section title="ErrorState">
          <div className="grid gap-4 md:grid-cols-2">
            <ErrorState description="We couldn't load your payments." onRetry={() => {}} />
            <ErrorState title="Payment failed" description="The transaction expired before it landed. Nothing was sent." />
          </div>
        </Section>

        <Section title="AppShell">
          <div className="space-y-6">
            {roles.map((role) => (
              <div key={role} className="space-y-4">
                <Frame role={role} label={`${role} · desktop`} />
                <Frame role={role} label={`${role} · 375px`} width={375} />
              </div>
            ))}
          </div>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 text-eyebrow tracking-[0.1em] text-ink-muted">{title}</h2>
      {children}
    </section>
  );
}

function Frame({ role, label, width }: { role: Role; label: string; width?: number }) {
  return (
    <figure>
      <figcaption className="mb-2 text-label text-ink-muted">{label}</figcaption>
      <iframe
        title={label}
        src={`/dev/components/shell/${role}`}
        className="h-[560px] max-w-full rounded-xl border border-line bg-surface shadow-card"
        style={{ width: width ?? "100%" }}
      />
    </figure>
  );
}
