import type { Building, XY } from '../lib/types'

export interface GraphEdge {
  a: string; b: string; w: number; via: string; stepFree: boolean; width: number | null; kind: string
}
export interface MobileBuilding {
  version: number; sourceHash: string; building: Building
  anchors: Record<string, XY>; areas: Record<string, number>; capacities: Record<string, number>
  bookable: string[]; edges: GraphEdge[]
}
export interface RouteRequest {
  from: string; to: string; step_free?: boolean; min_width_m?: number; via?: string[]
}
