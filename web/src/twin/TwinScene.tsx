import { Bvh, CameraControls, ContactShadows, Environment, Grid, Lightformer } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bloom, EffectComposer, N8AO, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type CameraControlsImpl from 'camera-controls'
import type { Building } from '../lib/types'
import { useTwin } from '../lib/store'
import { Connectors } from './Connectors'
import { Deliveries } from './Deliveries'
import { FloorView } from './FloorView'
import { locate } from './geom'
import { LayoutContext, type TwinLayout, useLayout } from './layout'
import { Highlights, OpeningAlerts, RoomGlows } from './Overlays'
import { COLORS } from './palette'
import { Popover } from './Popover'
import { RoomScans } from './RoomScans'
import { buildParts, RouteView } from './RouteView'
import { makeSkyMaterial } from './shaders'
import { useTwinUi } from './uiStore'

export interface TwinSceneProps {
  building: Building
  siteId: string
  layout: TwinLayout
  /** Screen-space insets (px) covered by HUD panels, so framing keeps content visible. */
  insets?: { left: number; right: number; top: number; bottom: number }
  /** Heavy effects off (AO, contact shadows) for very large buildings or slow GPUs. */
  lite?: boolean
}

export default function TwinScene({ building, siteId, layout, insets, lite }: TwinSceneProps) {
  const big = building.spaces.length > 600 || building.assets.length > 2500
  const lowFx = lite ?? false
  const far = Math.max(2000, layout.extent * 30)
  return (
    <Canvas
      dpr={[1, big ? 1.5 : 2]}
      gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
      camera={{ fov: 38, near: 0.3, far, position: [layout.extent * 1.4, layout.extent * 1.6, layout.extent * 1.8] }}
      onPointerMissed={() => {
        useTwinUi.getState().setPopover(null)
        useTwin.getState().select(null)
      }}
    >
      <LayoutContext.Provider value={layout}>
        <LayoutDriver />
        <Backdrop />
        <fog attach="fog" args={[COLORS.bg, layout.extent * 2.2, layout.extent * 9]} />
        <ambientLight intensity={0.35} />
        <hemisphereLight args={['#9cc8ff', '#0b1020', 0.6]} />
        <directionalLight position={[layout.extent, layout.extent * 1.5, layout.extent * 0.6]} intensity={1.6} color="#e8f0ff" />
        <directionalLight position={[-layout.extent, layout.extent * 0.6, -layout.extent]} intensity={0.5} color="#8b7cf6" />
        <Environment resolution={128} frames={1}>
          <Lightformer intensity={2} position={[0, 5, -9]} scale={[10, 3, 1]} color="#9ccfff" />
          <Lightformer intensity={1.2} position={[-6, 3, 4]} scale={[6, 2, 1]} color="#a78bfa" />
          <Lightformer intensity={1.5} rotation-x={Math.PI / 2} position={[0, 8, 0]} scale={[12, 12, 1]} color="#ffffff" />
        </Environment>

        <Bvh firstHitOnly>
          {layout.floors.map((f) => (
            <FloorView key={f.floor.id} building={building} anim={f} />
          ))}
          <Connectors building={building} />
        </Bvh>
        <RoomGlows building={building} />
        <OpeningAlerts building={building} />
        <Highlights building={building} />
        <Deliveries />
        <RouteView />
        <RoomScans siteId={siteId} />
        <Popover building={building} siteId={siteId} />

        <Ground lowFx={lowFx || big} />
        <CameraDirector building={building} insets={insets} />

        <EffectComposer multisampling={big ? 0 : 4} enableNormalPass={false}>
          {lowFx ? <></> : <N8AO halfRes quality="performance" aoRadius={Math.min(4, layout.extent * 0.04 + 1)} distanceFalloff={1} intensity={2.2} color="#000000" />}
          <Bloom mipmapBlur luminanceThreshold={0.95} luminanceSmoothing={0.15} intensity={1.15} radius={0.72} />
          <ToneMapping mode={ToneMappingMode.AGX} />
          <Vignette offset={0.25} darkness={0.7} />
        </EffectComposer>
      </LayoutContext.Provider>
    </Canvas>
  )
}

