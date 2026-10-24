// Mirrors docs/CONTRACT.md. Keep the two in sync.

export type XY = [number, number]

export interface Site {
  id: string
  name: string
  lat: number
  lon: number
  source: string
  building_id: string
  data_path: string
  floors: number
  demo_location: boolean
  kind: 'factory' | 'campus' | 'office' | 'airport' | 'mall' | 'other'
}

export interface Floor { id: string; level: number; name: string; elevation_m: number; height_m: number }
export interface Space {
  id: string; floor_id: string; type: string; room_type?: string; name: string; ref?: string
  polygon: XY[]; synthetic?: boolean
}
export interface Opening {
  id: string; floor_id: string; space_ids: string[]; kind: string
  position: XY; width_m: number; step_free: boolean; synthetic?: boolean
}
export interface Connector {
  id: string; kind: 'stairs' | 'lift'; name: string; floor_ids: string[]; space_ids: string[]; step_free: boolean
}
export interface Asset {
  id: string; name: string; category: string; type: string; space_id: string; floor_id: string
  position: XY; footprint?: { width_m: number; depth_m: number; rotation_deg: number }; source?: string
}
/** GET /api/equipment-types: known equipment with its typical footprint (extra, not in contract v1). */
export interface EquipmentType { type: string; label: string; category: string; width_m: number; depth_m: number }
export interface Building {
  building: { id: string; name: string; source: string; license: string; attribution: string; units: string; scale?: { plan_width_m: number; plan_height_m: number; user_supplied: boolean } }
  floors: Floor[]
  spaces: Space[]
  openings: Opening[]
  vertical_connectors: Connector[]
  assets: Asset[]
}

export interface RouteFloorSegment { floor_id: string; level: number; elevation_m: number; points: XY[] }
export interface BlockingOpening { id: string; width_m: number; position: XY; floor_id: string }
export interface Route {
  from_space_id?: string
  to_space_id?: string
  via?: string[]
  message?: string
  reachable: boolean
  length_m: number
  step_free: boolean
  min_width_m: number | null
  space_path: string[]
  steps: string[]
  floors: RouteFloorSegment[]
  connectors: { id: string; kind: 'stairs' | 'lift'; from_floor_id: string; to_floor_id: string; position: XY }[]
  blocking_openings?: BlockingOpening[]
}

export type EventType =
  | 'delivery' | 'delivery_updated' | 'delivery_removed'
  | 'asset_moved' | 'asset_added' | 'asset_updated' | 'asset_removed'
  | 'closure' | 'booking' | 'door_added' | 'capture'
export interface SiteEvent { id: string; ts: string; site_id: string; type: EventType; title: string; payload: any }

export interface Dims { w: number; d: number; h: number }
export interface DimensionCheck {
  declared: { ok: boolean; deviation_m: Dims } | null
  route_fit: { ok: boolean; route?: Route; blocking_openings: BlockingOpening[]; alternative?: Route } | null
  floor_fit: { ok: boolean; reason: string } | null
  summary: string
}
export interface Delivery {
  id: string; site_id: string; ts: string; label: string; note?: string
  dims_m: Dims; tolerance_m: number; declared_dims_m?: Dims
  floor_id: string; space_id: string; position: XY; rotation_deg: number
  target_space_id?: string; photo_url?: string; model_url?: string
  status: 'ok' | 'mismatch' | 'blocked'; check: DimensionCheck
}

export interface SiteState {
  closed: string[]
  asset_overrides: Record<string, { position: XY; floor_id: string; space_id: string }>
  deliveries: Delivery[]
  added_openings: Opening[]
}

export interface Booking { id: string; site_id: string; space_id: string; start: string; end: string; who: string; title: string }
export interface BookableRoom {
  space_id: string; name: string; floor_id: string; level: number
  capacity: number; area_m2: number; free: boolean; bookings: Booking[]
}

export interface RoomScan {
  id: string; site_id: string; space_id: string; splat_url: string
  transform: number[]
  deviations: { wall_index: number; offset_m: number; segment: [XY, XY] }[]
  summary: string
}
export interface CaptureJob {
  id: string; kind: 'delivery' | 'room'; site_id: string
  status: 'queued' | 'measuring' | 'modeling' | 'aligning' | 'done' | 'failed'
  progress: number; message: string; result?: Delivery | RoomScan
}

export type ChatAction =
  | { type: 'set_location'; space_id: string }
  | { type: 'show_route'; route: Route }
  | { type: 'highlight'; ids: string[]; label?: string }
  | { type: 'focus_floor'; floor_id: string }
  | { type: 'understood'; chips: string[] }
  | { type: 'state_changed' }

export type WsMessage =
  | { type: 'event'; event: SiteEvent }
  | { type: 'capture_progress'; job: CaptureJob }
