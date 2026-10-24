import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { isNative } from '../lib/mode'
import { database, exportRecords, newId } from './storage'

const urls = new Map<string, string>()
const mediaPath = (id: string) => `sitetwin-media/${id}.jpg`
async function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('Could not read the photo.'))
    reader.readAsDataURL(blob)
  })
}
async function resizePhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo, not a video or document.')
  if (file.size > 30 * 1024 * 1024) throw new Error('Choose a photo smaller than 30 MB.')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Photo processing unavailable.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Photo conversion failed.')), 'image/jpeg', 0.8))
  } finally { URL.revokeObjectURL(url) }
}
export async function savePhoto(file: File): Promise<string> {
  const blob = await resizePhoto(file)
  const id = newId('photo')
  if (isNative) await Filesystem.writeFile({ path: mediaPath(id), directory: Directory.Library, data: await blobBase64(blob), recursive: true })
  else await (await database()).put('media', blob, id)
  return id
}
export async function photoUrl(id: string): Promise<string | undefined> {
  if (urls.has(id)) return urls.get(id)
  try {
    let url: string
    if (isNative) url = Capacitor.convertFileSrc((await Filesystem.getUri({ path: mediaPath(id), directory: Directory.Library })).uri)
    else {
      const blob = await (await database()).get('media', id)
      if (!blob) return undefined
      url = URL.createObjectURL(blob)
    }
    urls.set(id, url)
    // Cache only the current cards; revocation happens on reset, not while in use.
    return url
  } catch { return undefined }
}
export async function deletePhoto(id: string) {
  if (isNative) await Filesystem.deleteFile({ path: mediaPath(id), directory: Directory.Library })
  else await (await database()).delete('media', id)
  const url = urls.get(id)
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
  urls.delete(id)
}
export async function resetMedia() {
  for (const url of urls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  urls.clear()
  if (isNative) {
    try { await Filesystem.rmdir({ path: 'sitetwin-media', directory: Directory.Library, recursive: true }) }
    catch (error) {
      // An empty/new install has no media directory; verify absence rather than hide write errors.
      const list = await Filesystem.readdir({ path: '', directory: Directory.Library })
      if (list.files.some((f) => f.name === 'sitetwin-media')) throw error
    }
  }
}
export async function exportBackup(): Promise<string> {
  const records = await exportRecords()
  const photos: Record<string, string> = {}
  for (const site of records.sites) for (const delivery of site.state.deliveries) {
    if (!delivery.photo_id || photos[delivery.photo_id]) continue
    if (isNative) {
      const file = await Filesystem.readFile({ path: mediaPath(delivery.photo_id), directory: Directory.Library })
      photos[delivery.photo_id] = String(file.data)
    } else {
      const blob = await (await database()).get('media', delivery.photo_id)
      if (blob) photos[delivery.photo_id] = await blobBase64(blob)
    }
  }
  const text = JSON.stringify({ ...records, photos })
  const filename = `SiteTwin-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  if (isNative) {
    await Filesystem.writeFile({ path: filename, directory: Directory.Documents, encoding: Encoding.UTF8, data: text })
    return 'Backup saved. Open Files → On My iPhone → SiteTwin.'
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return 'Backup downloaded.'
}