function LayoutDriver() {
  const layout = useLayout()
  const route = useTwin((s) => s.route)
  const routeFloors = useMemo(() => (route?.reachable ? new Set(route.floors.map((f) => f.floor_id)) : null), [route])
  useFrame((_, dt) => {
    const s = useTwin.getState()
    layout.update(dt, s.exploded, s.focusFloorId, routeFloors)
  }, -10)
  return null
}

function Backdrop() {
  const layout = useLayout()
  const mat = useMemo(() => makeSkyMaterial('#0d1a3a', COLORS.bg), [])
  return (
    <mesh material={mat} scale={layout.extent * 20} renderOrder={-100} frustumCulled={false}>
      <sphereGeometry args={[1, 32, 16]} />
    </mesh>
  )
}

function Ground({ lowFx }: { lowFx: boolean }) {
  const layout = useLayout()
  const y = layout.minY() - 0.4
  const size = layout.extent * 1.8
  return (
    <group position-y={y}>
      <Grid
        infiniteGrid
        cellSize={layout.extent > 120 ? 5 : 1}
        sectionSize={layout.extent > 120 ? 50 : 10}
        cellThickness={0.6}
        sectionThickness={1}
        cellColor="#13213d"
        sectionColor="#1e3a6a"
        fadeDistance={layout.extent * 4}
        fadeStrength={1.5}
        followCamera={false}
      />
      {!lowFx && (
        <ContactShadows position-y={0.02} scale={size} resolution={512} far={layout.gap * 3 + 12} blur={2.4} opacity={0.55} color="#000814" frames={Infinity} />
      )}
    </group>
  )
}

const DEFAULT_AZ = THREE.MathUtils.degToRad(32)
const DEFAULT_POLAR = THREE.MathUtils.degToRad(64)

