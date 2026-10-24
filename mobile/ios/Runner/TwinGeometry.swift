import Foundation

// MARK: - Defensive JSON parsing

enum TwinParse {
  static func dictionary(_ value: Any?) -> [String: Any]? {
    if let dictionary = value as? [String: Any] { return dictionary }
    guard let dictionary = value as? [AnyHashable: Any] else { return nil }
    var result: [String: Any] = [:]
    for (key, value) in dictionary {
      if let key = key as? String { result[key] = value }
    }
    return result
  }

  static func array(_ value: Any?) -> [Any]? {
    value as? [Any]
  }

  static func string(_ value: Any?) -> String? {
    guard let string = value as? String, !string.isEmpty else { return nil }
    return string
  }

  static func double(_ value: Any?) -> Double? {
    let number: Double?
    switch value {
    case let value as Double:
      number = value
    case let value as Float:
      number = Double(value)
    case let value as Int:
      number = Double(value)
    case let value as NSNumber:
      number = value.doubleValue
    case let value as String:
      number = Double(value)
    default:
      number = nil
    }
    guard let number, number.isFinite else { return nil }
    return number
  }

  static func int(_ value: Any?) -> Int? {
    guard let number = double(value) else { return nil }
    return Int(number)
  }

  static func bool(_ value: Any?) -> Bool? {
    switch value {
    case let value as Bool:
      return value
    case let value as NSNumber:
      return value.boolValue
    case let value as String:
      if value == "true" { return true }
      if value == "false" { return false }
      return nil
    default:
      return nil
    }
  }

  static func point(_ value: Any?) -> TwinPoint? {
    guard let values = array(value), values.count >= 2,
          let x = double(values[0]), let y = double(values[1]) else { return nil }
    return TwinPoint(x: x, y: y)
  }

  static func points(_ value: Any?) -> [TwinPoint] {
    guard let values = array(value) else { return [] }
    var points = values.compactMap(point)
    if points.count > 1, points.first == points.last { points.removeLast() }
    if points.count > 1 {
      var compact: [TwinPoint] = []
      compact.reserveCapacity(points.count)
      for point in points where compact.last != point { compact.append(point) }
      points = compact
    }
    return points
  }

  static func strings(_ value: Any?) -> [String] {
    array(value)?.compactMap(string) ?? []
  }

  static func isNull(_ value: Any?) -> Bool {
    value == nil || value is NSNull
  }

  static func jsonEqual(_ lhs: Any?, _ rhs: Any?) -> Bool {
    if isNull(lhs), isNull(rhs) { return true }
    if isNull(lhs) || isNull(rhs) { return false }
    return NSDictionary(dictionary: ["value": lhs!]).isEqual(to: ["value": rhs!])
  }
}

enum TwinGeometryError: LocalizedError {
  case invalidBuilding(String)

  var errorDescription: String? {
    switch self {
    case .invalidBuilding(let message): return message
    }
  }
}

// MARK: - Building model

struct TwinPoint: Equatable {
  let x: Double
  let y: Double

  static let zero = TwinPoint(x: 0, y: 0)

  func distance(to other: TwinPoint) -> Double {
    hypot(x - other.x, y - other.y)
  }
}

struct TwinWorldPoint: Equatable {
  let x: Double
  let z: Double

  func distance(to other: TwinWorldPoint) -> Double {
    hypot(x - other.x, z - other.z)
  }
}

struct TwinBBox {
  let minX: Double
  let minY: Double
  let maxX: Double
  let maxY: Double

  init(points: [TwinPoint]) {
    guard let first = points.first else {
      self.init(minX: -5, minY: -5, maxX: 5, maxY: 5)
      return
    }
    var minX = first.x
    var minY = first.y
    var maxX = first.x
    var maxY = first.y
    for point in points.dropFirst() {
      minX = min(minX, point.x)
      minY = min(minY, point.y)
      maxX = max(maxX, point.x)
      maxY = max(maxY, point.y)
    }
    self.init(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
  }

  init(minX: Double, minY: Double, maxX: Double, maxY: Double) {
    self.minX = minX
    self.minY = minY
    self.maxX = maxX
    self.maxY = maxY
  }

  var width: Double { maxX - minX }
  var height: Double { maxY - minY }
  var center: TwinPoint { TwinPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2) }
}

