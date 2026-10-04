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
// `hasAuditor` undefined means not known yet: the longer sentence is the safe one,
// never "no auditor".
export function whoCanSee(viewerRole: Role, hasAuditor: boolean | undefined) {
  const readers = {
    admin: [
      "Your company",
      "the recipient",
      ...(hasAuditor === undefined
        ? ["anyone your company has designated"]
        : hasAuditor
          ? ["your auditor"]
          : []),
      "Cadence",
    ],
    recipient: [
      "You",
      "the company that paid you",
      ...(hasAuditor === undefined
        ? ["anyone the company has designated"]
        : hasAuditor
          ? ["its auditor"]
          : []),
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
  note,
  className,
  label = "Who can see this amount",
  description,
  cadenceLine = "Cadence reads amounts to prove transfers and to answer reads and exports by the company, the recipient and the auditor. Every read is logged.",
}: {
  viewerRole: Role
  // Undefined while it is not known whether an auditor exists.
  hasAuditor: boolean | undefined
  // An extra sentence, for a place where some amounts are an exception.
  note?: string
  className?: string
  // For a page that shows no amount of its own: its own label and texts.
  label?: string
  description?: string
  // Replaces the sentence about what Cadence reads.
  cadenceLine?: string
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
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
            {description ?? whoCanSee(viewerRole, hasAuditor)}
          </PopoverDescription>
        </PopoverHeader>
        <p className="text-caption/normal text-ink-muted">{cadenceLine}</p>
        {note && <p className="text-caption/normal text-ink-muted">{note}</p>}
      </PopoverContent>
    </Popover>
  )
}
