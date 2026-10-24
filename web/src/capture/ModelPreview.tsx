// Owner: agent C. Small spinning preview of the delivery GLB on the phone result screen.
import { Bounds, ContactShadows, OrbitControls, useGLTF } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { Component, Suspense, type ReactNode } from 'react'

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  return <primitive object={scene} />
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

export default function ModelPreview({ url }: { url: string }) {
  return (
    <Boundary>
      <div className="h-56 w-full overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-slate-900 to-slate-950">
        <Canvas camera={{ position: [2.2, 1.6, 2.6], fov: 35 }} dpr={[1, 2]}>
          {/* No HDR environment: venue Wi-Fi may have no internet. */}
          <hemisphereLight args={['#dbeafe', '#1e293b', 1.1]} />
          <directionalLight position={[3, 5, 2]} intensity={2.2} />
          <directionalLight position={[-3, 2, -2]} intensity={0.6} color="#93c5fd" />
          <Suspense fallback={null}>
            <Bounds fit clip observe margin={1.6}>
              <Model url={url} />
            </Bounds>
          </Suspense>
          <ContactShadows position={[0, 0, 0]} opacity={0.5} scale={6} blur={2.4} far={3} />
          <gridHelper args={[6, 12, '#1e3a5f', '#0f1d33']} />
          <OrbitControls autoRotate autoRotateSpeed={1.4} enablePan={false} makeDefault />
        </Canvas>
      </div>
    </Boundary>
  )
}
