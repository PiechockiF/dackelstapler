import { Edges, Html, useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { Component, Suspense, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import type { Delivery } from '../lib/types'
import { useTwin } from '../lib/store'
import { PulseRing } from './Effects'
import { FloorAnchor } from './FloorAnchor'
import { useLayout } from './layout'
import { COLORS } from './palette'
import { useSnapshot } from './useSnapshot'

const STATUS: Record<Delivery['status'], THREE.Color> = { ok: COLORS.ok, mismatch: COLORS.warn, blocked: COLORS.danger }

export function Deliveries() {
  const snap = useSnapshot()
  const layout = useLayout()
  return (
    <>
      {snap.deliveries
        .filter((d) => layout.byId.has(d.floor_id))
        .map((d, i) => (
          <FloorAnchor key={d.id} floorId={d.floor_id}>
            <DeliveryItem delivery={d} delay={i * 0.18} />
          </FloorAnchor>
        ))}
    </>
  )
}

function DeliveryItem({ delivery, delay }: { delivery: Delivery; delay: number }) {
  const layout = useLayout()
  const ref = useRef<THREE.Group>(null)
  const start = useRef<number | null>(null)
  const landed = useRef(false)
  const [shown, setShown] = useState(false)
  const ringRef = useRef<THREE.Group>(null)
  const focus = useTwin((s) => s.focusFloorId)
  const highlighted = useTwin((s) => !!s.highlight?.ids.includes(delivery.id))
  const recent = Date.now() - Date.parse(delivery.ts) < 6 * 3600_000
  const [x, z] = layout.toXZ(delivery.position)
  const { w, d, h } = delivery.dims_m
  const color = STATUS[delivery.status] ?? COLORS.ok

  useFrame(({ clock }) => {
    const g = ref.current
    if (!g) return
    if (!layout.introDone) {
      g.visible = false
      return
    }
    if (start.current == null) start.current = clock.elapsedTime + delay
    const t = Math.max(0, (clock.elapsedTime - start.current) / 1.1)
    g.visible = clock.elapsedTime >= start.current
    if (g.visible && !shown) setShown(true)
    const y = t >= 1 ? 0 : 14 * (1 - bounce(t))
    g.position.y = y
    g.rotation.y = THREE.MathUtils.degToRad(delivery.rotation_deg) + (1 - Math.min(1, t)) * 1.5
    if (!landed.current && t >= 0.36) landed.current = true
    if (ringRef.current) ringRef.current.visible = landed.current
  })

  const showLabel = shown && (highlighted || focus === delivery.floor_id || (focus == null && recent))
  return (
    <group position={[x, 0, z]}>
      <group ref={ref} visible={false}>
        {delivery.model_url ? (
          <ModelBoundary fallback={<Crate w={w} d={d} h={h} />}>
            <Suspense fallback={<Crate w={w} d={d} h={h} />}>
              <DeliveryModel url={delivery.model_url} />
            </Suspense>
          </ModelBoundary>
        ) : (
          <Crate w={w} d={d} h={h} />
        )}
        {showLabel && (
          <Html position={[0, h + 0.7, 0]} center zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
            <div className="flex flex-col items-center">
              <div className="whitespace-nowrap rounded-md border border-white/15 bg-slate-950/70 px-2 py-1 text-[10px] leading-tight text-slate-100 backdrop-blur">
                <div className="font-semibold">{delivery.label}</div>
                <div className="font-mono text-slate-300">
                  {w.toFixed(2)} × {d.toFixed(2)} × {h.toFixed(2)} m
                </div>
              </div>
              <div className="h-3 w-px" style={{ background: `#${color.getHexString()}` }} />
            </div>
          </Html>
        )}
      </group>
      <group ref={ringRef} visible={false}>
        <PulseRing x={0} z={0} radius={Math.max(w, d) * 1.4 + 0.8} color={color} />
      </group>
    </group>
  )
}

function Crate({ w, d, h }: { w: number; d: number; h: number }) {
  return (
    <group>
      <mesh position={[0, h / 2 + 0.12, 0]} castShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#c08a4a" roughness={0.75} metalness={0.05} emissive="#3a2208" emissiveIntensity={0.4} />
        <Edges color={new THREE.Color('#ffd28a').multiplyScalar(2.2)} />
      </mesh>
      {/* pallet */}
      <mesh position={[0, 0.06, 0]} castShadow>
        <boxGeometry args={[w * 1.05, 0.12, d * 1.05]} />
        <meshStandardMaterial color="#8a6a45" roughness={0.9} />
      </mesh>
    </group>
  )
}

function DeliveryModel({ url }: { url: string }) {
  const gltf = useGLTF(url)
  const scene = useMemo(() => gltf.scene.clone(true), [gltf])
  return <primitive object={scene} />
}

class ModelBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function bounce(t: number) {
  const n1 = 7.5625
  const d1 = 2.75
  if (t < 1 / d1) return n1 * t * t
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375
  return n1 * (t -= 2.625 / d1) * t + 0.984375
}
