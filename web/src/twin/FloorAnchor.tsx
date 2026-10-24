import { useFrame } from '@react-three/fiber'
import { useRef, type ReactNode } from 'react'
import type * as THREE from 'three'
import { useLayout } from './layout'

/** A group that follows a floor's animated height. Children use floor-local y (0 = floor level). */
export function FloorAnchor({ floorId, children, offset = 0 }: { floorId: string; children: ReactNode; offset?: number }) {
  const ref = useRef<THREE.Group>(null)
  const layout = useLayout()
  useFrame(() => {
    if (ref.current) ref.current.position.y = layout.y(floorId) + offset
  })
  return (
    <group ref={ref} position-y={layout.y(floorId) + offset}>
      {children}
    </group>
  )
}
