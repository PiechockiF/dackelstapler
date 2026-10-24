import * as THREE from 'three'

// Soft palette by room_type, tuned for a dark scene.
const ROOM: Record<string, string> = {
  office: '#6f8fe0',
  meeting_room: '#a68be8',
  seminar_room: '#a68be8',
  lecture_hall: '#9479e0',
  library: '#9a86d8',
  lab: '#3cb8cf',
  quality_lab: '#3cb8cf',
  makerspace: '#45c4b0',
  production_zone: '#d9a55a',
  assembly_zone: '#d4b062',
  additive_zone: '#e0975e',
  warehouse_zone: '#c4875a',
  logistics_zone: '#c99a63',
  storage: '#a98568',
  corridor: '#2c3550',
  lobby: '#38446a',
  hall: '#34405f',
  toilet: '#5fbfae',
  bathroom: '#5fbfae',
  locker_room: '#5aa99b',
  kitchen: '#86b860',
  canteen: '#86b860',
  server_room: '#d9677e',
  technical_room: '#c46c86',
  print_room: '#b77a9a',
  stairwell: '#8b95c9',
  lift: '#8b95c9',
  bedroom: '#68a8d8',
  living_room: '#7cc4c0',
  balcony: '#3d4870',
  shop: '#d8a95a',
  generic_room: '#5b6fa6',
}

export function roomColor(roomType?: string, type?: string): THREE.Color {
  const hex = ROOM[roomType ?? ''] ?? ROOM[type ?? ''] ?? '#5b6fa6'
  return new THREE.Color(hex)
}

export const ROOM_LEGEND: [string, string][] = [
  ['Office', ROOM.office],
  ['Meeting', ROOM.meeting_room],
  ['Lab', ROOM.lab],
  ['Production', ROOM.production_zone],
  ['Warehouse', ROOM.warehouse_zone],
  ['Server/Tech', ROOM.server_room],
  ['Kitchen', ROOM.kitchen],
  ['Sanitary', ROOM.toilet],
  ['Circulation', ROOM.corridor],
]

const CATEGORY: Record<string, string> = {
  furniture: '#9aa7c7',
  fixture: '#6f7d9c',
  machine: '#f0a640',
  equipment: '#4fd1e8',
}

export function assetColor(category: string, type: string): THREE.Color {
  const c = new THREE.Color(CATEGORY[category] ?? '#9aa7c7')
  if (type.includes('rack')) c.set('#5d7bb8')
  if (type.includes('plant')) c.set('#4caf6a')
  if (type.includes('forklift') || type.includes('pallet_jack')) c.set('#f5b638')
  if (type.includes('extinguisher')) c.set('#e5484d')
  return c
}

// Asset heights (m) by type keyword, falling back to category.
const HEIGHTS: [string, number][] = [
  ['pallet_rack', 3.2], ['server_rack', 2.0], ['rack', 2.0], ['bookshelf', 1.9], ['locker', 1.9], ['shoe_cabinet', 1.0],
  ['filing_cabinet', 1.2], ['tool_cabinet', 1.6], ['wardrobe', 2.0], ['fridge', 1.8], ['plant', 1.2],
  ['fire_extinguisher', 0.6], ['display_screen', 1.5], ['whiteboard', 1.6], ['office_chair', 0.95], ['chair', 0.85],
  ['desk', 0.75], ['table', 0.75], ['bench', 0.45], ['sofa', 0.8], ['bed', 0.55], ['kitchen_counter', 0.9],
  ['stove', 0.9], ['dishwasher', 0.85], ['sink', 0.9], ['toilet', 0.8], ['bathtub', 0.6], ['shower', 2.0],
  ['coffee_machine', 0.45], ['microwave', 0.35], ['hand_dryer', 0.35], ['forklift', 2.2], ['pallet_jack', 1.2],
  ['cnc', 2.3], ['injection', 2.2], ['moulding', 2.2], ['press', 2.6], ['conveyor', 0.95], ['3d_printer', 1.6],
  ['printer', 1.2], ['drill', 1.8], ['welding', 1.5], ['workbench', 0.95], ['assembly_station', 1.2],
  ['packing_station', 1.0], ['microscope', 0.5], ['ups', 1.8], ['measuring', 2.0], ['robot', 2.0], ['lathe', 1.6],
]

export function assetHeight(category: string, type: string): number {
  for (const [key, h] of HEIGHTS) if (type.includes(key)) return h
  return category === 'machine' ? 1.9 : category === 'equipment' ? 1.2 : category === 'fixture' ? 1.0 : 0.8
}

export const COLORS = {
  bg: '#05070d',
  bgTop: '#0b1430',
  accent: new THREE.Color('#38bdf8'),
  accent2: new THREE.Color('#a78bfa'),
  ok: new THREE.Color('#34d399'),
  warn: new THREE.Color('#fbbf24'),
  danger: new THREE.Color('#f43f5e'),
  booked: new THREE.Color('#3b82f6'),
  wall: new THREE.Color('#a9bde6'),
  outline: new THREE.Color('#7dd3fc'),
}

/** Multiply a color past 1.0 so it crosses the bloom threshold. */
export const glow = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k)
