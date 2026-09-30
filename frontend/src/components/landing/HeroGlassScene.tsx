"use client"

import { useMemo, useRef } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { Environment, Lightformer, MeshTransmissionMaterial } from "@react-three/drei"
import * as THREE from "three"

const coinCount = 14
const coinRadius = 0.45
const coinDepth = 0.15
const coinHeight = -0.15
const pathLength = 18
const loopSeconds = 30
const paneWidth = 2.7
const paneHeight = 3.5
const paneDepth = 0.1
const paneRadius = 0.04
const floorHeight = -2.15
const direction = new THREE.Vector3(1, 0, -1.2).normalize()
const paneAngle = Math.atan2(-direction.x, -direction.z)
const lime = "#d6f53d"
const lavender = "#a393ff"

export function HeroGlassScene({ isPlaying, isStill, onReady }: { isPlaying: boolean; isStill: boolean; onReady: () => void }) {
  return (
    <Canvas
      frameloop={isPlaying && !isStill ? "always" : "demand"}
      dpr={[1, 1.75]}
      camera={{ position: [0.6, 3.2, 20], fov: 17 }}
      gl={{ antialias: true, alpha: false, toneMappingExposure: 1 }}
      onCreated={({ camera, gl }) => {
        gl.toneMapping = THREE.NeutralToneMapping
        camera.lookAt(0.4, -0.4, 0)
        requestAnimationFrame(onReady)
      }}
    >
      <color attach="background" args={["#efece6"]} />
      <fog attach="fog" args={["#efece6", 26, 42]} />
      <ambientLight intensity={0.35} color="#fbfaf7" />
      <directionalLight position={[-6, 8, 7]} intensity={2.6} color="#fffcf6" />
      <Environment resolution={256} environmentIntensity={0.8}>
        <color attach="background" args={["#e6e2da"]} />
        <Lightformer form="rect" intensity={2.6} position={[-4, 4, 5]} scale={[7, 4, 1]} />
        <Lightformer form="rect" intensity={1.2} position={[5, 1, 4]} scale={[3, 6, 1]} />
        <Lightformer form="rect" color={lime} intensity={3} position={[2, 6, 0]} rotation-x={Math.PI / 2} scale={[5, 0.8, 1]} />
        <Lightformer form="rect" color={lavender} intensity={2.4} position={[1, -4, 1]} rotation-x={-Math.PI / 2} scale={[6, 1, 1]} />
      </Environment>
      <Rig isStill={isStill}>
        <Scene isStill={isStill} />
      </Rig>
    </Canvas>
  )
}

function Rig({ isStill, children }: { isStill: boolean; children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null)
  useFrame((state, delta) => {
    if (!group.current || isStill) return
    const easing = 1 - Math.exp(-delta * 3)
    group.current.rotation.y += (state.pointer.x * 0.1 - group.current.rotation.y) * easing
    group.current.rotation.x += (-state.pointer.y * 0.04 - group.current.rotation.x) * easing
  })
  return <group ref={group}>{children}</group>
}