struct TwinFloor {
  let id: String
  let level: Int
  let elevation: Double
  let height: Double
}

struct TwinSpace {
  let id: String
  let floorId: String
  let type: String
  let roomType: String?
  let polygon: [TwinPoint]
}

struct TwinOpening {
  let id: String
  let floorId: String
  let spaceIds: [String]
  let kind: String
  let position: TwinPoint
  let width: Double

  init?(dictionary: [String: Any]) {
    guard let id = TwinParse.string(dictionary["id"]),
          let floorId = TwinParse.string(dictionary["floor_id"]),
          let position = TwinParse.point(dictionary["position"]) else { return nil }
    self.id = id
    self.floorId = floorId
    self.spaceIds = TwinParse.strings(dictionary["space_ids"])
    self.kind = dictionary["kind"] as? String ?? "door"
    self.position = position
    self.width = max(0.05, TwinParse.double(dictionary["width_m"]) ?? 0.9)
  }
}

struct TwinFootprint {
  let width: Double
  let depth: Double
  let rotation: Double
}

struct TwinAsset {
  let id: String
  let category: String
  let type: String
  let floorId: String
  let position: TwinPoint
  let footprint: TwinFootprint?
}

struct TwinConnector {
  let id: String
  let kind: String
  let floorIds: [String]
  let spaceIds: [String]
}

struct TwinBuilding {
  let floors: [TwinFloor]
  let spaces: [TwinSpace]
  let openings: [TwinOpening]
  let assets: [TwinAsset]
  let connectors: [TwinConnector]

  init(dictionary: [String: Any]) throws {
    guard let rawFloors = TwinParse.array(dictionary["floors"]),
          let rawSpaces = TwinParse.array(dictionary["spaces"]) else {
      throw TwinGeometryError.invalidBuilding("Building requires floors and spaces arrays.")
    }

    var floors: [TwinFloor] = []
    floors.reserveCapacity(rawFloors.count)
    for raw in rawFloors {
      guard let item = TwinParse.dictionary(raw),
            let id = TwinParse.string(item["id"]) else { continue }
      let elevation = TwinParse.double(item["elevation_m"]) ?? 0
      floors.append(TwinFloor(
        id: id,
        level: TwinParse.int(item["level"]) ?? 0,
        elevation: elevation,
        height: TwinParse.double(item["height_m"]) ?? 3
      ))
    }
    guard !floors.isEmpty else {
      throw TwinGeometryError.invalidBuilding("Building has no valid floors.")
    }

    var spaces: [TwinSpace] = []
    spaces.reserveCapacity(rawSpaces.count)
    for raw in rawSpaces {
      guard let item = TwinParse.dictionary(raw),
            let id = TwinParse.string(item["id"]),
            let floorId = TwinParse.string(item["floor_id"]) else { continue }
      let polygon = TwinParse.points(item["polygon"])
      guard polygon.count >= 3 else { continue }
      spaces.append(TwinSpace(
        id: id,
        floorId: floorId,
        type: item["type"] as? String ?? "generic_room",
        roomType: item["room_type"] as? String,
        polygon: polygon
      ))
    }

    self.floors = floors
    self.spaces = spaces
    self.openings = (TwinParse.array(dictionary["openings"]) ?? []).compactMap {
      TwinParse.dictionary($0).flatMap(TwinOpening.init)
    }
    self.assets = (TwinParse.array(dictionary["assets"]) ?? []).compactMap { raw in
      guard let item = TwinParse.dictionary(raw),
            let id = TwinParse.string(item["id"]),
            let floorId = TwinParse.string(item["floor_id"]),
            let position = TwinParse.point(item["position"]) else { return nil }
      var footprint: TwinFootprint?
      if let rawFootprint = TwinParse.dictionary(item["footprint"]) {
        footprint = TwinFootprint(
          width: TwinParse.double(rawFootprint["width_m"]) ?? 0.5,
          depth: TwinParse.double(rawFootprint["depth_m"]) ?? 0.5,
          rotation: TwinParse.double(rawFootprint["rotation_deg"]) ?? 0
        )
      }
      return TwinAsset(
        id: id,
        category: item["category"] as? String ?? "furniture",
        type: item["type"] as? String ?? "",
        floorId: floorId,
        position: position,
        footprint: footprint
      )
    }
    self.connectors = (TwinParse.array(dictionary["vertical_connectors"]) ?? []).compactMap { raw in
      guard let item = TwinParse.dictionary(raw), let id = TwinParse.string(item["id"]) else { return nil }
      return TwinConnector(
        id: id,
        kind: item["kind"] as? String ?? "stairs",
        floorIds: TwinParse.strings(item["floor_ids"]),
        spaceIds: TwinParse.strings(item["space_ids"])
      )
    }
  }
}

