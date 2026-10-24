// Small reusable glowing effects: pulse ring, light beam.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { makeBeamMaterial, makePulseMaterial } from './shaders'

const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true).translate(0, 0.5, 0)

export function PulseRing({ x, z, radius, color, y = 0.08, speed = 1 }: { x: number; z: number; radius: number; color: THREE.Color; y?: number; speed?: number }) {
  const mat = useMemo(() => makePulseMaterial(color), [color])
  useEffect(() => () => mat.dispose(), [mat])
  useFrame(({ clock }) => {
    mat.uniforms.uTime.value = clock.elapsedTime * speed
  })
  return <mesh geometry={plane} material={mat} position={[x, y, z]} scale={[radius * 2, 1, radius * 2]} renderOrder={10} />
}

export function Beam({ x, z, radius, height, color }: { x: number; z: number; radius: number; height: number; color: THREE.Color }) {
  const mat = useMemo(() => makeBeamMaterial(color), [color])
  useEffect(() => () => mat.dispose(), [mat])
  useFrame(({ clock }) => {
    mat.uniforms.uTime.value = clock.elapsedTime
  })
  return <mesh geometry={beamGeo} material={mat} position={[x, 0, z]} scale={[radius, height, radius]} renderOrder={11} />
}