function Scene({ isStill }: { isStill: boolean }) {
  const coins = useRef<(THREE.Group | null)[]>([])
  const progress = useRef(0.013)
  const materials = useCoinMaterials()
  const pane = useMemo(paneGeometry, [])
  const shadow = useMemo(() => radialTexture("#5d5445", 0.32), [])
  const orientation = useMemo(coinOrientation, [])

  useFrame((_, delta) => {
    if (!isStill) progress.current += Math.min(delta, 0.05) / loopSeconds
    const cos = Math.cos(paneAngle)
    const sin = Math.sin(paneAngle)
    const local: THREE.Vector3[] = []
    coins.current.forEach((coin, index) => {
      if (!coin) return
      const phase = (index / coinCount + progress.current) % 1
      const distance = viscousEase(phase - 0.5) * pathLength
      const x = direction.x * distance
      const z = direction.z * distance
      const [body, seal, floor] = coin.children
      body.position.set(x, coinHeight, z)
      body.scale.setScalar(smoothstep(0.5, 0.43, Math.abs(phase - 0.5)))
      floor.position.set(x + 0.45, floorHeight, z + 0.1)
      floor.scale.copy(body.scale)
      const point = new THREE.Vector3(x * cos - z * sin, coinHeight, x * sin + z * cos)
      const sealMaterial = (seal as THREE.Mesh).material as THREE.Material[]
      sealMaterial[1].opacity = smoothstep(-0.05, -1.1, point.z)
      seal.position.copy(body.position)
      seal.scale.copy(body.scale).multiplyScalar(1.002)
      local.push(point)
    })
    deformPane(pane, local)
  })

  return (
    <>
      {Array.from({ length: coinCount }, (_, index) => (
        <group key={index} ref={(node) => void (coins.current[index] = node)}>
          <mesh quaternion={orientation} material={[materials.rim, materials.open, materials.rim]}>
            <cylinderGeometry args={[coinRadius, coinRadius, coinDepth, 72]} />
          </mesh>
          <mesh quaternion={orientation} material={[materials.hidden, materials.sealed[index], materials.hidden]}>
            <cylinderGeometry args={[coinRadius, coinRadius, coinDepth, 72]} />
          </mesh>
          <group rotation-y={paneAngle}>
            <mesh rotation-x={-Math.PI / 2}>
              <planeGeometry args={[coinRadius * 3.4, 0.7]} />
              <meshBasicMaterial map={shadow} transparent depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
        </group>
      ))}
      <group rotation-y={paneAngle}>
        <mesh geometry={pane.geometry} frustumCulled={false}>
          <MeshTransmissionMaterial
            transmission={1}
            roughness={0.42}
            thickness={0.35}
            ior={1.4}
            chromaticAberration={0.04}
            anisotropicBlur={0.2}
            distortion={0}
            samples={10}
            resolution={768}
            color="#ffffff"
            clearcoat={1}
            clearcoatRoughness={0.05}
          />
        </mesh>
        <PaneLight />
      </group>
    </>
  )
}

function PaneLight() {
  const textures = useMemo(
    () => ({
      side: gradientTexture("vertical", [`${lime}ff`, `${lime}99`, "#ffffff66", `${lavender}aa`, `${lavender}ff`]),
      top: gradientTexture("horizontal", [`${lime}33`, `${lime}ff`]),
      bottom: gradientTexture("horizontal", [`${lavender}33`, `${lavender}ff`]),
      limeHalo: radialTexture(lime, 0.3),
      lavenderGlow: radialTexture(lavender, 0.35),
      shadow: radialTexture("#5d5445", 0.22),
    }),
    [],
  )
  const edge = { transparent: true, depthWrite: false, toneMapped: false }
  return (
    <>
      <mesh position={[paneWidth / 2 - 0.004, 0, 0]}>
        <boxGeometry args={[0.014, paneHeight - paneRadius, paneDepth + 0.002]} />
        <meshBasicMaterial map={textures.side} {...edge} />
      </mesh>
      <mesh position={[0, paneHeight / 2 - 0.004, 0]}>
        <boxGeometry args={[paneWidth - paneRadius, 0.014, paneDepth + 0.002]} />
        <meshBasicMaterial map={textures.top} {...edge} />
      </mesh>
      <mesh position={[0, -paneHeight / 2 + 0.004, 0]}>
        <boxGeometry args={[paneWidth - paneRadius, 0.014, paneDepth + 0.002]} />
        <meshBasicMaterial map={textures.bottom} {...edge} />
      </mesh>
      <mesh position={[paneWidth * 0.2, paneHeight / 2 + 0.05, 0.08]}>
        <planeGeometry args={[paneWidth * 1.2, 0.4]} />
        <meshBasicMaterial map={textures.limeHalo} {...edge} />
      </mesh>
      <mesh position={[paneWidth * 0.15, floorHeight + 0.01, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[paneWidth * 1.3, 1.1]} />
        <meshBasicMaterial map={textures.lavenderGlow} {...edge} />
      </mesh>
      <mesh position={[0.3, floorHeight, 0.15]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[paneWidth * 1.4, 0.8]} />
        <meshBasicMaterial map={textures.shadow} {...edge} />
      </mesh>
    </>
  )
}

function coinOrientation() {
  const normal = direction.clone().negate()
  const back = new THREE.Vector3(0, -1, 0)
  const side = new THREE.Vector3().crossVectors(normal, back)
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, normal, back))
}