// MARK: - Live state and route model

struct TwinAssetOverride {
  let floorId: String
  let position: TwinPoint
}

struct TwinDimensions {
  let width: Double
  let depth: Double
  let height: Double

  init?(dictionary: [String: Any]?) {
    guard let dictionary,
          let width = TwinParse.double(dictionary["w"]),
          let depth = TwinParse.double(dictionary["d"]),
          let height = TwinParse.double(dictionary["h"]) else { return nil }
    self.width = width
    self.depth = depth
    self.height = height
  }
}

struct TwinDelivery {
  let id: String
  let floorId: String
  let position: TwinPoint
  let rotation: Double
  let dimensions: TwinDimensions
  let status: String
}

struct TwinState {
  let closed: Set<String>
  let overrides: [String: TwinAssetOverride]
  let deliveries: [TwinDelivery]
  let addedOpenings: [TwinOpening]

  static let empty = TwinState(closed: [], overrides: [:], deliveries: [], addedOpenings: [])

  init(closed: Set<String>, overrides: [String: TwinAssetOverride], deliveries: [TwinDelivery], addedOpenings: [TwinOpening]) {
    self.closed = closed
    self.overrides = overrides
    self.deliveries = deliveries
    self.addedOpenings = addedOpenings
  }

  init(dictionary: [String: Any]?) {
    guard let dictionary else {
      self = .empty
      return
    }
    closed = Set(TwinParse.strings(dictionary["closed"]))
    var overrides: [String: TwinAssetOverride] = [:]
    if let rawOverrides = TwinParse.dictionary(dictionary["asset_overrides"]) {
      for (id, raw) in rawOverrides {
        guard let item = TwinParse.dictionary(raw),
              let floorId = TwinParse.string(item["floor_id"]),
              let position = TwinParse.point(item["position"]) else { continue }
        overrides[id] = TwinAssetOverride(floorId: floorId, position: position)
      }
    }
    self.overrides = overrides
    deliveries = (TwinParse.array(dictionary["deliveries"]) ?? []).compactMap { raw in
      guard let item = TwinParse.dictionary(raw),
            let id = TwinParse.string(item["id"]),
            let floorId = TwinParse.string(item["floor_id"]),
            let position = TwinParse.point(item["position"]),
            let dimensions = TwinDimensions(dictionary: TwinParse.dictionary(item["dims_m"])) else { return nil }
      return TwinDelivery(
        id: id,
        floorId: floorId,
        position: position,
        rotation: TwinParse.double(item["rotation_deg"]) ?? 0,
        dimensions: dimensions,
        status: item["status"] as? String ?? "ok"
      )
    }
    addedOpenings = (TwinParse.array(dictionary["added_openings"]) ?? []).compactMap {
      TwinParse.dictionary($0).flatMap(TwinOpening.init)
    }
  }
}

struct TwinRouteFloor {
  let floorId: String
  let points: [TwinPoint]
}

struct TwinRouteConnector {
  let id: String
  let fromFloorId: String
  let toFloorId: String
  let position: TwinPoint
}

struct TwinBlockingOpening {
  let id: String
  let floorId: String
  let position: TwinPoint
  let width: Double
}

struct TwinRoute {
  let reachable: Bool
  let stepFree: Bool
  let floors: [TwinRouteFloor]
  let connectors: [TwinRouteConnector]
  let blockingOpenings: [TwinBlockingOpening]

