import type { BookableRoom, Booking, Building, CaptureJob, Route, RoomScan, Site, SiteEvent, SiteState, XY } from './types'
import type { RouteRequest } from '../local/types'

export interface SiteTwinDataProvider {
  sites(): Promise<Site[]>
  building(id: string): Promise<Building>
  state(id: string): Promise<SiteState>
  route(id: string, body: RouteRequest): Promise<Route>
  setClosed(id: string, element: string, closed: boolean): Promise<SiteState>
  moveAsset(id: string, asset: string, space: string, position?: XY): Promise<SiteState>
  events(id: string, since?: string, limit?: number): Promise<SiteEvent[]>
  bookableRooms(id: string, start: string, end: string, people: number, near?: string | null): Promise<BookableRoom[]>
  bookings(id: string): Promise<Booking[]>
  book(id: string, body: Omit<Booking, 'id' | 'site_id'>): Promise<Booking>
  previewSite(form: FormData): Promise<{ building: Building; warnings: string[] }>
  createSite(form: FormData): Promise<Site>
  captureDelivery(form: FormData): Promise<CaptureJob>
  captureRoom(form: FormData): Promise<CaptureJob>
  captureJob(id: string): Promise<CaptureJob>
  roomScans(id: string): Promise<RoomScan[]>
  health(): Promise<{ voice?: boolean; llm?: boolean; ok?: boolean }>
  captureHost(): Promise<{ lan_ip: string | null }>
}
