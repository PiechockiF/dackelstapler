import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Asset, Building } from '../lib/types'
import { type FloorAnim, useLayout } from './layout'
import { assetColor, assetHeight } from './palette'
import { useSnapshot } from './useSnapshot'

const tmp = new THREE.Object3D()
const col = new THREE.Color()

const isVehicle = (a: Asset) => /forklift|pallet_jack|agv|tugger/.test(a.type)
const isHero = (a: Asset) => a.category === 'machine' || isVehicle(a)

interface Placed { a: Asset; x: number; z: number; rot: number; w: number; d: number; h: number }

/** All assets of one floor, instanced: one draw call for furniture, a few for hero machines. */
export function Assets({ building, anim }: { building: Building; anim: FloorAnim }) {
  const layout = useLayout()
  const snap = useSnapshot()
  const floorId = anim.floor.id

  const placed = useMemo(() => {
    const regular: Placed[] = []
    const hero: Placed[] = []
    for (const a of building.assets) {
      const o = snap.overrides[a.id]
      const fid = o?.floor_id ?? a.floor_id
      if (fid !== floorId) continue
      const [x, z] = layout.toXZ(o?.position ?? a.position)
      const fp = a.footprint
      const p: Placed = {
        a, x, z,
        rot: THREE.MathUtils.degToRad(fp?.rotation_deg ?? 0),
        w: Math.max(0.15, fp?.width_m ?? 0.5),
        d: Math.max(0.15, fp?.depth_m ?? 0.5),
        h: assetHeight(a.category, a.type),
      }
      ;(isHero(a) ? hero : regular).push(p)
    }
    return { regular, hero, vehicles: hero.filter((p) => isVehicle(p.a)) }
  }, [building, snap.overrides, floorId, layout])

  const geos = useMemo(() => {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
    const beacon = new THREE.CylinderGeometry(0.5, 0.5, 1, 12).translate(0, 0.5, 0)
    return { box, beacon }
  }, [])
  const mats = useMemo(
    () => ({
      regular: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 }),
      hero: new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.55, emissive: new THREE.Color('#2a1a05'), emissiveIntensity: 0.6 }),
      glow: new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true }),
    }),
    [],
  )
  useEffect(() => () => {
    Object.values(mats).forEach((m) => m.dispose())
    Object.values(geos).forEach((g) => g.dispose())
  }, [mats, geos])

  const regRef = useRef<THREE.InstancedMesh>(null)
  const heroRef = useRef<THREE.InstancedMesh>(null)
  const beaconRef = useRef<THREE.InstancedMesh>(null)
  const stripeRef = useRef<THREE.InstancedMesh>(null)
  const mastRef = useRef<THREE.InstancedMesh>(null)

  useEffect(() => {
    const set = (mesh: THREE.InstancedMesh | null, list: Placed[], f: (p: Placed, i: number) => void) => {
      if (!mesh) return
      list.forEach(f)
      mesh.count = list.length
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      mesh.computeBoundingBox()
    }
    const put = (mesh: THREE.InstancedMesh, i: number, p: Placed, sx: number, sy: number, sz: number, dy = 0, dx = 0) => {
      tmp.position.set(p.x + Math.cos(p.rot) * dx, dy, p.z - Math.sin(p.rot) * dx)
      tmp.rotation.set(0, p.rot, 0)
      tmp.scale.set(sx, sy, sz)
      tmp.updateMatrix()
      mesh.setMatrixAt(i, tmp.matrix)
    }
    set(regRef.current, placed.regular, (p, i) => {
      // Inset slightly so neighbours read as separate pieces.
      put(regRef.current!, i, p, p.w * 0.92, p.h, p.d * 0.92)
      regRef.current!.setColorAt(i, assetColor(p.a.category, p.a.type))
    })
    set(heroRef.current, placed.hero, (p, i) => {
      const v = isVehicle(p.a)
      put(heroRef.current!, i, p, p.w * (v ? 0.7 : 0.95), v ? p.h * 0.55 : p.h, p.d * 0.95, 0, v ? -p.w * 0.12 : 0)
      heroRef.current!.setColorAt(i, assetColor(p.a.category, p.a.type))
    })
    set(beaconRef.current, placed.hero, (p, i) => {
      put(beaconRef.current!, i, p, 0.18, 0.22, 0.18, p.h * (isVehicle(p.a) ? 0.55 : 1) + 0.02)
      const h = (p.a.id.charCodeAt(p.a.id.length - 1) % 5)
      beaconRef.current!.setColorAt(i, col.set(h === 0 ? '#fbbf24' : '#34d399').multiplyScalar(4))
    })
    set(stripeRef.current, placed.hero, (p, i) => {
      put(stripeRef.current!, i, p, p.w + 0.12, 0.05, p.d + 0.12, 0.01)
      stripeRef.current!.setColorAt(i, col.set('#f59e0b').multiplyScalar(1.6))
    })
    set(mastRef.current, placed.vehicles, (p, i) => {
      put(mastRef.current!, i, p, 0.12, p.h, p.d * 0.8, 0, p.w * 0.36)
      mastRef.current!.setColorAt(i, col.set('#3f3f46'))
    })
  }, [placed])

  const transparent = useRef(false)
  useFrame(() => {
    const dim = anim.dim
    const want = dim < 0.97
    if (want !== transparent.current) {
      transparent.current = want
      mats.regular.transparent = want
      mats.hero.transparent = want
      mats.regular.needsUpdate = true
      mats.hero.needsUpdate = true
    }
    mats.regular.opacity = dim
    mats.hero.opacity = dim
    mats.glow.opacity = dim
  })

  const n = (k: number) => Math.max(1, k)
  return (
    <group>
      <instancedMesh ref={regRef} args={[geos.box, mats.regular, n(placed.regular.length)]} castShadow frustumCulled={false} />
      <instancedMesh ref={heroRef} args={[geos.box, mats.hero, n(placed.hero.length)]} castShadow frustumCulled={false} />
      <instancedMesh ref={beaconRef} args={[geos.beacon, mats.glow, n(placed.hero.length)]} frustumCulled={false} />
      <instancedMesh ref={stripeRef} args={[geos.box, mats.glow, n(placed.hero.length)]} frustumCulled={false} />
      <instancedMesh ref={mastRef} args={[geos.box, mats.hero, n(placed.vehicles.length)]} frustumCulled={false} />
    </group>
  )
}
