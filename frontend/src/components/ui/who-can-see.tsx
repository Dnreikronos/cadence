"use client"

import { Eye } from "lucide-react"
import type { Role } from "@/lib/auth/guard"
import { cn } from "@/lib/utils"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover"

// Cadence runs the proof service and holds viewing keys (ADR B17), so it is always named.
export function whoCanSee(viewerRole: Role, hasAuditor: boolean) {
  const readers = {
    admin: [
      "Your company",
      "the recipient",
      ...(hasAuditor ? ["your auditor"] : []),
      "Cadence",
    ],
    recipient: [
      "You",
      "the company that paid you",
      ...(hasAuditor ? ["its auditor"] : []),
      "Cadence",
    ],
    auditor: ["You", "the company", "the recipient", "Cadence"],
  }[viewerRole]
  return `${list(readers)} can read this amount. The public cannot: on-chain it is ciphertext.`
}

function list(items: string[]) {
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

export function WhoCanSee({
  viewerRole,
  hasAuditor,
  className,
}: {
  viewerRole: Role
  hasAuditor: boolean
  className?: string
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Who can see this amount"
        className={cn(
          "inline-grid size-6 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-150 outline-none hover:bg-canvas hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 data-popup-open:bg-canvas data-popup-open:text-ink",
          className,
        )}
      >
        <Eye className="size-3.5" strokeWidth={1.75} />
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>Who can see this</PopoverTitle>
          <PopoverDescription>
            {whoCanSee(viewerRole, hasAuditor)}
          </PopoverDescription>
        </PopoverHeader>
        <p className="text-caption/normal text-ink-muted">
          Cadence reads amounts only to prove transfers, and every read is
          logged.
        </p>
      </PopoverContent>
    </Popover>
  )
}
