import { Route, Routes } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { isLocalMode } from './lib/mode'
const CapturePage = lazy(() => import('./capture/CapturePage'))
const MapPage = lazy(() => import('./pages/MapPage'))
const SitePage = lazy(() => import('./pages/SitePage'))
const LocalHome = lazy(() => import('./local/LocalHome'))
const LocalCapturePage = lazy(() => import('./local/LocalCapturePage'))

export default function App() {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-sky-200">Opening Dackel…</div>}><Routes>
      <Route path="/" element={isLocalMode ? <LocalHome /> : <MapPage />} />
      <Route path="/site/:siteId" element={<SitePage />} />
      <Route path="/capture" element={isLocalMode ? <LocalCapturePage /> : <CapturePage />} />
    </Routes></Suspense>
  )
}
