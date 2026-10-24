import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { mobileGraphics } from '../lib/mode'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Building, XY } from '../lib/types'
import { useTwin } from '../lib/store'
import { polygonFill, polygonOutline } from './buildFloor'
import { Beam, PulseRing } from './Effects'
import { FloorAnchor } from './FloorAnchor'
import { indexBuilding, locate, openingWallAngle } from './geom'
import { useLayout } from './layout'
import { COLORS } from './palette'
import { type RoomGlow, useTwinUi } from './uiStore'
import { useSnapshot } from './useSnapshot'

/** Pulse rings + light beams for useTwin.highlight (chat "where is…", feed clicks). */
export function Highlights({ building }: { building: Building }) {
  const highlight = useTwin((s) => s.highlight)
  const layout = useLayout()
  const spots = useMemo(() => {
    if (!highlight) return []
    const idx = indexBuilding(building)
    const delivered = useTwin.getState().state?.deliveries ?? []
    return highlight.ids.flatMap((id) => {
      const d = delivered.find((x) => x.id === id)
      if (d) return [{ id, floor_id: d.floor_id, point: d.position, radius: Math.max(d.dims_m.w, d.dims_m.d) + 0.8 }]
      return locate(building, id).map((l) => ({ id, ...l }))
    }).filter((s) => idx.floors.has(s.floor_id))
  }, [highlight, building])
  if (!spots.length) return null
  const beamH = layout.gap * 2 + 12
  return (
    <>
      {spots.map((s, i) => {
        const [x, z] = layout.toXZ(s.point)
        return (
          <FloorAnchor key={`${s.id}-${i}`} floorId={s.floor_id}>
            <PulseRing x={x} z={z} radius={s.radius * 1.8} color={COLORS.warn} />
            <Beam x={x} z={z} radius={Math.max(0.4, s.radius * 0.5)} height={beamH} color={COLORS.warn} />
            {i === 0 && highlight?.label && (
              <Html position={[x, 3.2, z]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
                <div className="whitespace-nowrap rounded-full border border-amber-300/50 bg-amber-400/20 px-3 py-1 text-xs font-medium text-amber-50 shadow-[0_0_24px_rgba(251,191,36,0.45)] backdrop-blur">
                  {highlight.label}
                </div>
              </Html>
            )}
          </FloorAnchor>
        )
      })}
    </>
  )
}

/** Closed doors (red, pulsing) and doors flagged as blocking (flash red). */
export function OpeningAlerts({ building }: { building: Building }) {
  const snap = useSnapshot()
  const route = useTwin((s) => s.route)
  const flashIds = useTwinUi((s) => s.flashIds)
  const layout = useLayout()
  const items = useMemo(() => {
    const idx = indexBuilding(building)
    const out = new Map<string, { id: string; floor_id: string; point: XY; width: number; mode: 'closed' | 'blocking'; label?: string }>()
    for (const id of snap.closed) {
      const o = idx.openings.get(id)
      if (o) out.set(id, { id, floor_id: o.floor_id, point: o.position, width: o.width_m, mode: 'closed' })
    }
    const blocking = [
      ...(route?.blocking_openings ?? []),
      ...snap.deliveries.filter((d) => d.status === 'blocked').flatMap((d) => d.check?.route_fit?.blocking_openings ?? []),
      ...flashIds.map((id) => idx.openings.get(id)).filter((o) => !!o).map((o) => ({ id: o!.id, width_m: o!.width_m, position: o!.position, floor_id: o!.floor_id })),
    ]
    for (const b of blocking as (typeof blocking[number] & { label?: string })[]) if (!out.has(b.id)) out.set(b.id, { id: b.id, floor_id: b.floor_id, point: b.position, width: b.width_m, mode: 'blocking', label: b.label })
    return [...out.values()].filter((x) => layout.byId.has(x.floor_id))
  }, [snap, route, flashIds, building, layout])
  return (
    <>
      {items.map((it) => (
        <FloorAnchor key={it.id} floorId={it.floor_id}>
          <AlertMarker point={it.point} width={it.width} mode={it.mode} angle={openingWallAngle(building, it.id)} label={it.mode === 'blocking' ? `${it.label ?? 'Door'} · ${it.width.toFixed(2)} m too narrow` : undefined} />
        </FloorAnchor>
      ))}
    </>
  )
}

function AlertMarker({ point, width, mode, angle, label }: { point: XY; width: number; mode: 'closed' | 'blocking'; angle: number; label?: string }) {
  const layout = useLayout()
  const [x, z] = layout.toXZ(point)
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: COLORS.danger, toneMapped: false, transparent: true }), [])
  useEffect(() => () => mat.dispose(), [mat])
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const k = mobileGraphics ? 0.8 : mode === 'blocking' ? (Math.sin(t * 12) > 0 ? 1 : 0.15) : 0.5 + 0.5 * Math.sin(t * 4)
    mat.color.copy(COLORS.danger).multiplyScalar(1.5 + 4 * k)
    mat.opacity = 0.35 + 0.65 * k
  })
  return (
    <group>
      {/* building angle a → three rotation.y = a (z is flipped) */}
      <mesh material={mat} position={[x, 1.1, z]} rotation-y={angle}>
        <boxGeometry args={[Math.max(0.6, width), 2.2, 0.18]} />
      </mesh>
      <PulseRing x={x} z={z} radius={Math.min(4, Math.max(1.6, width * 1.2))} color={COLORS.danger} speed={mode === 'blocking' ? 2 : 1} />
      {label && (
        <Html position={[x, 2.9, z]} center zIndexRange={[29, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded-full border border-rose-300/50 bg-rose-500/25 px-2.5 py-0.5 text-[11px] font-semibold text-rose-50 shadow-[0_0_20px_rgba(244,63,94,0.5)] backdrop-blur">
            {label}
          </div>
        </Html>
      )}
    </group>
  )
}

const GLOW_COLORS: Record<RoomGlow | 'selected', THREE.Color> = {
  free: COLORS.ok,
  busy: new THREE.Color('#64748b'),
  booked: COLORS.booked,
  selected: COLORS.accent,
}

/** Booking states (free = green, booked = blue) and the selected room. */
export function RoomGlows({ building }: { building: Building }) {
  const roomGlow = useTwinUi((s) => s.roomGlow)
  const selectedId = useTwin((s) => s.selectedId)
  const idx = indexBuilding(building)
  const entries = Object.entries(roomGlow).filter(([id, g]) => g !== 'busy' && idx.spaces.has(id)) as [string, RoomGlow | 'selected'][]
  if (selectedId && idx.spaces.has(selectedId) && !roomGlow[selectedId]) entries.push([selectedId, 'selected'])
  return (
    <>
      {entries.map(([id, g]) => (
        <FloorAnchor key={id} floorId={idx.spaces.get(id)!.floor_id}>
          <RoomGlowMesh poly={idx.spaces.get(id)!.polygon} color={GLOW_COLORS[g]} />
        </FloorAnchor>
      ))}
    </>
  )
}

function RoomGlowMesh({ poly, color }: { poly: XY[]; color: THREE.Color }) {
  const layout = useLayout()
  const toXZ = useMemo(() => layout.toXZ.bind(layout), [layout])
  const fill = useMemo(() => polygonFill(poly, toXZ, 0.07), [poly, toXZ])
  const outline = useMemo(() => polygonOutline(poly, toXZ, 0.09), [poly, toXZ])
  const wallTop = useMemo(() => polygonOutline(poly, toXZ, 2.6), [poly, toXZ])
  const fillMat = useRef(new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }))
  const lineMat = useRef(new THREE.LineBasicMaterial({ toneMapped: false, transparent: true }))
  useEffect(() => () => {
    fill.dispose()
    outline.dispose()
    wallTop.dispose()
  }, [fill, outline, wallTop])
  useFrame(({ clock }) => {
    const k = mobileGraphics ? 0.7 : 0.5 + 0.5 * Math.sin(clock.elapsedTime * 3)
    fillMat.current.color.copy(color).multiplyScalar(0.5 + 0.5 * k)
    fillMat.current.opacity = 0.55
    lineMat.current.color.copy(color).multiplyScalar(2.5 + 2 * k)
  })
  return (
    <group>
      <mesh geometry={fill} material={fillMat.current} renderOrder={5} />
      <lineLoop geometry={outline} material={lineMat.current} />
      <lineLoop geometry={wallTop} material={lineMat.current} />
    </group>
  )
}
