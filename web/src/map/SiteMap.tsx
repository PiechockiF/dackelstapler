import { AttributionControl, Map as MlMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl'
// MapLibre 6 resolves its worker relative to its own module, which breaks under Vite's dep bundling.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { Site } from '../lib/types'
import './siteMap.css'

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'
export const MUNICH: [number, number] = [11.575, 48.165]
export const KIND_COLOR: Record<Site['kind'], string> = {
  factory: '#f59e0b',
  campus: '#38bdf8',
  office: '#a78bfa',
  airport: '#34d399',
  mall: '#f472b6',
  other: '#94a3b8',
}

export interface SiteMapApi {
  flyToSite: (site: Site) => Promise<void>
  flyHome: () => void
  /** Top-down view of a spot, e.g. to place a new location precisely. */
  flyTo: (lat: number, lon: number) => void
}

export interface SiteMapProps {
  sites: Site[]
  hoveredId: string | null
  activeId: string | null
  pickMode: boolean
  skipIntro: boolean
  onSiteClick: (site: Site) => void
  onSiteHover: (id: string | null) => void
  onPick: (lat: number, lon: number) => void
  ref?: Ref<SiteMapApi>
}

setWorkerUrl(maplibreWorkerUrl)

const SEEN_KEY = 'sitetwin-map-view'
// Set when flying into a site: the close-up we ended on and the view we came from, so returning plays the flight in reverse.
const RETURN_KEY = 'sitetwin-map-return'
const FLY_MS = 1900
const easeInOut = (t: number) => (1 - Math.cos(Math.PI * t)) / 2
const viewOf = (map: MlMap) => {
  const c = map.getCenter()
  return { center: [c.lng, c.lat] as [number, number], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }
}

export default function SiteMap(props: SiteMapProps) {
  const { sites, hoveredId, activeId, pickMode, skipIntro, ref } = props
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const markers = useRef(new Map<string, { marker: Marker; el: HTMLDivElement }>())
  const cb = useRef(props)
  cb.current = props
  // Read once in an initializer so StrictMode's double effect run still sees it after the effect clears the key.
  const [back] = useState(() => JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? 'null'))

  // ---- map init ----
  useEffect(() => {
    if (!container.current) return
    const saved = sessionStorage.getItem(SEEN_KEY)
    sessionStorage.removeItem(RETURN_KEY)
    const start = back?.from ?? (skipIntro && saved ? JSON.parse(saved) : null)
    const map = new MlMap({
      container: container.current,
      style: STYLE_URL,
      center: start?.center ?? [-25, 38],
      zoom: start?.zoom ?? 1.35,
      pitch: start?.pitch ?? 0,
      bearing: start?.bearing ?? 0,
      maxPitch: 78,
      // Google Maps-style ctrl/right-drag: pivot on the screen center, horizontal drag always turns the same way.
      dragRotate: { around: 'center', movement: 'linear' },
      // 0.2× MapLibre's defaults (0.8 / -0.5), hand-tuned.
      rotateSpeed: 0.16,
      pitchSpeed: -0.1,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    })
    mapRef.current = map
    map.addControl(
      new AttributionControl({
        compact: false,
        customAttribution: 'Building data © OpenStreetMap contributors (ODbL), Swiss Dwellings (CC BY 4.0), ResPlan',
      }),
      'bottom-right',
    )
    map.addControl(new NavigationControl({ visualizePitch: true, showCompass: true }), 'bottom-right')

    let introCancelled = !!start
    const cancelIntro = () => {
      introCancelled = true
    }
    map.on('mousedown', cancelIntro)
    map.on('wheel', cancelIntro)
    map.on('touchstart', cancelIntro)

    map.on('style.load', () => {
      map.setProjection({ type: 'globe' })
      styleMap(map)
      if (back) map.flyTo({ ...back.to, duration: FLY_MS, curve: 1.5, essential: true, easing: easeInOut })
      if (start) return
      // Intro: a slow spin, then a cinematic flight to Munich.
      const t0 = performance.now()
      const spin = (now: number) => {
        if (introCancelled) return
        const t = (now - t0) / 1000
        if (t < 2.8) {
          map.jumpTo({ center: [-25 + t * 9, 38 + t * 1.2] })
          requestAnimationFrame(spin)
        } else {
          map.flyTo({ center: MUNICH, zoom: 10.4, pitch: 52, bearing: -18, duration: 6500, curve: 1.7, essential: true })
        }
      }
      requestAnimationFrame(spin)
    })

    map.on('contextmenu', (e) => cb.current.onPick(e.lngLat.lat, e.lngLat.lng))
    map.on('click', (e) => {
      if (cb.current.pickMode) cb.current.onPick(e.lngLat.lat, e.lngLat.lng)
    })
    const save = () => sessionStorage.setItem(SEEN_KEY, JSON.stringify(viewOf(map)))
    map.on('moveend', save)

    return () => {
      markers.current.forEach(({ marker }) => marker.remove())
      markers.current.clear()
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- markers ----
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const existing = markers.current
    const ids = new Set(sites.map((s) => s.id))
    for (const [id, m] of existing) {
      if (!ids.has(id)) {
        m.marker.remove()
        existing.delete(id)
      }
    }
    for (const s of sites) {
      if (existing.has(s.id)) continue
      const el = document.createElement('div')
      el.className = 'site-pin'
      el.style.setProperty('--pin', KIND_COLOR[s.kind] ?? KIND_COLOR.other)
      el.innerHTML = `<span class="site-pin__pulse"></span><span class="site-pin__pulse site-pin__pulse--late"></span><span class="site-pin__core"></span><span class="site-pin__label"></span>`
      el.querySelector('.site-pin__label')!.textContent = s.name
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        cb.current.onSiteClick(s)
      })
      el.addEventListener('mouseenter', () => cb.current.onSiteHover(s.id))
      el.addEventListener('mouseleave', () => cb.current.onSiteHover(null))
      const marker = new Marker({ element: el, anchor: 'center' }).setLngLat([s.lon, s.lat]).addTo(map)
      existing.set(s.id, { marker, el })
    }
  }, [sites])

  useEffect(() => {
    markers.current.forEach(({ el }, id) => {
      el.classList.toggle('is-hover', id === hoveredId)
      el.classList.toggle('is-active', id === activeId)
    })
  }, [hoveredId, activeId])

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas()
    if (canvas) canvas.style.cursor = pickMode ? 'crosshair' : ''
  }, [pickMode])

  useImperativeHandle(ref, () => ({
    flyToSite: (site) =>
      new Promise<void>((resolve) => {
        const map = mapRef.current
        if (!map) return resolve()
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve()
        }
        map.once('moveend', finish)
        // Start the fade a touch before the camera settles, so there's no dead time at the end.
        setTimeout(finish, FLY_MS - 250)
        const to = { center: [site.lon, site.lat] as [number, number], zoom: 17.4, pitch: 64, bearing: map.getBearing() - 35 }
        sessionStorage.setItem(RETURN_KEY, JSON.stringify({ from: to, to: viewOf(map) }))
        map.flyTo({ ...to, duration: FLY_MS, curve: 1.5, essential: true, easing: easeInOut })
      }),
    flyHome: () => mapRef.current?.flyTo({ center: MUNICH, zoom: 10.4, pitch: 52, bearing: -18, duration: 2500 }),
    flyTo: (lat, lon) => mapRef.current?.flyTo({ center: [lon, lat], zoom: 17, pitch: 0, bearing: 0, duration: 1800, essential: true }),
  }))

  // MapLibre's CSS forces .maplibregl-map to position:relative, so size it through a wrapper.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" />
    </div>
  )
}