  init(dictionary: [String: Any]) {
    reachable = TwinParse.bool(dictionary["reachable"]) ?? false
    stepFree = TwinParse.bool(dictionary["step_free"]) ?? false
    floors = (TwinParse.array(dictionary["floors"]) ?? []).compactMap { raw in
      guard let item = TwinParse.dictionary(raw), let floorId = TwinParse.string(item["floor_id"]) else { return nil }
      return TwinRouteFloor(floorId: floorId, points: TwinParse.points(item["points"]))
    }
    connectors = (TwinParse.array(dictionary["connectors"]) ?? []).compactMap { raw in
      guard let item = TwinParse.dictionary(raw),
            let id = TwinParse.string(item["id"]),
            let fromFloorId = TwinParse.string(item["from_floor_id"]),
            let toFloorId = TwinParse.string(item["to_floor_id"]),
            let position = TwinParse.point(item["position"]) else { return nil }
      return TwinRouteConnector(id: id, fromFloorId: fromFloorId, toFloorId: toFloorId, position: position)
    }
    blockingOpenings = (TwinParse.array(dictionary["blocking_openings"]) ?? []).compactMap { raw in
      guard let item = TwinParse.dictionary(raw),
            let id = TwinParse.string(item["id"]),
            let floorId = TwinParse.string(item["floor_id"]),
            let position = TwinParse.point(item["position"]) else { return nil }
      return TwinBlockingOpening(
        id: id,
        floorId: floorId,
        position: position,
        width: max(0.05, TwinParse.double(item["width_m"]) ?? 0.9)
      )
    }
  }
}

// MARK: - Floor stack layout

struct TwinFloorLayout {
  let floor: TwinFloor
  let index: Int
  let relativeIndex: Int
  let bbox: TwinBBox
  let wallHeight: Double
}

struct TwinLayout {
  let center: TwinPoint
  let extent: Double
  let gap: Double
  let floors: [TwinFloorLayout]
  let byId: [String: TwinFloorLayout]

  init(building: TwinBuilding) {
    let allPoints = building.spaces.flatMap(\.polygon)
    let allBBox = TwinBBox(points: allPoints)
    center = allBBox.center
    extent = max(allBBox.width, allBBox.height, 10)
    gap = min(22, max(5, extent * 0.13))

    let sorted = building.floors.sorted {
      $0.elevation == $1.elevation ? $0.level < $1.level : $0.elevation < $1.elevation
    }
    let groundIndex = max(0, sorted.firstIndex { $0.level >= 0 } ?? 0)
    var layouts: [TwinFloorLayout] = []
    layouts.reserveCapacity(sorted.count)
    var indexed: [String: TwinFloorLayout] = [:]
    for (index, floor) in sorted.enumerated() {
      let floorPoints = building.spaces.filter { $0.floorId == floor.id }.flatMap(\.polygon)
      let height = floor.height == 0 ? 3 : floor.height
      let layout = TwinFloorLayout(
        floor: floor,
        index: index,
        relativeIndex: index - groundIndex,
        bbox: floorPoints.isEmpty ? allBBox : TwinBBox(points: floorPoints),
        wallHeight: max(1.2, min(height, 3))
      )
      layouts.append(layout)
      indexed[floor.id] = layout
    }
    floors = layouts
    byId = indexed
  }

  func toWorld(_ point: TwinPoint) -> TwinWorldPoint {
    TwinWorldPoint(x: point.x - center.x, z: -(point.y - center.y))
  }

  func stackY(_ floor: TwinFloorLayout, explode: Double) -> Double {
    floor.floor.elevation + Double(floor.relativeIndex) * gap * explode
  }

  func targetY(_ floorId: String, exploded: Bool) -> Double {
    guard let floor = byId[floorId] else { return 0 }
    return stackY(floor, explode: exploded ? 1 : 0)
  }

  func minimumY(exploded: Bool) -> Double {
    floors.reduce(0) { result, floor in
      min(result, stackY(floor, explode: exploded ? 1 : 0))
    } - 1
  }
}

// MARK: - Geometry helpers

struct TwinLocation {
  let floorId: String
  let point: TwinPoint
  let radius: Double
}

enum TwinGeometry {
  static func polygonArea(_ polygon: [TwinPoint]) -> Double {
    guard polygon.count >= 3 else { return 0 }
    var area = 0.0
    for index in polygon.indices {
      let a = polygon[index]
      let b = polygon[(index + 1) % polygon.count]
      area += a.x * b.y - b.x * a.y
    }
    return area / 2
  }

