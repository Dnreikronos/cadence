"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"

export function ButtonCopy({
  value,
  label = "Copy",
  toastTitle = "Copied",
  toastDescription,
}: {
  value: string
  label?: string
  toastTitle?: string
  toastDescription?: string
}) {
  const [isCopied, setIsCopied] = useState(false)

  async function copy() {
    await navigator.clipboard?.writeText(value)
    setIsCopied(true)
    toast(toastTitle, { description: toastDescription })
    setTimeout(() => setIsCopied(false), 1600)
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={isCopied ? "Copied" : label}
      className="relative grid size-7 shrink-0 place-items-center rounded-md border border-line bg-surface text-ink-muted transition-[transform,color,border-color] duration-150 ease-out hover:border-ink/25 hover:text-ink active:scale-[0.94]"
    >
      <Copy
        className={`absolute size-3.5 transition-[opacity,scale,filter] duration-200 ease-out ${isCopied ? "scale-75 opacity-0 blur-[2px]" : "scale-100 opacity-100"}`}
      />
      <Check
        className={`absolute size-3.5 text-emerald-600 transition-[opacity,scale,filter] duration-200 ease-out ${isCopied ? "scale-100 opacity-100" : "scale-75 opacity-0 blur-[2px]"}`}
      />
    </button>
  )
}
