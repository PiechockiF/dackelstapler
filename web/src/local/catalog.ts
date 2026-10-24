import type { Site } from '../lib/types'
import type { MobileBuilding } from './types'

interface Catalog { version: number; sites: Site[]; hashes: Record<string, string> }
let catalog: Promise<Catalog> | undefined
const cache = new Map<string, Promise<MobileBuilding>>()
async function read<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Bundled data is missing (${url}). Rebuild the offline assets.`)
  return r.json()
}
export function loadCatalog() {
  if (!catalog) catalog = read<Catalog>('/offline/catalog.json').then((c) => {
    if (c.version !== 1 || !c.sites.length) throw new Error('Unsupported offline data format. Update the app.')
    return c
  }).catch((e) => { catalog = undefined; throw e })
  return catalog
}
export async function loadMobileBuilding(id: string): Promise<MobileBuilding> {
  const c = await loadCatalog()
  if (!c.hashes[id]) throw new Error(`Unknown site: ${id}`)
  if (cache.has(id)) {
    const value = cache.get(id)!
    cache.delete(id); cache.set(id, value)
    return value
  }
  const value = read<MobileBuilding>(`/offline/${encodeURIComponent(id)}.json`).then((data) => {
    if (data.version !== c.version || data.sourceHash !== c.hashes[id]) throw new Error('Offline data is inconsistent. Update the app.')
    return data
  }).catch((e) => { cache.delete(id); throw e })
  cache.set(id, value)
  if (cache.size > 3) cache.delete(cache.keys().next().value!)
  return value
}
