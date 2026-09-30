"use client"

import { useEffect, useRef, useState } from "react"

export function useInView(
  ref: React.RefObject<Element | null>,
  margin = "-15% 0px",
) {
  const [isInView, setIsInView] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(
      ([entry]) => setIsInView(entry.isIntersecting),
      { rootMargin: margin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, margin])
  return isInView
}

export function useReducedMotion() {
  const [isReduced, setIsReduced] = useState(false)
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    setIsReduced(media.matches)
    const onChange = () => setIsReduced(media.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])
  return isReduced
}

/** Steps through `durations` while active; each entry is how long that phase is held, in ms. */
export function useSequence(
  durations: number[],
  {
    isActive,
    isLooping = false,
    onDone,
  }: { isActive: boolean; isLooping?: boolean; onDone?: () => void },
) {
  const [phase, setPhase] = useState(0)
  const isReduced = useReducedMotion()
  const last = durations.length - 1
  const latest = useRef({ durations, onDone })
  latest.current = { durations, onDone }

  useEffect(() => {
    if (!isActive) setPhase(0)
  }, [isActive])

  useEffect(() => {
    if (!isActive || isReduced) return
    const timer = setTimeout(() => {
      if (phase < last) return setPhase(phase + 1)
      if (isLooping) return setPhase(0)
      latest.current.onDone?.()
    }, latest.current.durations[phase])
    return () => clearTimeout(timer)
  }, [phase, isActive, isReduced, isLooping, last])

  return { phase: isReduced ? last : phase, isReduced }
}