function viscousEase(offset: number) {
  const drag = 0.3
  const width = 0.05
  const shape = (value: number) => value - drag * width * Math.tanh(value / width)
  return (shape(offset) / shape(0.5)) * 0.5
}

function paneGeometry() {
  const geometry = new THREE.BoxGeometry(1, 1, 1, 60, 76, 2)
  const position = geometry.attributes.position as THREE.BufferAttribute
  const normal = geometry.attributes.normal as THREE.BufferAttribute
  const half = new THREE.Vector3(paneWidth / 2, paneHeight / 2, paneDepth / 2)
  const inner = half.clone().subScalar(paneRadius)
  const point = new THREE.Vector3()
  const core = new THREE.Vector3()
  const flat: { index: number; x: number; y: number; side: number; mask: number }[] = []

  for (let index = 0; index < position.count; index++) {
    point.fromBufferAttribute(position, index).multiply(half).multiplyScalar(2)
    core.copy(point).clamp(inner.clone().negate(), inner)
    const outward = point.clone().sub(core).normalize()
    point.copy(core).addScaledVector(outward, paneRadius)
    position.setXYZ(index, point.x, point.y, point.z)
    normal.setXYZ(index, outward.x, outward.y, outward.z)
    if (Math.abs(outward.z) < 0.999) continue
    const edge = Math.min(inner.x - Math.abs(point.x), inner.y - Math.abs(point.y))
    flat.push({ index, x: point.x, y: point.y, side: Math.sign(outward.z), mask: smoothstep(0, 0.4, edge) })
  }
  return { geometry, flat }
}

function deformPane(pane: ReturnType<typeof paneGeometry>, coins: THREE.Vector3[]) {
  const position = pane.geometry.attributes.position as THREE.BufferAttribute
  const normal = pane.geometry.attributes.normal as THREE.BufferAttribute
  const pushes = coins.map((coin) => ({ x: coin.x, y: coin.y, ...membrane(paneDepth / 2 - (coin.z - coinDepth / 2)) })).filter((push) => push.amount !== 0)

  for (const vertex of pane.flat) {
    let height = 0
    let slopeX = 0
    let slopeY = 0
    for (const push of pushes) {
      const dx = vertex.x - push.x
      const dy = vertex.y - push.y
      const distance = Math.hypot(dx, dy) || 1e-4
      const [value, slope] = push.ripple < 0 ? dent(distance, push.amount) : ripple(distance, push.amount, push.ripple)
      height += value
      slopeX += (slope * dx) / distance
      slopeY += (slope * dy) / distance
    }
    height *= vertex.mask
    slopeX *= vertex.mask
    slopeY *= vertex.mask
    position.setZ(vertex.index, (vertex.side * paneDepth) / 2 - height)
    const length = Math.hypot(slopeX, slopeY, 1)
    normal.setXYZ(vertex.index, (vertex.side * slopeX) / length, (vertex.side * slopeY) / length, vertex.side / length)
  }
  position.needsUpdate = true
  normal.needsUpdate = true
}

function membrane(depth: number) {
  const stretch = 0.32
  if (depth <= 0) return { amount: 0, ripple: -1 }
  if (depth < stretch) return { amount: depth + 0.025 * smoothstep(0, 0.06, depth), ripple: -1 }
  const release = depth - stretch
  const amount = (stretch + 0.025) * Math.exp(-release / 0.55)
  return { amount: amount < 0.002 ? 0 : amount, ripple: release }
}

