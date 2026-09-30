import { cn } from "@/lib/utils"

export function AvatarPerson({
  initials,
  size = 32,
  className = "",
}: {
  initials: string
  size?: number
  className?: string
}) {
  const tone =
    tones[
      (initials.charCodeAt(0) + (initials.charCodeAt(1) || 0)) % tones.length
    ]
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full font-medium text-ink ring-1 ring-black/5",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, size * 0.34),
        background: tone,
      }}
    >
      <span
        aria-hidden
        className="absolute -right-1/4 -bottom-1/4 size-3/4 rounded-full bg-white/35"
      />
      <span className="relative">{initials}</span>
    </span>
  )
}

const tones = [
  "linear-gradient(135deg, var(--glow), color-mix(in oklab, var(--glow) 55%, white))",
  "linear-gradient(135deg, var(--uv), color-mix(in oklab, var(--uv) 45%, white))",
  "linear-gradient(135deg, #ffb58f, #ffe2d1)",
  "linear-gradient(135deg, #8ccfff, #d9efff)",
  "linear-gradient(135deg, #d9d7cc, #f4f3ee)",
]
