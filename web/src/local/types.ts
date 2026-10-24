import type { Building, XY } from '../lib/types'

/** An edge of the server's route graph (core.building_map). Doors are nodes ("door:<id>"). A walk inside a
 *  space names it (`space`; `bend`: drawn through the space's anchor); a lift, stairs or entrance to
 *  "outside" names its element (`via`). */
export interface GraphEdge {
  a: string; b: string; w: number; via?: string; space?: string; bend?: boolean
}
export interface MobileBuilding {
  version: number; sourceHash: string; building: Building
  anchors: Record<string, XY>; areas: Record<string, number>; capacities: Record<string, number>
  bookable: string[]; edges: GraphEdge[]
}
export interface RouteRequest {
  from: string; to: string; step_free?: boolean; min_width_m?: number; via?: string[]
}
