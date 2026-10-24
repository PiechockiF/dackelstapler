// "You are here" while walking a route: a glowing dot, a heading wedge and the position uncertainty.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useNav } from '../nav/navStore'
import { wrap } from '../nav/pdr'
import { PulseRing } from './Effects'
import { FloorAnchor } from './FloorAnchor'
import { useLayout } from './layout'
import { COLORS, glow } from './palette'

const Y = 0.6
const wedgeGeo = (() => {
  const s = new THREE.Shape()
  s.moveTo(0.45, 0.55)
  s.lineTo(1.9, 0)
  s.lineTo(0.45, -0.55)
  s.lineTo(0.7, 0)
  s.closePath()
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2)
})()
const haloGeo = new THREE.CircleGeometry(0.75, 32).rotateX(-Math.PI / 2)
const coreGeo = new THREE.SphereGeometry(0.32, 24, 24)
const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff').multiplyScalar(4), toneMapped: false, depthTest: false })
const haloMat = new THREE.MeshBasicMaterial({ color: glow(COLORS.accent, 1.6), transparent: true, opacity: 0.35, toneMapped: false, depthTest: false, depthWrite: false })
const wedgeMat = new THREE.MeshBasicMaterial({ color: glow(COLORS.accent, 2.4), transparent: true, opacity: 0.9, toneMapped: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide })

export function NavMarker() {
  const floorId = useNav((s) => (s.status !== 'idle' && s.xy ? s.floorId : null))
  const uncertainty = useNav((s) => Math.round(s.uncertaintyM * 2) / 2)
  const layout = useLayout()
  const invalidate = useThree((s) => s.invalidate)
  const group = useRef<THREE.Group>(null)
  const wedge = useRef<THREE.Group>(null)
  const placed = useRef(false)

  // On-demand rendering (mobile): draw a frame whenever the walker moves.
  useEffect(() => useNav.subscribe(() => invalidate()), [invalidate])
  useEffect(() => { placed.current = false }, [floorId])

  useFrame((_, dt) => {
    const s = useNav.getState()
    if (!s.xy || !group.current || !wedge.current) return
    const [x, z] = layout.toXZ(s.xy)
    const g = group.current.position
    const k = 1 - Math.exp(-dt * 8)
    const dx = x - g.x, dz = z - g.z
    if (!placed.current || Math.hypot(dx, dz) > 15) {
      g.set(x, Y, z)
      wedge.current.rotation.y = s.heading
      placed.current = true
      return
    }
    g.x += dx * k
    g.z += dz * k
    // Plan bearing b points along (cos b, -sin b) in world x/z, which is exactly rotation.y = b.
    const dr = wrap(s.heading - wedge.current.rotation.y)
    wedge.current.rotation.y += dr * k
    if (Math.hypot(dx, dz) > 0.01 || Math.abs(dr) > 0.005) invalidate()
  })

  if (!floorId) return null
  return (
    <FloorAnchor floorId={floorId}>
      <group ref={group} position-y={Y}>
        <PulseRing x={0} z={0} y={-0.5} radius={uncertainty} color={COLORS.accent} speed={0.6} />
        <mesh geometry={haloGeo} material={haloMat} renderOrder={40} />
        <mesh geometry={coreGeo} material={coreMat} renderOrder={41} />
        <group ref={wedge}>
          <mesh geometry={wedgeGeo} material={wedgeMat} renderOrder={40} />
        </group>
      </group>
    </FloorAnchor>
  )
}
