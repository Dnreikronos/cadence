import { cn } from "@/lib/utils"

const base =
  "group/btn inline-flex items-center justify-center gap-2 rounded-full font-medium transition-[background-color,border-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-50 [&_svg]:transition-transform [&_svg]:duration-200 [&_svg]:ease-[var(--ease-out)]"

const variants = {
  primary: "bg-ink text-white hover:bg-ink/88",
  secondary: "border border-line bg-surface text-ink hover:border-ink/25",
}

const sizes = {
  sm: "h-7 gap-1.5 px-3 text-caption",
  md: "h-9 px-4 text-ui",
  lg: "h-11 px-5 text-button",
}

export function buttonVariants({
  variant = "primary",
  size = "md",
  className,
}: { variant?: keyof typeof variants; size?: keyof typeof sizes; className?: string } = {}) {
  return cn(base, variants[variant], sizes[size], className)
}

export const iconNudge = "group-hover/btn:translate-x-[3px]"
