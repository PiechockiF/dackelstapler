import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { mobileGraphics } from '../lib/mode'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Route, XY } from '../lib/types'
import { useTwin } from '../lib/store'
import { Beam, PulseRing } from './Effects'
import { FloorAnchor } from './FloorAnchor'
import { type TwinLayout, useLayout } from './layout'
import { COLORS } from './palette'
import { makeFlowMaterial } from './shaders'

const LIFT_Y = 0.45
const RADIUS = 0.24
const SPEED = 7 // m/s of the avatar

interface Seg { kind: 'floor'; floorId: string; curve: THREE.CurvePath<THREE.Vector3>; start: number; length: number }
interface Hop { kind: 'hop'; from: string; to: string; a: [number, number]; b: [number, number]; start: number; length: number; connector?: string }
type Part = Seg | Hop

/** Polyline with rounded corners (quadratic fillets) in floor-local space. */
function filletPath(points: THREE.Vector3[], r = 0.9): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>()
  const pts = points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 0.05)
  if (pts.length < 2) {
    const p = pts[0] ?? new THREE.Vector3()
    path.add(new THREE.LineCurve3(p.clone(), p.clone().add(new THREE.Vector3(0.01, 0, 0))))
    return path
  }
  let cursor = pts[0].clone()
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const inLen = cur.distanceTo(prev)
    const outLen = cur.distanceTo(next)
    const k = Math.min(r, inLen / 2, outLen / 2)
    const a = cur.clone().add(prev.clone().sub(cur).normalize().multiplyScalar(k))
    const b = cur.clone().add(next.clone().sub(cur).normalize().multiplyScalar(k))
    if (a.distanceTo(cursor) > 1e-3) path.add(new THREE.LineCurve3(cursor.clone(), a))
    path.add(new THREE.QuadraticBezierCurve3(a, cur.clone(), b))
    cursor = b
  }
  const last = pts[pts.length - 1]
  if (last.distanceTo(cursor) > 1e-3) path.add(new THREE.LineCurve3(cursor.clone(), last.clone()))
  return path
}

function hopCurve(layout: TwinLayout, h: Hop) {
  const ya = layout.y(h.from) + LIFT_Y
  const yb = layout.y(h.to) + LIFT_Y
  const dy = yb - ya
  return new THREE.CubicBezierCurve3(
    new THREE.Vector3(h.a[0], ya, h.a[1]),
    new THREE.Vector3(h.a[0], ya + dy * 0.55, h.a[1]),
    new THREE.Vector3(h.b[0], yb - dy * 0.55, h.b[1]),
    new THREE.Vector3(h.b[0], yb, h.b[1]),
  )
}

export function buildParts(route: Route, layout: TwinLayout): { parts: Part[]; total: number } {
  const parts: Part[] = []
  let s = 0
  const segs = route.floors.filter((f) => layout.byId.has(f.floor_id) && f.points.length)
  segs.forEach((f, i) => {
    const pts = f.points.map((p: XY) => {
      const [x, z] = layout.toXZ(p)
      return new THREE.Vector3(x, LIFT_Y, z)
    })
    const curve = filletPath(pts)
    const length = Math.max(0.01, curve.getLength())
    parts.push({ kind: 'floor', floorId: f.floor_id, curve, start: s, length })
    s += length
    const next = segs[i + 1]
    if (next) {
      const last = pts[pts.length - 1]
      const [nx, nz] = layout.toXZ(next.points[0])
      const conn = route.connectors.find((c) => c.from_floor_id === f.floor_id && c.to_floor_id === next.floor_id)
      const len = Math.abs(layout.targetY(next.floor_id) - layout.targetY(f.floor_id)) + Math.hypot(nx - last.x, nz - last.z)
      parts.push({ kind: 'hop', from: f.floor_id, to: next.floor_id, a: [last.x, last.z], b: [nx, nz], start: s, length: len, connector: conn?.id })
      s += len
    }
  })
  return { parts, total: s }
}

export function RouteView() {
  const route = useTwin((s) => s.route)
  const layout = useLayout()
  const built = useMemo(() => (route && route.reachable ? buildParts(route, layout) : null), [route, layout])
  if (!route || !built || !built.parts.length) return null
  return <RouteBody key={JSON.stringify(route.space_path) + route.length_m} route={route} parts={built.parts} total={built.total} />
}

