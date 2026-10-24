import { Html } from '@react-three/drei'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Building } from '../lib/types'
import { useTwin } from '../lib/store'
import { Assets } from './Assets'
import { buildFloorGeometry } from './buildFloor'
import { indexBuilding } from './geom'
import { type FloorAnim, useLayout } from './layout'
import { COLORS } from './palette'
import { useTwinUi } from './uiStore'

const tmp = new THREE.Object3D()

export function FloorView({ building, anim }: { building: Building; anim: FloorAnim }) {
  const layout = useLayout()
  const group = useRef<THREE.Group>(null)
  const floorId = anim.floor.id
  const toXZ = useMemo(() => layout.toXZ.bind(layout), [layout])
  const geo = useMemo(() => buildFloorGeometry(building, floorId, toXZ, anim.wallH), [building, floorId, toXZ, anim.wallH])
  useEffect(() => () => {
    geo.fills.dispose()
    geo.walls.dispose()
    geo.lines.dispose()
  }, [geo])

  const mats = useMemo(() => {
    const fill = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05, transparent: true, opacity: 0.95 })
    const wall = new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.2, metalness: 0.1,
      emissive: new THREE.Color('#1b2a4a'), emissiveIntensity: 0.6,
    })
    const line = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, toneMapped: false })
    line.color.setScalar(1.9)
    const slab = new THREE.MeshStandardMaterial({ color: '#0d1830', transparent: true, opacity: 0.6, roughness: 0.25, metalness: 0.4, depthWrite: false })
    const slabEdge = new THREE.LineBasicMaterial({ color: COLORS.accent.clone().multiplyScalar(1.4), transparent: true, toneMapped: false })
    const door = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true })
    return { fill, wall, line, slab, slabEdge, door }
  }, [])
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats])

  // Slab under the floor: bbox + margin, thin glassy plate with glowing edges.
  const slab = useMemo(() => {
    const m = 1.5
    const b = anim.bbox
    const w = b.w + 2 * m
    const d = b.h + 2 * m
    const [cx, cz] = toXZ([b.cx, b.cy])
    const box = new THREE.BoxGeometry(w, 0.16, d)
    const edges = new THREE.EdgesGeometry(box)
    return { box, edges, cx, cz, w, d }
  }, [anim.bbox, toXZ])

  // Door markers as one instanced mesh.
  const doorMesh = useRef<THREE.InstancedMesh>(null)
  const doorGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), [])
  useEffect(() => {
    const mesh = doorMesh.current
    if (!mesh) return
    const c = new THREE.Color()
    geo.doors.forEach((d, i) => {
      tmp.position.set(d.x, 0.02, d.z)
      tmp.rotation.set(0, d.angle, 0)
      tmp.scale.set(Math.max(0.5, d.opening.width_m), 0.07, 0.22)
      tmp.updateMatrix()
      mesh.setMatrixAt(i, tmp.matrix)
      const outside = d.opening.space_ids.includes('outside')
      c.copy(outside ? COLORS.ok : d.opening.kind === 'opening' ? COLORS.accent2 : COLORS.accent).multiplyScalar(outside ? 2.2 : 1.4)
      mesh.setColorAt(i, c)
    })
    mesh.count = geo.doors.length
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [geo])

  const lastDim = useRef(-1)
  useFrame(() => {
    if (group.current) {
      group.current.position.y = anim.y
      group.current.visible = anim.rise > 0
    }
    const dim = anim.dim
    if (Math.abs(dim - lastDim.current) < 0.002) return
    lastDim.current = dim
    mats.fill.opacity = 0.95 * dim
    mats.wall.opacity = Math.max(0.15, dim)
    mats.line.opacity = 0.25 + 0.75 * dim
    mats.slab.opacity = 0.62 * Math.max(dim, 0.4)
    mats.slabEdge.opacity = 0.3 + 0.7 * dim
    mats.door.opacity = dim
  })

  const select = useTwin((s) => s.select)
  const setPopover = useTwinUi((s) => s.setPopover)
  const interactive = () => anim.dim > 0.5
  const onFillClick = (e: ThreeEvent<MouseEvent>) => {
    if (!interactive() || e.delta > 4) return
    const a = e.face?.a
    if (a == null) return
    const space = geo.spaces[geo.triSpace[Math.floor(a / 3)]]
    if (!space) return
    e.stopPropagation()
    select(space.id)
    setPopover({ kind: 'space', id: space.id, floorId, point: indexBuilding(building).anchors.get(space.id)! })
  }
  const onDoorClick = (e: ThreeEvent<MouseEvent>) => {
    if (!interactive() || e.instanceId == null || e.delta > 4) return
    const d = geo.doors[e.instanceId]
    if (!d) return
    e.stopPropagation()
    setPopover({ kind: 'opening', id: d.opening.id, floorId, point: d.opening.position })
  }

  return (
    <group ref={group} position-y={anim.y}>
      <mesh geometry={slab.box} material={mats.slab} position={[slab.cx, -0.1, slab.cz]} renderOrder={-1} />
      <lineSegments geometry={slab.edges} material={mats.slabEdge} position={[slab.cx, -0.1, slab.cz]} />
      <mesh geometry={geo.fills} material={mats.fill} onClick={onFillClick} receiveShadow />
      <mesh geometry={geo.walls} material={mats.wall} renderOrder={2} />
      <lineSegments geometry={geo.lines} material={mats.line} renderOrder={3} />
      <instancedMesh
        ref={doorMesh}
        args={[doorGeo, mats.door, Math.max(1, geo.doors.length)]}
        onClick={onDoorClick}
        frustumCulled={false}
      />
      <Assets building={building} anim={anim} />
      <FloorLabel anim={anim} x={slab.cx - slab.w / 2} z={slab.cz + slab.d / 2} />
      <RoomLabels building={building} anim={anim} />
    </group>
  )
}

