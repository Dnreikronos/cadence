"use client"

import { useEffect } from "react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import Lenis from "lenis"

gsap.registerPlugin(ScrollTrigger)

export function LandingMotion() {
  useEffect(() => {
    const media = gsap.matchMedia()

    media.add("(prefers-reduced-motion: no-preference)", () => {
      document.documentElement.classList.add("motion-ready")
      const lenis = new Lenis({ lerp: 0.1, anchors: true })
      lenis.on("scroll", ScrollTrigger.update)
      const tick = (time: number) => lenis.raf(time * 1000)
      gsap.ticker.add(tick)
      gsap.ticker.lagSmoothing(0)

      gsap.to("[data-progress]", {
        scaleX: 1,
        ease: "none",
        scrollTrigger: { trigger: document.body, start: "top top", end: "bottom bottom", scrub: 0.3 },
      })

      gsap.utils.toArray<HTMLElement>("[data-split]").forEach((heading) => {
        gsap.from(heading.querySelectorAll("[data-word]"), {
          yPercent: 110,
          duration: 1.1,
          ease: "expo.out",
          stagger: 0.045,
          scrollTrigger: { trigger: heading, start: "top 88%" },
        })
      })

      ScrollTrigger.batch("[data-reveal]", {
        start: "top 90%",
        once: true,
        onEnter: (elements) =>
          gsap.fromTo(
            elements,
            { autoAlpha: 0, y: 40, filter: "blur(8px)" },
            { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 1, ease: "expo.out", stagger: 0.09 },
          ),
      })

      gsap.utils.toArray<HTMLElement>("[data-parallax]").forEach((element) => {
        gsap.to(element, {
          yPercent: Number(element.dataset.parallax) * -100,
          ease: "none",
          scrollTrigger: { trigger: element, start: "top bottom", end: "bottom top", scrub: true },
        })
      })

      gsap.utils.toArray<HTMLElement>("[data-count]").forEach((element) => {
        const counter = { value: 0 }
        gsap.to(counter, {
          value: Number(element.dataset.count),
          duration: 1.6,
          ease: "expo.out",
          scrollTrigger: { trigger: element, start: "top 92%" },
          onUpdate: () => (element.textContent = Math.round(counter.value).toLocaleString("en-US")),
        })
      })

      return () => {
        gsap.ticker.remove(tick)
        lenis.destroy()
      }
    })

    return () => media.revert()
  }, [])

  return null
}

export function SplitWords({ children, className }: { children: string; className?: string }) {
  return (
    <span data-split className={className}>
      {children.split(" ").map((word, index) => (
        <span key={index} className="inline-block overflow-hidden pb-[0.08em] align-bottom">
          <span data-word className="inline-block">
            {word}
            {"\u00a0"}
          </span>
        </span>
      ))}
    </span>
  )
}
