import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { mobileGraphics } from '../lib/mode'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Building, Connector, XY } from '../lib/types'
import { indexBuilding } from './geom'
import { useLayout } from './layout'
import { COLORS } from './palette'
import { useTwinUi } from './uiStore'
import { useSnapshot } from './useSnapshot'

interface Shaft { c: Connector; from: string; to: string; p: XY; lift: boolean }

const tmp = new THREE.Object3D()
const col = new THREE.Color()

/** Stairs and lifts as glowing vertical shafts between consecutive stops (instanced). */
export function Connectors({ building }: { building: Building }) {
  const layout = useLayout()
  const snap = useSnapshot()
  const flashIds = useTwinUi((s) => s.flashIds)
  const setPopover = useTwinUi((s) => s.setPopover)

  const shafts = useMemo(() => {
    const idx = indexBuilding(building)
    const out: Shaft[] = []
    for (const c of building.vertical_connectors) {
      const stops = c.floor_ids
        .map((f, i) => ({ f, s: c.space_ids[i] }))
        .filter((x) => layout.byId.has(x.f) && idx.anchors.has(x.s))
        .sort((a, b) => layout.byId.get(a.f)!.index - layout.byId.get(b.f)!.index)
      for (let i = 0; i + 1 < stops.length; i++) {
        out.push({ c, from: stops[i].f, to: stops[i + 1].f, p: idx.anchors.get(stops[i].s)!, lift: c.kind === 'lift' })
      }
    }
    return out
  }, [building, layout])

  const geos = useMemo(
    () => ({
      lift: new THREE.BoxGeometry(1.6, 1, 1.6).translate(0, 0.5, 0),
      stair: new THREE.CylinderGeometry(0.7, 0.7, 1, 16, 1, true).translate(0, 0.5, 0),
      core: new THREE.CylinderGeometry(0.07, 0.07, 1, 6).translate(0, 0.5, 0),
    }),
    [],
  )
  const mats = useMemo(
    () => ({
      glass: new THREE.MeshStandardMaterial({
        transparent: true, opacity: 0.28, roughness: 0.1, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide,
        emissive: new THREE.Color('#6d5bd0'), emissiveIntensity: 0.5,
      }),
      core: new THREE.MeshBasicMaterial({ toneMapped: false }),
    }),
    [],
  )

  const shellRef = useRef<THREE.InstancedMesh>(null)
  const stairRef = useRef<THREE.InstancedMesh>(null)
  const coreRef = useRef<THREE.InstancedMesh>(null)
  const lifts = useMemo(() => shafts.filter((s) => s.lift), [shafts])
  const stairs = useMemo(() => shafts.filter((s) => !s.lift), [shafts])
  const lastVersion = useRef(-1)

  useEffect(() => {
    lastVersion.current = -1
  }, [shafts])

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const pulse = mobileGraphics ? 0.7 : 0.5 + 0.5 * Math.sin(t * 5)
    const moved = layout.version !== lastVersion.current
    lastVersion.current = layout.version
    const place = (mesh: THREE.InstancedMesh | null, list: Shaft[], sx: number) => {
      if (!mesh || !moved) return
      list.forEach((s, i) => {
        const [x, z] = layout.toXZ(s.p)
        const y0 = layout.y(s.from)
        const y1 = layout.y(s.to)
        tmp.position.set(x, y0, z)
        tmp.rotation.set(0, 0, 0)
        tmp.scale.set(sx, Math.max(0.01, y1 - y0 + 0.4), sx)
        tmp.updateMatrix()
        mesh.setMatrixAt(i, tmp.matrix)
      })
      mesh.count = list.length
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
    }
    place(shellRef.current, lifts, 1)
    place(stairRef.current, stairs, 1)
    place(coreRef.current, shafts, 1)
    const core = coreRef.current
    if (core) {
      shafts.forEach((s, i) => {
        const closed = snap.closed.has(s.c.id)
        const flash = flashIds.includes(s.c.id)
        if (closed || flash) col.copy(COLORS.danger).multiplyScalar(2 + 5 * pulse)
        else col.copy(s.lift ? COLORS.accent2 : COLORS.accent).multiplyScalar(2.6)
        core.setColorAt(i, col)
      })
      if (core.instanceColor) core.instanceColor.needsUpdate = true
    }
    const tint = (mesh: THREE.InstancedMesh | null, list: Shaft[]) => {
      if (!mesh) return
      list.forEach((s, i) => {
        const closed = snap.closed.has(s.c.id) || flashIds.includes(s.c.id)
        mesh.setColorAt(i, closed ? col.copy(COLORS.danger).multiplyScalar(0.6 + pulse) : col.set(s.lift ? '#8b7cf6' : '#38bdf8'))
      })
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    tint(shellRef.current, lifts)
    tint(stairRef.current, stairs)
  })

  const onClick = (list: Shaft[]) => (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId == null || e.delta > 4) return
    const s = list[e.instanceId]
    if (!s) return
    e.stopPropagation()
    setPopover({ kind: 'connector', id: s.c.id, floorId: s.from, point: s.p })
  }

  return (
    <group>
      <instancedMesh ref={shellRef} args={[geos.lift, mats.glass, Math.max(1, lifts.length)]} onClick={onClick(lifts)} frustumCulled={false} renderOrder={4} />
      <instancedMesh ref={stairRef} args={[geos.stair, mats.glass, Math.max(1, stairs.length)]} onClick={onClick(stairs)} frustumCulled={false} renderOrder={4} />
      <instancedMesh ref={coreRef} args={[geos.core, mats.core, Math.max(1, shafts.length)]} frustumCulled={false} />
    </group>
  )
}
