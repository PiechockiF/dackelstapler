import XCTest
@testable import Runner

final class RunnerTests: XCTestCase {
  private let square = [
    TwinPoint(x: 0, y: 0), TwinPoint(x: 4, y: 0), TwinPoint(x: 4, y: 4), TwinPoint(x: 0, y: 4),
  ]

  private func building(floors: [[String: Any]]) throws -> TwinBuilding {
    try TwinBuilding(dictionary: [
      "floors": floors,
      "spaces": floors.map { floor in
        [
          "id": "space-\(floor["id"]!)",
          "floor_id": floor["id"]!,
          "type": "room",
          "polygon": [[0, 0], [20, 0], [20, 10], [0, 10]],
        ] as [String: Any]
      },
    ])
  }

  func testPolygonAreaAndCentroid() {
    XCTAssertEqual(TwinGeometry.polygonArea(square), 16, accuracy: 1e-9)
    let centroid = TwinGeometry.centroid(square)
    XCTAssertEqual(centroid.x, 2, accuracy: 1e-9)
    XCTAssertEqual(centroid.y, 2, accuracy: 1e-9)
  }

  func testInteriorPointStaysInsideConcavePolygon() {
    let lShape = [
      TwinPoint(x: 0, y: 0), TwinPoint(x: 10, y: 0), TwinPoint(x: 10, y: 1),
      TwinPoint(x: 1, y: 1), TwinPoint(x: 1, y: 10), TwinPoint(x: 0, y: 10),
    ]
    XCTAssertTrue(TwinGeometry.pointInPolygon(TwinGeometry.interiorPoint(lShape), lShape))
  }

  func testLayoutCentresBuildingAndFlipsPlanY() throws {
    let layout = TwinLayout(building: try building(floors: [["id": "L0", "level": 0, "elevation_m": 0, "height_m": 3]]))
    XCTAssertEqual(layout.center.x, 10, accuracy: 1e-9)
    XCTAssertEqual(layout.center.y, 5, accuracy: 1e-9)
    let world = layout.toWorld(TwinPoint(x: 20, y: 10))
    XCTAssertEqual(world.x, 10, accuracy: 1e-9)
    XCTAssertEqual(world.z, -5, accuracy: 1e-9)
  }

  func testExplodedStackUsesGroundFloorAsReference() throws {
    let layout = TwinLayout(building: try building(floors: [
      ["id": "B1", "level": -1, "elevation_m": -3.5, "height_m": 3.5],
      ["id": "L0", "level": 0, "elevation_m": 0, "height_m": 4],
      ["id": "L1", "level": 1, "elevation_m": 4, "height_m": 4],
    ]))
    XCTAssertEqual(layout.gap, 5, accuracy: 1e-9)
    XCTAssertEqual(layout.targetY("L0", exploded: true), 0, accuracy: 1e-9)
    XCTAssertEqual(layout.targetY("L1", exploded: true), 9, accuracy: 1e-9)
    XCTAssertEqual(layout.targetY("B1", exploded: true), -8.5, accuracy: 1e-9)
    XCTAssertEqual(layout.targetY("L1", exploded: false), 4, accuracy: 1e-9)
  }

  func testMalformedBuildingThrowsReadableError() {
    XCTAssertThrowsError(try TwinBuilding(dictionary: ["floors": []])) { error in
      XCTAssertFalse(error.localizedDescription.isEmpty)
    }
  }

  func testRouteParsingSkipsInvalidSegments() {
    let route = TwinRoute(dictionary: [
      "reachable": true,
      "floors": [
        ["floor_id": "L0", "points": [[0, 0], [5, 0]]],
        ["points": [[1, 1]]],
      ],
      "connectors": [["id": "lift", "from_floor_id": "L0", "to_floor_id": "L1", "position": [5, 0]]],
    ])
    XCTAssertTrue(route.reachable)
    XCTAssertEqual(route.floors.count, 1)
    XCTAssertEqual(route.floors[0].points.count, 2)
    XCTAssertEqual(route.connectors.first?.toFloorId, "L1")
  }
}