/** Re-tint OpenFreeMap "dark" to a navy palette and add 3D buildings / sky / optional terrain. */
function styleMap(map: MlMap) {
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop as never, value as never)
  }
  set('background', 'background-color', '#060a14')
  set('water', 'fill-color', '#0a1830')
  set('landuse_residential', 'fill-color', '#0a0f1c')
  set('landcover_wood', 'fill-color', '#081610')
  set('landuse_park', 'fill-color', '#081610')
  set('building', 'fill-color', '#0d1424')
  set('building', 'fill-outline-color', '#18233a')
  for (const l of map.getStyle().layers ?? []) {
    if (l.type === 'line' && l.id.startsWith('highway')) {
      const major = /major|motorway/.test(l.id)
      set(l.id, 'line-color', major ? (l.id.includes('casing') ? '#0a1222' : '#1b3358') : '#141f36')
    }
    if (l.type === 'line' && l.id.startsWith('boundary')) set(l.id, 'line-color', '#2a3f6b')
    if (l.type === 'symbol') {
      set(l.id, 'text-color', '#8aa0c8')
      set(l.id, 'text-halo-color', '#05070d')
    }
  }
  const firstSymbol = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id
  if (!map.getLayer('building-3d')) {
    map.addLayer(
      {
        id: 'building-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13.5,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#121b30', 20, '#1c2b4d', 60, '#2b4373'],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, ['coalesce', ['get', 'render_height'], 8]],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.88,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      firstSymbol,
    )
  }
  map.setSky({
    'sky-color': '#0b1532',
    'horizon-color': '#1d3a6e',
    'fog-color': '#060a14',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.75,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.9, 10, 0.2, 12, 0],
  })
  const key = import.meta.env.VITE_MAPTILER_KEY as string | undefined
  if (key && !map.getSource('terrain')) {
    map.addSource('terrain', { type: 'raster-dem', url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${key}`, tileSize: 256 })
    map.setTerrain({ source: 'terrain', exaggeration: 1.4 })
  }
}