function CameraDirector({ building, insets }: { building: Building; insets?: TwinSceneProps['insets'] }) {
  const layout = useLayout()
  const controls = useRef<CameraControls>(null)
  const { camera, size, scene } = useThree()
  const intro = useRef(true)
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __twin: unknown }).__twin = { camera, controls, layout, scene, store: useTwin }
  }, [camera, layout, scene])

  const frameBox = useMemo(
    () =>
      (box: THREE.Box3, opts: { polar?: number; azimuth?: number; transition?: boolean } = {}) => {
        const c = controls.current
        if (!c || box.isEmpty()) return
        const sphere = box.getBoundingSphere(new THREE.Sphere())
        const cam = camera as THREE.PerspectiveCamera
        const ins = insets ?? { left: 0, right: 0, top: 0, bottom: 0 }
        const w = Math.max(200, size.width - ins.left - ins.right)
        const h = Math.max(200, size.height - ins.top - ins.bottom)
        const vfov = THREE.MathUtils.degToRad(cam.fov)
        const dist = Math.max(8, (sphere.radius * 0.9 * size.height) / (Math.min(w, h) * Math.tan(vfov / 2)))
        const az = opts.azimuth ?? c.azimuthAngle
        const polar = opts.polar ?? THREE.MathUtils.clamp(c.polarAngle, 0.5, 1.15)
        const target = sphere.center
        const pos = new THREE.Vector3().setFromSphericalCoords(dist, polar, az).add(target)
        c.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, opts.transition ?? true)
        // Shift the view so the content sits in the uncovered part of the screen.
        const visH = 2 * dist * Math.tan(vfov / 2)
        const pxToWorld = visH / size.height
        c.setFocalOffset(((ins.right - ins.left) / 2) * pxToWorld, ((ins.top - ins.bottom) / 2) * pxToWorld, 0, opts.transition ?? true)
      },
    [camera, size, insets],
  )

  const floorBox = useMemo(
    () => (floorIds: string[]) => {
      const box = new THREE.Box3()
      for (const id of floorIds) {
        const f = layout.byId.get(id)
        if (!f) continue
        const y = layout.targetY(id)
        const [x0, z0] = layout.toXZ([f.bbox.minX, f.bbox.maxY])
        const [x1, z1] = layout.toXZ([f.bbox.maxX, f.bbox.minY])
        box.expandByPoint(new THREE.Vector3(x0, y, z0))
        box.expandByPoint(new THREE.Vector3(x1, y + f.wallH, z1))
      }
      return box
    },
    [layout],
  )

  const frameAll = useMemo(
    () => (transition = true) => frameBox(floorBox(layout.floors.map((f) => f.floor.id)), { azimuth: DEFAULT_AZ, polar: DEFAULT_POLAR, transition }),
    [frameBox, floorBox, layout],
  )

  // Same as the site map (Google Maps-style): drag pans along the ground, ctrl/right-drag turns and tilts around the center.
  useEffect(() => {
    const c = controls.current
    if (!c) return
    const { ACTION } = c.constructor as typeof CameraControlsImpl
    c.mouseButtons.left = ACTION.SCREEN_PAN
    c.mouseButtons.right = ACTION.ROTATE
    // Capture phase so the mode is set before camera-controls reads it on drag start.
    const onDown = (e: PointerEvent) => {
      c.mouseButtons.left = e.ctrlKey ? ACTION.ROTATE : ACTION.SCREEN_PAN
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  // Intro: start wide and low, then glide in once floors have risen.
  useEffect(() => {
    const c = controls.current
    if (!c) return
    const box = floorBox(layout.floors.map((f) => f.floor.id))
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const pos = new THREE.Vector3().setFromSphericalCoords(sphere.radius * 4.2, THREE.MathUtils.degToRad(72), DEFAULT_AZ - 0.9).add(sphere.center)
    c.setLookAt(pos.x, pos.y, pos.z, sphere.center.x, sphere.center.y, sphere.center.z, false)
    intro.current = !layout.introDone
    if (layout.introDone) frameAll(false)
  }, [layout, floorBox, frameAll])

  useFrame(() => {
    if (intro.current && layout.time > 0.3) {
      intro.current = false
      const c = controls.current
      if (c) c.smoothTime = 1.6
      frameAll(true)
      setTimeout(() => {
        if (controls.current) controls.current.smoothTime = 0.55
      }, 2600)
    }
  })

  // React to store changes.
  useEffect(() => {
    let prev = useTwin.getState()
    let prevUi = useTwinUi.getState()
    const unsubA = useTwin.subscribe((s) => {
      if (s.focusFloorId !== prev.focusFloorId) {
        if (s.focusFloorId) frameBox(floorBox([s.focusFloorId]), { polar: 0.75 })
        else if (!s.route) frameAll()
      }
      if (s.exploded !== prev.exploded && !s.focusFloorId) setTimeout(() => frameAll(), 50)
      if (s.route !== prev.route && s.route?.reachable) {
        const { parts } = buildParts(s.route, layout)
        const box = new THREE.Box3()
        for (const p of parts) {
          if (p.kind !== 'floor') continue
          const y = layout.targetY(p.floorId)
          for (let i = 0; i <= 20; i++) {
            const q = p.curve.getPointAt(i / 20)
            box.expandByPoint(new THREE.Vector3(q.x, y + q.y, q.z))
          }
        }
        box.expandByScalar(3)
        frameBox(box, { polar: 0.95 })
      }
      if (s.highlight !== prev.highlight && s.highlight?.ids.length) {
        const spots = s.highlight.ids.flatMap((id) => {
          const d = s.state?.deliveries.find((x) => x.id === id)
          return d ? [{ floor_id: d.floor_id, point: d.position, radius: 2 }] : locate(building, id)
        })
        if (spots.length) {
          const box = new THREE.Box3()
          for (const sp of spots) {
            const [x, z] = layout.toXZ(sp.point)
            const y = layout.targetY(sp.floor_id)
            box.expandByPoint(new THREE.Vector3(x, y, z))
          }
          box.expandByScalar(Math.max(9, ...spots.map((sp) => sp.radius * 2)))
          frameBox(box, { polar: 0.9 })
        }
      }
      prev = s
    })
    const unsubB = useTwinUi.subscribe((s) => {
      if (s.frameAllTick !== prevUi.frameAllTick) frameAll()
      prevUi = s
    })
    return () => {
      unsubA()
      unsubB()
    }
  }, [frameBox, floorBox, frameAll, layout, building])

  return (
    <CameraControls
      ref={controls}
      makeDefault
      smoothTime={0.55}
      minDistance={3}
      maxDistance={layout.extent * 8}
      maxPolarAngle={Math.PI * 0.49}
      // 0.16°/px turn, 0.1°/px tilt like the site map; camera-controls scales its speeds by element height.
      azimuthRotateSpeed={(0.16 * size.height) / 360}
      polarRotateSpeed={(0.1 * size.height) / 360}
      dollyToCursor
    />
  )
}