  static func centroid(_ polygon: [TwinPoint]) -> TwinPoint {
    guard !polygon.isEmpty else { return .zero }
    let area = polygonArea(polygon)
    guard abs(area) > 1e-9 else {
      return TwinPoint(
        x: polygon.reduce(0) { $0 + $1.x } / Double(polygon.count),
        y: polygon.reduce(0) { $0 + $1.y } / Double(polygon.count)
      )
    }
    var x = 0.0
    var y = 0.0
    for index in polygon.indices {
      let a = polygon[index]
      let b = polygon[(index + 1) % polygon.count]
      let factor = a.x * b.y - b.x * a.y
      x += (a.x + b.x) * factor
      y += (a.y + b.y) * factor
    }
    return TwinPoint(x: x / (6 * area), y: y / (6 * area))
  }

  static func pointInPolygon(_ point: TwinPoint, _ polygon: [TwinPoint]) -> Bool {
    guard polygon.count >= 3 else { return false }
    var inside = false
    var previous = polygon.count - 1
    for index in polygon.indices {
      let a = polygon[index]
      let b = polygon[previous]
      if (a.y > point.y) != (b.y > point.y),
         point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x {
        inside.toggle()
      }
      previous = index
    }
    return inside
  }

  static func interiorPoint(_ polygon: [TwinPoint]) -> TwinPoint {
    let center = centroid(polygon)
    if pointInPolygon(center, polygon) { return center }
    guard let minY = polygon.map(\.y).min(), let maxY = polygon.map(\.y).max() else { return center }
    let scanY = (minY + maxY) / 2 + 1e-6
    var intersections: [Double] = []
    for index in polygon.indices {
      let a = polygon[index]
      let b = polygon[(index + 1) % polygon.count]
      if (a.y > scanY) != (b.y > scanY) {
        intersections.append(a.x + (scanY - a.y) * (b.x - a.x) / (b.y - a.y))
      }
    }
    intersections.sort()
    var best = center
    var bestWidth = -1.0
    var index = 0
    while index + 1 < intersections.count {
      let width = intersections[index + 1] - intersections[index]
      if width > bestWidth {
        bestWidth = width
        best = TwinPoint(x: (intersections[index] + intersections[index + 1]) / 2, y: scanY)
      }
      index += 2
    }
    return best
  }

  static func openingWallAngle(building: TwinBuilding, opening: TwinOpening) -> Double {
    var bestDistance = Double.infinity
    var angle = 0.0
    for spaceId in opening.spaceIds {
      guard let space = building.spaces.first(where: { $0.id == spaceId }) else { continue }
      for index in space.polygon.indices {
        let a = space.polygon[index]
        let b = space.polygon[(index + 1) % space.polygon.count]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let lengthSquared = dx * dx + dy * dy
        let rawT = lengthSquared > 0
          ? ((opening.position.x - a.x) * dx + (opening.position.y - a.y) * dy) / lengthSquared
          : 0
        let t = min(1, max(0, rawT))
        let projected = TwinPoint(x: a.x + t * dx, y: a.y + t * dy)
        let distance = opening.position.distance(to: projected)
        if distance < bestDistance {
          bestDistance = distance
          angle = atan2(dy, dx)
        }
      }
    }
    return angle
  }
}

extension TwinBuilding {
  func locations(for id: String, state: TwinState) -> [TwinLocation] {
    if let space = spaces.first(where: { $0.id == id }) {
      let bbox = TwinBBox(points: space.polygon)
      return [TwinLocation(
        floorId: space.floorId,
        point: TwinGeometry.interiorPoint(space.polygon),
        radius: max(1.2, min(12, max(bbox.width, bbox.height) / 2))
      )]
    }
    if let asset = assets.first(where: { $0.id == id }) {
      let override = state.overrides[id]
      let radius = asset.footprint.map { max($0.width, $0.depth) / 2 + 0.6 } ?? 1
      return [TwinLocation(
        floorId: override?.floorId ?? asset.floorId,
        point: override?.position ?? asset.position,
        radius: radius
      )]
    }
    if let opening = openings.first(where: { $0.id == id }) ?? state.addedOpenings.first(where: { $0.id == id }) {
      return [TwinLocation(floorId: opening.floorId, point: opening.position, radius: max(0.8, opening.width))]
    }
    if let delivery = state.deliveries.first(where: { $0.id == id }) {
      return [TwinLocation(
        floorId: delivery.floorId,
        point: delivery.position,
        radius: max(delivery.dimensions.width, delivery.dimensions.depth) + 0.8
      )]
    }
    if let connector = connectors.first(where: { $0.id == id }) {
      return connector.spaceIds.compactMap { spaceId in
        guard let space = spaces.first(where: { $0.id == spaceId }) else { return nil }
        return TwinLocation(floorId: space.floorId, point: TwinGeometry.interiorPoint(space.polygon), radius: 1.8)
      }
    }
    return []
  }
}