function FloorLabel({ anim, x, z }: { anim: FloorAnim; x: number; z: number }) {
  const focus = useTwin((s) => s.focusFloorId)
  const setFocus = useTwin((s) => s.setFocusFloor)
  const active = focus === anim.floor.id
  const dimmed = focus != null && !active
  return (
    <Html position={[x, 0.2, z]} zIndexRange={[20, 0]} style={{ pointerEvents: 'auto' }}>
      <button
        onClick={() => setFocus(active ? null : anim.floor.id)}
        className={`-translate-x-full -translate-y-1/2 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium backdrop-blur transition ${
          active ? 'border-sky-300/70 bg-sky-400/25 text-sky-50' : 'border-white/10 bg-slate-900/60 text-slate-300 hover:border-sky-300/40'
        } ${dimmed ? 'opacity-40' : ''}`}
      >
        <span className="mr-1 font-mono text-sky-300">L{anim.floor.level}</span>
        {anim.floor.name}
      </button>
    </Html>
  )
}

function RoomLabels({ building, anim }: { building: Building; anim: FloorAnim }) {
  const focus = useTwin((s) => s.focusFloorId)
  const show = focus === anim.floor.id || (focus == null && building.floors.length === 1)
  const labels = useMemo(() => {
    if (!show) return []
    const idx = indexBuilding(building)
    return building.spaces
      .filter((s) => s.floor_id === anim.floor.id && s.type !== 'corridor' && s.room_type !== 'corridor')
      .map((s) => ({ s, area: idx.areas.get(s.id) ?? 0 }))
      .filter((x) => x.area > 6)
      .sort((a, b) => b.area - a.area)
      .slice(0, 36)
      .map(({ s }) => ({ id: s.id, name: s.name, p: idx.anchors.get(s.id)! }))
  }, [show, building, anim.floor.id])
  const layout = useLayout()
  if (!show) return null
  return (
    <>
      {labels.map((l) => {
        const [x, z] = layout.toXZ(l.p)
        return (
          <Html key={l.id} position={[x, 0.4, z]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
            <div className="whitespace-nowrap rounded bg-slate-950/55 px-1.5 py-px text-[10px] text-slate-200/90 backdrop-blur-sm">{l.name}</div>
          </Html>
        )
      })}
    </>
  )
}
