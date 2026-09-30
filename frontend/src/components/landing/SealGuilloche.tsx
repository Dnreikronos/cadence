export function SealGuilloche({ className = "", rings = 7 }: { className?: string; rings?: number }) {
  return (
    <svg viewBox="-100 -100 200 200" className={className} aria-hidden>
      {Array.from({ length: rings }, (_, ring) => (
        <path
          key={ring}
          d={rosette(92 - ring * 9, 5 + ring * 0.6, 12 + ring * 2, ring * 0.35)}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.45}
          opacity={1 - ring * 0.08}
        />
      ))}
    </svg>
  )
}

function rosette(radius: number, amplitude: number, lobes: number, phase: number) {
  const steps = 720
  let d = ""
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const r = radius + amplitude * Math.sin(lobes * t + phase) + amplitude * 0.45 * Math.sin((lobes * 3 + 1) * t)
    d += `${i === 0 ? "M" : "L"}${(r * Math.cos(t)).toFixed(2)} ${(r * Math.sin(t)).toFixed(2)}`
  }
  return d + "Z"
}
