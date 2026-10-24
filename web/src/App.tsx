import { Route, Routes } from 'react-router-dom'
import CapturePage from './capture/CapturePage'
import MapPage from './pages/MapPage'
import SitePage from './pages/SitePage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<MapPage />} />
      <Route path="/site/:siteId" element={<SitePage />} />
      <Route path="/capture" element={<CapturePage />} />
    </Routes>
  )
}