// MARK: - Shared web palette and dimensions

enum TwinPalette {
  static let background = "#05070D"
  static let cyan = "#38BDF8"
  static let violet = "#A78BFA"
  static let ok = "#34D399"
  static let warning = "#FBBF24"
  static let danger = "#F43F5E"

  private static let roomColors = [
    "office": "#6F8FE0", "meeting_room": "#A68BE8", "seminar_room": "#A68BE8",
    "lecture_hall": "#9479E0", "library": "#9A86D8", "lab": "#3CB8CF",
    "quality_lab": "#3CB8CF", "makerspace": "#45C4B0", "production_zone": "#D9A55A",
    "assembly_zone": "#D4B062", "additive_zone": "#E0975E", "warehouse_zone": "#C4875A",
    "logistics_zone": "#C99A63", "storage": "#A98568", "corridor": "#2C3550",
    "lobby": "#38446A", "hall": "#34405F", "toilet": "#5FBFAE", "bathroom": "#5FBFAE",
    "locker_room": "#5AA99B", "kitchen": "#86B860", "canteen": "#86B860",
    "server_room": "#D9677E", "technical_room": "#C46C86", "print_room": "#B77A9A",
    "stairwell": "#8B95C9", "lift": "#8B95C9", "bedroom": "#68A8D8",
    "living_room": "#7CC4C0", "balcony": "#3D4870", "shop": "#D8A95A",
    "generic_room": "#5B6FA6",
  ]

  static func roomColor(roomType: String?, type: String) -> String {
    if let roomType, let color = roomColors[roomType] { return color }
    return roomColors[type] ?? "#5B6FA6"
  }

  static func assetColor(category: String, type: String) -> String {
    if type.contains("rack") { return "#5D7BB8" }
    if type.contains("plant") { return "#4CAF6A" }
    if type.contains("forklift") || type.contains("pallet_jack") { return "#F5B638" }
    if type.contains("extinguisher") { return "#E5484D" }
    switch category {
    case "fixture": return "#6F7D9C"
    case "machine": return "#F0A640"
    case "equipment": return "#4FD1E8"
    default: return "#9AA7C7"
    }
  }

  private static let heights: [(String, Double)] = [
    ("pallet_rack", 3.2), ("server_rack", 2), ("rack", 2), ("bookshelf", 1.9),
    ("locker", 1.9), ("shoe_cabinet", 1), ("filing_cabinet", 1.2),
    ("tool_cabinet", 1.6), ("wardrobe", 2), ("fridge", 1.8), ("plant", 1.2),
    ("fire_extinguisher", 0.6), ("display_screen", 1.5), ("whiteboard", 1.6),
    ("office_chair", 0.95), ("chair", 0.85), ("desk", 0.75), ("table", 0.75),
    ("bench", 0.45), ("sofa", 0.8), ("bed", 0.55), ("kitchen_counter", 0.9),
    ("stove", 0.9), ("dishwasher", 0.85), ("sink", 0.9), ("toilet", 0.8),
    ("bathtub", 0.6), ("shower", 2), ("coffee_machine", 0.45), ("microwave", 0.35),
    ("hand_dryer", 0.35), ("forklift", 2.2), ("pallet_jack", 1.2), ("cnc", 2.3),
    ("injection", 2.2), ("moulding", 2.2), ("press", 2.6), ("conveyor", 0.95),
    ("3d_printer", 1.6), ("printer", 1.2), ("drill", 1.8), ("welding", 1.5),
    ("workbench", 0.95), ("assembly_station", 1.2), ("packing_station", 1),
    ("microscope", 0.5), ("ups", 1.8), ("measuring", 2), ("robot", 2), ("lathe", 1.6),
  ]

  static func assetHeight(category: String, type: String) -> Double {
    for (keyword, height) in heights where type.contains(keyword) { return height }
    switch category {
    case "machine": return 1.9
    case "equipment": return 1.2
    case "fixture": return 1
    default: return 0.8
    }
  }
}
