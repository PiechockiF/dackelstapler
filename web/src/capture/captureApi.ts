// Owner: agent C. Upload with progress + live job tracking (WebSocket push, polling fallback).
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { Building, CaptureJob, Space, WsMessage } from '../lib/types'
import { useLive } from '../lib/ws'

/** POST multipart with upload progress (fetch has none). Resolves to the CaptureJob. */
export function uploadForm(url: string, form: FormData, onProgress: (fraction: number) => void): Promise<CaptureJob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      let body: any = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as CaptureJob)
      else reject(new Error(body.detail ?? `${xhr.status} ${xhr.statusText}`))
    }
    xhr.onerror = () => reject(new Error('Network error — is the phone on the same Wi-Fi as the laptop?'))
    xhr.send(form)
  })
}

/** Follow one capture job: WebSocket capture_progress messages, plus polling every 1.5 s as a fallback. */
export function useCaptureJob(initial: CaptureJob | null) {
  const [job, setJob] = useState<CaptureJob | null>(initial)
  const jobId = initial?.id ?? null
  const latest = useRef<CaptureJob | null>(initial)

  useEffect(() => {
    setJob(initial)
    latest.current = initial
  }, [initial])

  const onMessage = useCallback(
    (message: WsMessage) => {
      if (message.type !== 'capture_progress' || message.job.id !== jobId) return
      const current = latest.current
      // Never go backwards (a late poll can race a push).
      if (current && current.status === 'done') return
      if (current && message.job.progress < current.progress && message.job.status !== 'failed') return
      latest.current = message.job
      setJob(message.job)
    },
    [jobId],
  )
  useLive(onMessage)

  useEffect(() => {
    if (!jobId) return
    let stopped = false
    const tick = async () => {
      if (stopped) return
      const current = latest.current
      if (current && (current.status === 'done' || current.status === 'failed')) return
      try {
        const polled = await api.captureJob(jobId)
        const now = latest.current
        if (!now || polled.progress >= now.progress || polled.status === 'done' || polled.status === 'failed') {
          latest.current = polled
          setJob(polled)
        }
      } catch {
        /* transient; keep polling */
      }
      if (!stopped) window.setTimeout(tick, 1500)
    }
    const timer = window.setTimeout(tick, 1200)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [jobId])

  return job
}

export function spaceTitle(space: Space): string {
  return space.name || space.ref || space.id
}

/** Spaces a person would pick as a destination / scan target, grouped by floor (corridors last). */
export function pickableSpaces(building: Building | null): { floorName: string; level: number; spaces: Space[] }[] {
  if (!building) return []
  const rank = (s: Space) => (s.type === 'room' ? 0 : s.type === 'hall' ? 1 : s.type === 'corridor' ? 2 : 3)
  return [...building.floors]
    .sort((a, b) => a.level - b.level)
    .map((floor) => ({
      floorName: floor.name || `Level ${floor.level}`,
      level: floor.level,
      spaces: building.spaces
        .filter((s) => s.floor_id === floor.id && s.type !== 'stair' && s.type !== 'lift' && s.type !== 'outdoor')
        .sort((a, b) => rank(a) - rank(b) || spaceTitle(a).localeCompare(spaceTitle(b), undefined, { numeric: true })),
    }))
    .filter((group) => group.spaces.length)
}

export const MARKER_PDF_URL = '/api/capture/marker.pdf'

export async function samplePhotoFile(): Promise<File> {
  const response = await fetch(`/api/capture/sample.jpg?seed=${Math.floor(Math.random() * 1000)}`)
  if (!response.ok) throw new Error('Sample photo unavailable — is the server running?')
  return new File([await response.blob()], 'sample-pallet.jpg', { type: 'image/jpeg' })
}
