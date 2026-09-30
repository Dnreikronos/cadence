const buttonBase =
  "group/btn inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-medium transition-[background-color,border-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&_svg]:transition-transform [&_svg]:duration-200 [&_svg]:ease-[var(--ease-out)]"

export const buttonPrimary = `${buttonBase} bg-ink text-white hover:bg-ink/88`

export const buttonSecondary = `${buttonBase} border border-line bg-white text-ink hover:border-ink/25`

export const iconNudge = "group-hover/btn:translate-x-[3px]"
