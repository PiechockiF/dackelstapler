import type {
  Asset, BookableRoom, Booking, Building, CaptureJob, Delivery, Dims, EquipmentType, GeoResult, Reachable, Route, RoomScan,
  Site, SiteDraft, SiteEvent, SiteState, XY,
} from './types'
import type { RouteRequest } from '../local/types'

export interface RestitchRequest {
  extractions: unknown[]; matches?: Record<string, unknown> | null; level_overrides: Record<number, number>
  site_id?: string; name?: string; address?: string; lat?: number; lon?: number; width_m?: number
}
export interface NewAsset { type: string; space_id: string; name?: string; width_m?: number; depth_m?: number }
export type AssetChanges = Partial<NewAsset>
export interface NewDelivery { label: string; space_id: string; dims_m?: Dims; target_space_id?: string; note?: string }
/** target_space_id: null clears the destination; leave it out to keep it. */
export interface DeliveryChanges { label?: string; space_id?: string; dims_m?: Dims; target_space_id?: string | null; note?: string }

export interface SiteTwinDataProvider {
  sites(): Promise<Site[]>
  building(id: string): Promise<Building>
  state(id: string): Promise<SiteState>
  route(id: string, body: RouteRequest): Promise<Route>
  reachable(id: string, from: string, opts?: { step_free?: boolean; min_width_m?: number }): Promise<Reachable>
  setClosed(id: string, element: string, closed: boolean): Promise<SiteState>
  moveAsset(id: string, asset: string, space: string, position?: XY): Promise<SiteState>
  equipmentTypes(): Promise<EquipmentType[]>
  addAsset(id: string, body: NewAsset): Promise<Asset>
  updateAsset(id: string, assetId: string, body: AssetChanges): Promise<Asset>
  deleteAsset(id: string, assetId: string): Promise<{ ok: boolean }>
  logDelivery(id: string, body: NewDelivery): Promise<Delivery>
  updateDelivery(id: string, deliveryId: string, body: DeliveryChanges): Promise<Delivery>
  deleteDelivery(id: string, deliveryId: string): Promise<{ ok: boolean }>
  events(id: string, since?: string, limit?: number): Promise<SiteEvent[]>
  bookableRooms(id: string, start: string, end: string, people: number, near?: string | null): Promise<BookableRoom[]>
  bookings(id: string): Promise<Booking[]>
  book(id: string, body: Omit<Booking, 'id' | 'site_id'>): Promise<Booking>
  previewSite(form: FormData): Promise<SiteDraft>
  restitchSite(body: RestitchRequest): Promise<SiteDraft>
  createSite(form: FormData): Promise<Site>
  geocode(q: string, near?: { lat: number; lon: number }): Promise<GeoResult[]>
  reverseGeocode(lat: number, lon: number): Promise<GeoResult>
  captureDelivery(form: FormData): Promise<CaptureJob>
  captureRoom(form: FormData): Promise<CaptureJob>
  captureJob(id: string): Promise<CaptureJob>
  roomScans(id: string): Promise<RoomScan[]>
  health(): Promise<{ voice?: boolean; llm?: boolean; ok?: boolean }>
  captureHost(): Promise<{ lan_ip: string | null }>
}