function RouteBody({ route, parts, total }: { route: Route; parts: Part[]; total: number }) {
  const layout = useLayout()
  const color = route.step_free ? COLORS.accent2 : COLORS.accent
  const born = useRef<number | null>(null)
  const mats = useMemo(
    () => parts.map((p) => makeFlowMaterial(color, { offset: p.start, length: p.length, total })),
    [parts, color, total],
  )
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats])
  const head = useRef(0)
  const avatar = useRef<THREE.Group>(null)

  useFrame(({ clock }) => {
    if (born.current == null) born.current = clock.elapsedTime
    const age = clock.elapsedTime - born.current
    const reveal = mobileGraphics ? total + 1 : Math.min(total + 1, (age / 1.8) * total * 1.05)
    const cycle = total / SPEED + 1.2
    const s = age < 1.8 ? reveal : Math.min(total, ((age - 1.8) % cycle) * SPEED)
    head.current = s
    for (const m of mats) {
      m.uniforms.uTime.value = mobileGraphics ? 1 : clock.elapsedTime
      m.uniforms.uReveal.value = reveal
      m.uniforms.uHead.value = s
    }
    // avatar position
    const part = parts.find((p) => s <= p.start + p.length) ?? parts[parts.length - 1]
    const u = THREE.MathUtils.clamp((s - part.start) / part.length, 0, 1)
    let pt: THREE.Vector3
    if (part.kind === 'floor') {
      pt = part.curve.getPointAt(u)
      pt.y += layout.y(part.floorId)
    } else pt = hopCurve(layout, part).getPoint(u)
    avatar.current?.position.copy(pt)
  })

  const first = parts[0] as Seg
  const last = [...parts].reverse().find((p) => p.kind === 'floor') as Seg
  const startPt = first.curve.getPointAt(0)
  const endPt = last.curve.getPointAt(1)

  return (
    <group>
      {parts.map((p, i) =>
        p.kind === 'floor' ? (
          <FloorAnchor key={i} floorId={p.floorId}>
            <SegmentTube curve={p.curve} length={p.length} material={mats[i]} />
          </FloorAnchor>
        ) : (
          <HopTube key={i} hop={p} material={mats[i]} />
        ),
      )}
      <FloorAnchor floorId={first.floorId}>
        <PulseRing x={startPt.x} z={startPt.z} radius={1.6} color={COLORS.ok} />
      </FloorAnchor>
      <FloorAnchor floorId={last.floorId}>
        <PulseRing x={endPt.x} z={endPt.z} radius={2.6} color={color} />
        <Beam x={endPt.x} z={endPt.z} radius={0.7} height={layout.gap * 1.5 + 8} color={color} />
        <Html position={[endPt.x, 2.8, endPt.z]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded-full border border-sky-300/50 bg-sky-500/20 px-3 py-1 text-xs font-semibold text-sky-50 shadow-[0_0_24px_rgba(56,189,248,0.5)] backdrop-blur">
            {route.length_m.toFixed(1)} m{route.step_free ? ' · step-free' : ''}
          </div>
        </Html>
      </FloorAnchor>
      <group ref={avatar} visible={!mobileGraphics}>
        <mesh>
          <sphereGeometry args={[0.32, 24, 24]} />
          <meshBasicMaterial color={new THREE.Color('#ffffff').multiplyScalar(4)} toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.6, 24, 24]} />
          <meshBasicMaterial color={color.clone().multiplyScalar(2)} transparent opacity={0.25} toneMapped={false} depthWrite={false} />
        </mesh>
        <pointLight color={color} intensity={6} distance={8} decay={1.5} />
      </group>
    </group>
  )
}

function SegmentTube({ curve, length, material }: { curve: THREE.CurvePath<THREE.Vector3>; length: number; material: THREE.ShaderMaterial }) {
  const geo = useMemo(() => new THREE.TubeGeometry(curve, Math.min(800, Math.max(16, Math.ceil(length * 4))), RADIUS, 10, false), [curve, length])
  useEffect(() => () => geo.dispose(), [geo])
  return <mesh geometry={geo} material={material} renderOrder={20} />
}

function HopTube({ hop, material }: { hop: Hop; material: THREE.ShaderMaterial }) {
  const layout = useLayout()
  const mesh = useRef<THREE.Mesh>(null)
  const lastVersion = useRef(-1)
  useFrame(() => {
    if (!mesh.current || layout.version === lastVersion.current) return
    lastVersion.current = layout.version
    const old = mesh.current.geometry
    mesh.current.geometry = new THREE.TubeGeometry(hopCurve(layout, hop), 48, RADIUS * 1.1, 10, false)
    old.dispose()
  })
  return <mesh ref={mesh} material={material} renderOrder={20} />
}
