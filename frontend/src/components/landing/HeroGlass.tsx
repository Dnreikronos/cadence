"use client"

import { useEffect, useRef, useState } from "react"
import dynamic from "next/dynamic"
import Image from "next/image"
import { cn } from "@/lib/utils"
import { useInView, useReducedMotion } from "./use-sequence"

const HeroGlassScene = dynamic(
  () => import("./HeroGlassScene").then((module) => module.HeroGlassScene),
  { ssr: false },
)

export function HeroGlass() {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, "0px")
  const isReduced = useReducedMotion()
  const [canRender, setCanRender] = useState(false)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    const isWide = window.matchMedia("(min-width: 768px)").matches
    const canvas = document.createElement("canvas")
    setCanRender(isWide && Boolean(canvas.getContext("webgl2")))
  }, [])

  return (
    <div
      ref={ref}
      className="relative aspect-16/10 w-full mask-[radial-gradient(ellipse_52%_54%_at_50%_50%,#000_40%,transparent)] sm:aspect-21/9"
    >
      <Image
        src="/landing/hero-glass.webp"
        alt="Coins pass through a pane of frosted glass. Behind it they blur; they come out the other side sealed."
        fill
        priority
        sizes="(min-width: 1248px) 1200px, 100vw"
        className={cn(
          "object-cover transition-opacity duration-700",
          isReady ? "opacity-0" : "opacity-100",
        )}
      />
      {canRender && (
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-700",
            isReady ? "opacity-100" : "opacity-0",
          )}
        >
          <HeroGlassScene
            isPlaying={isInView}
            isStill={isReduced}
            onReady={() => setIsReady(true)}
          />
        </div>
      )}
    </div>
  )
}