function dent(distance: number, amount: number): [number, number] {
  const plateau = coinRadius + 0.05
  const falloff = 0.6
  if (distance <= plateau) return [amount, 0]
  const reach = (distance - plateau) / falloff
  const value = amount * Math.exp(-reach * reach)
  return [value, (value * -2 * reach) / falloff]
}

function ripple(distance: number, amount: number, release: number): [number, number] {
  const wave = 5
  const speed = 10
  const spread = 1.4
  const envelope = Math.exp(-(distance * distance) / (spread * spread))
  const angle = release * speed - distance * wave
  const value = amount * envelope * Math.cos(angle)
  const slope = amount * envelope * (wave * Math.sin(angle) - ((2 * distance) / (spread * spread)) * Math.cos(angle))
  return [value, slope]
}

function useCoinMaterials() {
  return useMemo(() => {
    const rim = new THREE.MeshStandardMaterial({ color: "#ccc7bc", roughness: 0.72 })
    const open = new THREE.MeshStandardMaterial({ ...coinTextures(drawDollar), bumpScale: 4, roughness: 0.7 })
    const sealedTextures = coinTextures(drawLock)
    const sealed = Array.from(
      { length: coinCount },
      () =>
        new THREE.MeshStandardMaterial({
          ...sealedTextures,
          bumpScale: 4,
          roughness: 0.7,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        }),
    )
    return { rim, open, sealed, hidden: new THREE.MeshBasicMaterial({ visible: false }) }
  }, [])
}

function coinTextures(drawGlyph: (context: CanvasRenderingContext2D) => void) {
  const make = (isBump: boolean) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 512
    const context = canvas.getContext("2d")!
    context.fillStyle = isBump ? "#808080" : "#d3cec3"
    context.fillRect(0, 0, 512, 512)
    context.strokeStyle = isBump ? "#c0c0c0" : "#c6c0b3"
    context.lineWidth = 22
    context.beginPath()
    context.arc(256, 256, 214, 0, Math.PI * 2)
    context.stroke()
    context.strokeStyle = context.fillStyle = isBump ? "#dcdcdc" : "#a8a090"
    drawGlyph(context)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = isBump ? THREE.NoColorSpace : THREE.SRGBColorSpace
    texture.anisotropy = 4
    texture.center.set(0.5, 0.5)
    texture.rotation = Math.PI / 2
    return texture
  }
  return { map: make(false), bumpMap: make(true) }
}

function drawDollar(context: CanvasRenderingContext2D) {
  context.font = "600 280px Helvetica, Arial, sans-serif"
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillText("$", 256, 268)
}

function drawLock(context: CanvasRenderingContext2D) {
  context.lineWidth = 28
  context.beginPath()
  context.arc(256, 222, 54, Math.PI, 0)
  context.lineTo(310, 252)
  context.moveTo(202, 252)
  context.lineTo(202, 222)
  context.stroke()
  context.beginPath()
  context.roundRect(172, 248, 168, 128, 20)
  context.fill()
}

function gradientTexture(axis: "vertical" | "horizontal", stops: string[]) {
  const canvas = document.createElement("canvas")
  canvas.width = axis === "horizontal" ? 256 : 4
  canvas.height = axis === "vertical" ? 256 : 4
  const context = canvas.getContext("2d")!
  const gradient = axis === "vertical" ? context.createLinearGradient(0, 0, 0, 256) : context.createLinearGradient(0, 0, 256, 0)
  stops.forEach((stop, index) => gradient.addColorStop(index / (stops.length - 1), stop))
  context.fillStyle = gradient
  context.fillRect(0, 0, canvas.width, canvas.height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function radialTexture(color: string, alpha = 0.9) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 256
  const context = canvas.getContext("2d")!
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128)
  gradient.addColorStop(0, `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`)
  gradient.addColorStop(1, `${color}00`)
  context.fillStyle = gradient
  context.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}
