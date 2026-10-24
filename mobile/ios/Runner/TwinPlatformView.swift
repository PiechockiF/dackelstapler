import Flutter
import SceneKit
import UIKit

final class TwinViewFactory: NSObject, FlutterPlatformViewFactory {
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
    TwinPlatformView(frame: frame, viewId: viewId, arguments: args, messenger: messenger)
  }

  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }
}

private enum HitMask {
  static let selectable = 1 << 1
}

private enum Style {
  static let background = UIColor(hex: TwinPalette.background)
  static let backgroundTop = UIColor(hex: "#0B1430")
  static let slabTop: Float = 0.08
  static let routeHeight: Float = 0.45
}

/// SceneKit digital twin driven by semantic updates from Flutter (`sitetwin/twin/<id>`).
final class TwinPlatformView: NSObject, FlutterPlatformView {
  private let sceneView: SCNView
  private let channel: FlutterMethodChannel
  private let scene = SCNScene()
  private let cameraNode = SCNNode()
  private let worldNode = SCNNode()
  private let gridNode = SCNNode()
  private let connectorLayer = SCNNode()
  private let shaftLayer = SCNNode()
  private let reduceMotion = UIAccessibility.isReduceMotionEnabled
  private lazy var tapRecognizer = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))

  private var building: TwinBuilding?
  private var layout: TwinLayout?
  private var floorNodes: [String: SCNNode] = [:]
  private var assetLayers: [String: SCNNode] = [:]
  private var stateLayers: [String: SCNNode] = [:]
  private var routeLayers: [String: SCNNode] = [:]
  private var markerLayers: [String: SCNNode] = [:]
  private var deliveryNodes: [String: SCNNode] = [:]

  private var stateRaw: Any?
  private var routeRaw: Any?
  private var twinState = TwinState.empty
  private var route: TwinRoute?
  private var exploded = true
  private var focusFloorId: String?
  private var highlightIds: [String] = []
  private var selectedId: String?
  private var visibleDeliveryIds: Set<String>?

  private var materials: [String: SCNMaterial] = [:]
  private var unitBoxes: [String: SCNGeometry] = [:]
  private var disposed = false

  init(frame: CGRect, viewId: Int64, arguments: Any?, messenger: FlutterBinaryMessenger) {
    sceneView = SCNView(frame: frame, options: nil)
    channel = FlutterMethodChannel(name: "sitetwin/twin/\(viewId)", binaryMessenger: messenger)
    super.init()
    configureView()
    configureScene()
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(nil)
        return
      }
      self.handle(call, result: result)
    }
    if let arguments = TwinParse.dictionary(arguments) {
      apply(arguments)
    }
  }

  deinit {
    channel.setMethodCallHandler(nil)
  }

  func view() -> UIView {
    sceneView
  }

  // MARK: - Channel

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "sync":
      if let arguments = TwinParse.dictionary(call.arguments) {
        apply(arguments)
      }
      result(nil)
    case "frameAll":
      frameAll(duration: 0.8)
      result(nil)
    case "setRenderingActive":
      let active = TwinParse.bool(TwinParse.dictionary(call.arguments)?["active"]) ?? TwinParse.bool(call.arguments) ?? true
      setRenderingActive(active)
      result(nil)
    case "dispose":
      dispose()
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func report(_ message: String) {
    channel.invokeMethod("rendererError", arguments: message)
  }

  // MARK: - Setup

  private func configureView() {
    sceneView.backgroundColor = Style.background
    sceneView.scene = scene
    sceneView.pointOfView = cameraNode
    sceneView.antialiasingMode = .multisampling4X
    sceneView.preferredFramesPerSecond = 60
    sceneView.rendersContinuously = false
    sceneView.isPlaying = true
    sceneView.autoenablesDefaultLighting = false
    sceneView.allowsCameraControl = true
    sceneView.defaultCameraController.interactionMode = .orbitTurntable
    sceneView.defaultCameraController.inertiaEnabled = true
    tapRecognizer.cancelsTouchesInView = false
    sceneView.addGestureRecognizer(tapRecognizer)
  }

  private func configureScene() {
    scene.background.contents = backgroundGradient()
    scene.fogColor = Style.background

    let camera = SCNCamera()
    camera.fieldOfView = 38
    camera.zNear = 0.3
    camera.zFar = 4000
    camera.wantsHDR = true
    camera.wantsExposureAdaptation = false
    camera.bloomIntensity = 0.85
    camera.bloomThreshold = 0.8
    camera.bloomBlurRadius = 8
    camera.vignettingIntensity = 0.5
    camera.vignettingPower = 1.1
    cameraNode.camera = camera
    cameraNode.position = SCNVector3(60, 70, 80)
    cameraNode.look(at: SCNVector3(0, 0, 0))
    scene.rootNode.addChildNode(cameraNode)

    let ambient = SCNLight()
    ambient.type = .ambient
    ambient.intensity = 420
    ambient.color = UIColor(hex: "#9CB5E8")
    let ambientNode = SCNNode()
    ambientNode.light = ambient
    scene.rootNode.addChildNode(ambientNode)

    let key = SCNLight()
    key.type = .directional
    key.intensity = 950
    key.color = UIColor(hex: "#E8F0FF")
    let keyNode = SCNNode()
    keyNode.light = key
    keyNode.eulerAngles = SCNVector3(-0.95, 0.55, 0)
    scene.rootNode.addChildNode(keyNode)

    let fill = SCNLight()
    fill.type = .directional
    fill.intensity = 320
    fill.color = UIColor(hex: "#8B7CF6")
    let fillNode = SCNNode()
    fillNode.light = fill
    fillNode.eulerAngles = SCNVector3(-0.45, -2.4, 0)
    scene.rootNode.addChildNode(fillNode)

    scene.rootNode.addChildNode(gridNode)
    scene.rootNode.addChildNode(worldNode)
  }

  private func backgroundGradient() -> UIImage {
    let size = CGSize(width: 4, height: 512)
    return UIGraphicsImageRenderer(size: size).image { context in
      let colors = [Style.backgroundTop.cgColor, Style.background.cgColor] as CFArray
      guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) else { return }
      context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
    }
  }

  // MARK: - Updates

  private func apply(_ arguments: [String: Any]) {
    guard !disposed else { return }
    var buildingChanged = false
    if arguments.keys.contains("building"), let raw = TwinParse.dictionary(arguments["building"]) {
      do {
        try loadBuilding(raw)
        buildingChanged = true
      } catch {
        report(error.localizedDescription)
        return
      }
    }

    var stateChanged = false
    var overridesChanged = false
    if arguments.keys.contains("state"), !TwinParse.jsonEqual(arguments["state"], stateRaw) {
      let oldOverrides = TwinParse.dictionary(stateRaw)?["asset_overrides"]
      stateRaw = arguments["state"]
      twinState = TwinState(dictionary: TwinParse.dictionary(stateRaw))
      stateChanged = true
      overridesChanged = !TwinParse.jsonEqual(oldOverrides, TwinParse.dictionary(stateRaw)?["asset_overrides"])
    }

    var routeChanged = false
    if arguments.keys.contains("route"), !TwinParse.jsonEqual(arguments["route"], routeRaw) {
      routeRaw = arguments["route"]
      route = TwinParse.dictionary(routeRaw).map(TwinRoute.init(dictionary:))
      routeChanged = true
    }

    let previousExploded = exploded
    if arguments.keys.contains("exploded") {
      exploded = TwinParse.bool(arguments["exploded"]) ?? exploded
    }
    let explodedChanged = previousExploded != exploded

    let previousFocus = focusFloorId
    if arguments.keys.contains("focusFloorId") {
      focusFloorId = TwinParse.string(arguments["focusFloorId"])
    }
    let focusChanged = previousFocus != focusFloorId

    let previousHighlights = highlightIds
    if arguments.keys.contains("highlightIds") {
      highlightIds = TwinParse.strings(arguments["highlightIds"])
    }
    let highlightChanged = previousHighlights != highlightIds

    let previousSelection = selectedId
    if arguments.keys.contains("selectedId") {
      selectedId = TwinParse.string(arguments["selectedId"])
    }
    let selectionChanged = previousSelection != selectedId

    let previousVisible = visibleDeliveryIds
    if arguments.keys.contains("timelineVisibleIds") {
      visibleDeliveryIds = TwinParse.isNull(arguments["timelineVisibleIds"])
        ? nil
        : Set(TwinParse.strings(arguments["timelineVisibleIds"]))
    }
    let visibilityChanged = previousVisible != visibleDeliveryIds

    guard building != nil, layout != nil else { return }

    if buildingChanged || overridesChanged { rebuildAssets() }
    if buildingChanged || stateChanged { rebuildState() }
    if buildingChanged || stateChanged || explodedChanged { rebuildShafts() }
    if visibilityChanged, !(buildingChanged || stateChanged) { applyDeliveryVisibility() }
    if explodedChanged, !buildingChanged { animateFloors(duration: 0.65) }
    if buildingChanged || routeChanged || explodedChanged { rebuildRoute() }
    if buildingChanged || routeChanged || focusChanged { applyFloorOpacity(animated: !buildingChanged) }
    if buildingChanged || highlightChanged || selectionChanged || stateChanged { rebuildMarkers() }

    if buildingChanged {
      playIntro()
    } else if routeChanged, let route, route.reachable, focusFloorId == nil {
      frameRoute(route)
    } else if highlightChanged, !highlightIds.isEmpty {
      frameLocations(ids: highlightIds)
    } else if focusChanged {
      if let focusFloorId { frameFloor(focusFloorId) } else { frameAll(duration: 0.8) }
    } else if explodedChanged, focusFloorId == nil, route == nil {
      frameAll(duration: 0.8)
    }
  }

  private func setRenderingActive(_ active: Bool) {
    guard !disposed else { return }
    sceneView.isPlaying = active
    scene.isPaused = !active
  }

  private func dispose() {
    guard !disposed else { return }
    disposed = true
    channel.setMethodCallHandler(nil)
    sceneView.removeGestureRecognizer(tapRecognizer)
    sceneView.isPlaying = false
    scene.isPaused = true
    clearWorld()
    gridNode.childNodes.forEach { $0.removeFromParentNode() }
    sceneView.scene = nil
    materials.removeAll()
    unitBoxes.removeAll()
  }

  // MARK: - Building

  private func clearWorld() {
    worldNode.enumerateHierarchy { node, _ in node.removeAllActions() }
    worldNode.childNodes.forEach { $0.removeFromParentNode() }
    connectorLayer.childNodes.forEach { $0.removeFromParentNode() }
    shaftLayer.childNodes.forEach { $0.removeFromParentNode() }
    floorNodes.removeAll()
    assetLayers.removeAll()
    stateLayers.removeAll()
    routeLayers.removeAll()
    markerLayers.removeAll()
    deliveryNodes.removeAll()
  }

  private func loadBuilding(_ raw: [String: Any]) throws {
    let building = try TwinBuilding(dictionary: raw)
    let layout = TwinLayout(building: building)
    clearWorld()
    self.building = building
    self.layout = layout

    scene.fogStartDistance = CGFloat(layout.extent * 2.2)
    scene.fogEndDistance = CGFloat(layout.extent * 9)
    cameraNode.camera?.zFar = max(2000, layout.extent * 30)
    buildGrid(layout)

    let spacesByFloor = Dictionary(grouping: building.spaces, by: \.floorId)
    for floorLayout in layout.floors {
      let floorId = floorLayout.floor.id
      let floorNode = SCNNode()
      floorNode.name = "floor:\(floorId)"
      floorNode.position = SCNVector3(0, Float(layout.stackY(floorLayout, explode: exploded ? 1 : 0)), 0)
      for child in buildFloorStatic(floorLayout, spaces: spacesByFloor[floorId] ?? [], layout: layout) {
        floorNode.addChildNode(child)
      }
      assetLayers[floorId] = addLayer("assets", to: floorNode)
      stateLayers[floorId] = addLayer("state", to: floorNode)
      routeLayers[floorId] = addLayer("route", to: floorNode)
      markerLayers[floorId] = addLayer("markers", to: floorNode)
      worldNode.addChildNode(floorNode)
      floorNodes[floorId] = floorNode
    }
    worldNode.addChildNode(shaftLayer)
    worldNode.addChildNode(connectorLayer)
  }

  private func addLayer(_ name: String, to floorNode: SCNNode) -> SCNNode {
    let layer = SCNNode()
    layer.name = name
    floorNode.addChildNode(layer)
    return layer
  }

  private func buildFloorStatic(_ floor: TwinFloorLayout, spaces: [TwinSpace], layout: TwinLayout) -> [SCNNode] {
    var nodes: [SCNNode] = []

    let corners = [
      layout.toWorld(TwinPoint(x: floor.bbox.minX - 1.2, y: floor.bbox.minY - 1.2)),
      layout.toWorld(TwinPoint(x: floor.bbox.maxX + 1.2, y: floor.bbox.minY - 1.2)),
      layout.toWorld(TwinPoint(x: floor.bbox.maxX + 1.2, y: floor.bbox.maxY + 1.2)),
      layout.toWorld(TwinPoint(x: floor.bbox.minX - 1.2, y: floor.bbox.maxY + 1.2)),
    ]
    let plate = SCNBox(
      width: CGFloat(floor.bbox.width + 2.4),
      height: 0.04,
      length: CGFloat(floor.bbox.height + 2.4),
      chamferRadius: 0
    )
    plate.materials = [litMaterial("#0B1430", alpha: 0.6, emission: 0.05)]
    let plateNode = SCNNode(geometry: plate)
    let plateCenter = layout.toWorld(floor.bbox.center)
    plateNode.position = SCNVector3(Float(plateCenter.x), -0.03, Float(plateCenter.z))
    nodes.append(plateNode)
    var plateEdges: [(SCNVector3, SCNVector3)] = []
    for index in corners.indices {
      let a = corners[index]
      let b = corners[(index + 1) % corners.count]
      plateEdges.append((SCNVector3(Float(a.x), 0, Float(a.z)), SCNVector3(Float(b.x), 0, Float(b.z))))
    }
    nodes.append(SCNNode(geometry: lineGeometry(plateEdges, material: glowMaterial("#7DD3FC", alpha: 0.95, intensity: 1.5))))

    let slabs = SCNNode()
    var wallVertices: [SCNVector3] = []
    var wallIndices: [UInt32] = []
    var topEdges: [(SCNVector3, SCNVector3)] = []
    var floorEdges: [(SCNVector3, SCNVector3)] = []
    let wallHeight = Float(floor.wallHeight)
    for space in spaces {
      let path = UIBezierPath()
      for (index, point) in space.polygon.enumerated() {
        let local = CGPoint(x: point.x - layout.center.x, y: point.y - layout.center.y)
        if index == 0 { path.move(to: local) } else { path.addLine(to: local) }
      }
      path.close()
      let shape = SCNShape(path: path, extrusionDepth: CGFloat(Style.slabTop))
      shape.materials = [litMaterial(TwinPalette.roomColor(roomType: space.roomType, type: space.type), alpha: 0.82, emission: 0.18)]
      let slab = SCNNode(geometry: shape)
      slab.eulerAngles.x = -.pi / 2
      slab.position.y = Style.slabTop / 2
      slabs.addChildNode(slab)

      guard space.type != "corridor" else { continue }
      for index in space.polygon.indices {
        let a = layout.toWorld(space.polygon[index])
        let b = layout.toWorld(space.polygon[(index + 1) % space.polygon.count])
        let base = UInt32(wallVertices.count)
        wallVertices.append(contentsOf: [
          SCNVector3(Float(a.x), Style.slabTop, Float(a.z)),
          SCNVector3(Float(b.x), Style.slabTop, Float(b.z)),
          SCNVector3(Float(b.x), wallHeight, Float(b.z)),
          SCNVector3(Float(a.x), wallHeight, Float(a.z)),
        ])
        wallIndices.append(contentsOf: [base, base + 1, base + 2, base, base + 2, base + 3])
        topEdges.append((SCNVector3(Float(a.x), wallHeight, Float(a.z)), SCNVector3(Float(b.x), wallHeight, Float(b.z))))
        floorEdges.append((SCNVector3(Float(a.x), Style.slabTop + 0.01, Float(a.z)), SCNVector3(Float(b.x), Style.slabTop + 0.01, Float(b.z))))
      }
    }
    let flatSlabs = slabs.flattenedClone()
    flatSlabs.name = "slabs"
    flatSlabs.categoryBitMask = HitMask.selectable
    nodes.append(flatSlabs)

    if !wallIndices.isEmpty {
      let walls = SCNGeometry(
        sources: [SCNGeometrySource(vertices: wallVertices)],
        elements: [SCNGeometryElement(indices: wallIndices, primitiveType: .triangles)]
      )
      let wallMaterial = glowMaterial("#A9BDE6", alpha: 0.1, intensity: 0.35)
      wallMaterial.isDoubleSided = true
      wallMaterial.writesToDepthBuffer = false
      walls.materials = [wallMaterial]
      let wallNode = SCNNode(geometry: walls)
      wallNode.renderingOrder = 10
      nodes.append(wallNode)
      nodes.append(SCNNode(geometry: lineGeometry(topEdges, material: glowMaterial("#7DD3FC", alpha: 0.55, intensity: 0.9))))
      nodes.append(SCNNode(geometry: lineGeometry(floorEdges, material: glowMaterial("#7DD3FC", alpha: 0.3, intensity: 0.6))))
    }
    return nodes
  }

  private func buildGrid(_ layout: TwinLayout) {
    gridNode.childNodes.forEach { $0.removeFromParentNode() }
    let cell = layout.extent > 120 ? 5.0 : 1.0
    let half = (layout.extent * 2 / (cell * 10)).rounded(.up) * cell * 10
    let count = Int(half / cell)
    var cellLines: [(SCNVector3, SCNVector3)] = []
    var sectionLines: [(SCNVector3, SCNVector3)] = []
    for index in -count...count {
      let value = Float(Double(index) * cell)
      let extent = Float(half)
      let lines = [
        (SCNVector3(-extent, 0, value), SCNVector3(extent, 0, value)),
        (SCNVector3(value, 0, -extent), SCNVector3(value, 0, extent)),
      ]
      if index % 10 == 0 { sectionLines.append(contentsOf: lines) } else { cellLines.append(contentsOf: lines) }
    }
    gridNode.addChildNode(SCNNode(geometry: lineGeometry(cellLines, material: glowMaterial("#13213D", alpha: 0.9, intensity: 0.6))))
    gridNode.addChildNode(SCNNode(geometry: lineGeometry(sectionLines, material: glowMaterial("#1E3A6A", alpha: 0.9, intensity: 0.8))))
    gridNode.position = SCNVector3(0, Float(layout.minimumY(exploded: exploded) - 0.4), 0)
  }

  private func rebuildAssets() {
    guard let building, let layout else { return }
    for layer in assetLayers.values {
      layer.childNodes.forEach { $0.removeFromParentNode() }
    }
    var containers: [String: SCNNode] = [:]
    for asset in building.assets {
      let override = twinState.overrides[asset.id]
      let floorId = override?.floorId ?? asset.floorId
      guard assetLayers[floorId] != nil else { continue }
      let footprint = asset.footprint ?? TwinFootprint(width: 0.5, depth: 0.5, rotation: 0)
      let height = TwinPalette.assetHeight(category: asset.category, type: asset.type)
      let world = layout.toWorld(override?.position ?? asset.position)
      let node = SCNNode(geometry: unitBox(TwinPalette.assetColor(category: asset.category, type: asset.type)))
      node.position = SCNVector3(Float(world.x), Style.slabTop + Float(height / 2), Float(world.z))
      node.scale = SCNVector3(Float(max(0.1, footprint.width)), Float(height), Float(max(0.1, footprint.depth)))
      node.eulerAngles.y = Float(footprint.rotation * .pi / 180)
      let container = containers[floorId] ?? SCNNode()
      container.addChildNode(node)
      containers[floorId] = container
    }
    for (floorId, container) in containers {
      let flat = container.flattenedClone()
      flat.name = "assets"
      flat.categoryBitMask = HitMask.selectable
      assetLayers[floorId]?.addChildNode(flat)
    }
  }

  // MARK: - Live state

  private func rebuildState() {
    guard let building, let layout else { return }
    for layer in stateLayers.values {
      layer.enumerateHierarchy { node, _ in node.removeAllActions() }
      layer.childNodes.forEach { $0.removeFromParentNode() }
    }
    deliveryNodes.removeAll()

    for id in twinState.closed {
      if let opening = building.openings.first(where: { $0.id == id }) ?? twinState.addedOpenings.first(where: { $0.id == id }) {
        stateLayers[opening.floorId]?.addChildNode(openingBar(opening, id: "closed:\(id)", layout: layout, building: building))
        continue
      }
      // Closed lifts and stairs are shown by their shaft turning red (rebuildShafts).
      if let connector = building.connectors.first(where: { $0.id == id }), connectorStops(connector).count >= 2 {
        continue
      }
      for location in building.locations(for: id, state: twinState) {
        stateLayers[location.floorId]?.addChildNode(closedMarker(location, id: id, layout: layout))
      }
    }

    for delivery in twinState.deliveries {
      guard let layer = stateLayers[delivery.floorId] else { continue }
      let dims = delivery.dimensions
      let crate = SCNBox(
        width: CGFloat(max(0.1, dims.width)),
        height: CGFloat(max(0.1, dims.height)),
        length: CGFloat(max(0.1, dims.depth)),
        chamferRadius: 0.03
      )
      let statusColor = delivery.status == "ok" ? TwinPalette.ok : delivery.status == "blocked" ? TwinPalette.danger : TwinPalette.warning
      crate.materials = [litMaterial("#C99A63", alpha: 1, emission: 0.22)]
      let node = SCNNode(geometry: crate)
      node.name = "delivery:\(delivery.id)"
      node.categoryBitMask = HitMask.selectable
      let world = layout.toWorld(delivery.position)
      node.position = SCNVector3(Float(world.x), Style.slabTop + Float(max(0.1, dims.height) / 2), Float(world.z))
      node.eulerAngles.y = Float(delivery.rotation * .pi / 180)

      let ring = SCNTorus(ringRadius: CGFloat(max(dims.width, dims.depth) * 0.75 + 0.2), pipeRadius: 0.035)
      ring.materials = [glowMaterial(statusColor, alpha: 1, intensity: 1.8)]
      let ringNode = SCNNode(geometry: ring)
      ringNode.position = SCNVector3(0, -Float(max(0.1, dims.height) / 2) + 0.03, 0)
      node.addChildNode(ringNode)

      layer.addChildNode(node)
      deliveryNodes[delivery.id] = node
    }
    applyDeliveryVisibility()
  }

  /// Stops of a lift or staircase, ordered bottom to top: floor plus anchor point of its space on that floor.
  private func connectorStops(_ connector: TwinConnector) -> [(floor: TwinFloorLayout, point: TwinPoint)] {
    guard let building, let layout else { return [] }
    var stops: [(floor: TwinFloorLayout, point: TwinPoint)] = []
    for (index, floorId) in connector.floorIds.enumerated() where index < connector.spaceIds.count {
      guard let floor = layout.byId[floorId],
            let space = building.spaces.first(where: { $0.id == connector.spaceIds[index] }) else { continue }
      stops.append((floor, TwinGeometry.interiorPoint(space.polygon)))
    }
    return stops.sorted { $0.floor.index < $1.floor.index }
  }

  /// Lifts and stairs as glowing glass shafts between consecutive stops; red and pulsing when closed.
  private func rebuildShafts() {
    guard let building, let layout else { return }
    shaftLayer.enumerateHierarchy { node, _ in node.removeAllActions() }
    shaftLayer.childNodes.forEach { $0.removeFromParentNode() }
    for connector in building.connectors {
      let stops = connectorStops(connector)
      guard stops.count >= 2 else { continue }
      let isLift = connector.kind == "lift"
      let closed = twinState.closed.contains(connector.id)
      let color = closed ? TwinPalette.danger : isLift ? TwinPalette.violet : TwinPalette.cyan
      for index in 0..<(stops.count - 1) {
        let lower = stops[index]
        let upper = stops[index + 1]
        let world = layout.toWorld(lower.point)
        let bottom = Float(layout.targetY(lower.floor.floor.id, exploded: exploded))
        let height = max(0.2, Float(layout.targetY(upper.floor.floor.id, exploded: exploded)) - bottom + 0.4)

        let shell: SCNGeometry = isLift
          ? SCNBox(width: 1.6, height: CGFloat(height), length: 1.6, chamferRadius: 0.05)
          : SCNCylinder(radius: 0.7, height: CGFloat(height))
        let glass = glowMaterial(color, alpha: closed ? 0.42 : 0.28, intensity: closed ? 1.4 : 0.7)
        glass.isDoubleSided = true
        shell.materials = [glass]
        let shaft = SCNNode(geometry: shell)
        shaft.name = "connector:\(connector.id)"
        shaft.categoryBitMask = HitMask.selectable
        shaft.renderingOrder = 12
        shaft.position = SCNVector3(Float(world.x), bottom + height / 2, Float(world.z))

        let core = SCNCylinder(radius: 0.07, height: CGFloat(height))
        core.radialSegmentCount = 8
        core.materials = [glowMaterial(color, alpha: 1, intensity: closed ? 3 : 2.4)]
        shaft.addChildNode(SCNNode(geometry: core))

        if closed { pulse(shaft) }
        shaftLayer.addChildNode(shaft)
      }
    }
  }

  private func applyDeliveryVisibility() {
    for (id, node) in deliveryNodes {
      node.isHidden = visibleDeliveryIds.map { !$0.contains(id) } ?? false
    }
  }

  private func openingBar(_ opening: TwinOpening, id: String, layout: TwinLayout, building: TwinBuilding) -> SCNNode {
    let bar = SCNBox(width: CGFloat(max(0.6, opening.width)), height: 2.2, length: 0.16, chamferRadius: 0.02)
    bar.materials = [glowMaterial(TwinPalette.danger, alpha: 0.9, intensity: 1.8)]
    let node = SCNNode(geometry: bar)
    node.name = id
    node.categoryBitMask = HitMask.selectable
    let world = layout.toWorld(opening.position)
    node.position = SCNVector3(Float(world.x), Style.slabTop + 1.1, Float(world.z))
    node.eulerAngles.y = Float(TwinGeometry.openingWallAngle(building: building, opening: opening))
    pulse(node)
    return node
  }

  private func closedMarker(_ location: TwinLocation, id: String, layout: TwinLayout) -> SCNNode {
    let world = layout.toWorld(location.point)
    let node = SCNNode()
    node.name = "closed:\(id)"
    node.categoryBitMask = HitMask.selectable
    node.position = SCNVector3(Float(world.x), Style.slabTop, Float(world.z))
    let column = SCNCylinder(radius: CGFloat(min(1.4, max(0.5, location.radius * 0.45))), height: 2.4)
    column.materials = [glowMaterial(TwinPalette.danger, alpha: 0.28, intensity: 1.2)]
    let columnNode = SCNNode(geometry: column)
    columnNode.position.y = 1.2
    columnNode.categoryBitMask = HitMask.selectable
    node.addChildNode(columnNode)
    let ring = SCNTorus(ringRadius: CGFloat(min(1.6, max(0.7, location.radius * 0.55))), pipeRadius: 0.06)
    ring.materials = [glowMaterial(TwinPalette.danger, alpha: 1, intensity: 2)]
    node.addChildNode(SCNNode(geometry: ring))
    pulse(node)
    return node
  }

  // MARK: - Route

  private func rebuildRoute() {
    guard let layout else { return }
    for layer in routeLayers.values {
      layer.enumerateHierarchy { node, _ in node.removeAllActions() }
      layer.childNodes.forEach { $0.removeFromParentNode() }
    }
    connectorLayer.childNodes.forEach { $0.removeFromParentNode() }
    guard let route else { return }

    let lineMaterial = glowMaterial(TwinPalette.cyan, alpha: 1, intensity: 2.2)
    let jointGeometry = SCNSphere(radius: 0.13)
    jointGeometry.segmentCount = 12
    jointGeometry.materials = [lineMaterial]
    for segment in route.floors {
      guard let layer = routeLayers[segment.floorId], !segment.points.isEmpty else { continue }
      let points = segment.points.map { point -> SCNVector3 in
        let world = layout.toWorld(point)
        return SCNVector3(Float(world.x), Style.routeHeight, Float(world.z))
      }
      for index in 0..<(points.count - 1) {
        if let node = cylinder(from: points[index], to: points[index + 1], radius: 0.11, material: lineMaterial) {
          layer.addChildNode(node)
        }
      }
      for point in points {
        let joint = SCNNode(geometry: jointGeometry)
        joint.position = point
        layer.addChildNode(joint)
      }
      if route.reachable, points.count >= 2 {
        layer.addChildNode(routeHead(along: points))
      }
    }

    let hopMaterial = glowMaterial(TwinPalette.violet, alpha: 1, intensity: 2)
    for connector in route.connectors {
      let world = layout.toWorld(connector.position)
      let from = SCNVector3(Float(world.x), Float(layout.targetY(connector.fromFloorId, exploded: exploded)) + Style.routeHeight, Float(world.z))
      let to = SCNVector3(Float(world.x), Float(layout.targetY(connector.toFloorId, exploded: exploded)) + Style.routeHeight, Float(world.z))
      if let node = cylinder(from: from, to: to, radius: 0.14, material: hopMaterial) {
        connectorLayer.addChildNode(node)
      }
    }

    guard let building else { return }
    for blocking in route.blockingOpenings {
      let opening = building.openings.first(where: { $0.id == blocking.id })
        ?? TwinOpening(dictionary: ["id": blocking.id, "floor_id": blocking.floorId, "position": [blocking.position.x, blocking.position.y], "width_m": blocking.width])
      if let opening {
        routeLayers[blocking.floorId]?.addChildNode(openingBar(opening, id: "closed:\(blocking.id)", layout: layout, building: building))
      }
    }
  }

  private func routeHead(along points: [SCNVector3]) -> SCNNode {
    let sphere = SCNSphere(radius: 0.3)
    sphere.materials = [glowMaterial("#E0F2FE", alpha: 1, intensity: 3)]
    let head = SCNNode(geometry: sphere)
    guard !reduceMotion else {
      head.position = points[points.count - 1]
      return head
    }
    head.position = points[0]
    var actions: [SCNAction] = []
    for index in 1..<points.count {
      let a = points[index - 1]
      let b = points[index]
      let distance = Double(simd_distance(SIMD3<Float>(a.x, a.y, a.z), SIMD3<Float>(b.x, b.y, b.z)))
      actions.append(.move(to: b, duration: max(0.04, distance / 6)))
    }
    actions.append(.fadeOut(duration: 0.2))
    actions.append(.move(to: points[0], duration: 0))
    actions.append(.fadeIn(duration: 0.2))
    head.runAction(.repeatForever(.sequence(actions)))
    return head
  }

  // MARK: - Highlight and selection

  private func rebuildMarkers() {
    guard let building, let layout else { return }
    for layer in markerLayers.values {
      layer.enumerateHierarchy { node, _ in node.removeAllActions() }
      layer.childNodes.forEach { $0.removeFromParentNode() }
    }
    for id in highlightIds {
      for location in building.locations(for: id, state: twinState) {
        markerLayers[location.floorId]?.addChildNode(marker(location, color: TwinPalette.violet, emphasized: true, layout: layout))
      }
    }
    if let selectedId, !highlightIds.contains(selectedId) {
      for location in building.locations(for: selectedId, state: twinState) {
        markerLayers[location.floorId]?.addChildNode(marker(location, color: TwinPalette.cyan, emphasized: false, layout: layout))
      }
    }
  }

  private func marker(_ location: TwinLocation, color: String, emphasized: Bool, layout: TwinLayout) -> SCNNode {
    let world = layout.toWorld(location.point)
    let node = SCNNode()
    node.position = SCNVector3(Float(world.x), Style.slabTop + 0.15, Float(world.z))
    let ring = SCNTorus(ringRadius: CGFloat(max(0.8, location.radius)), pipeRadius: emphasized ? 0.08 : 0.06)
    ring.materials = [glowMaterial(color, alpha: 1, intensity: 2.4)]
    node.addChildNode(SCNNode(geometry: ring))
    if emphasized {
      let beam = SCNCylinder(radius: 0.05, height: 8)
      beam.materials = [glowMaterial(color, alpha: 0.55, intensity: 1.6)]
      let beamNode = SCNNode(geometry: beam)
      beamNode.position.y = 4
      node.addChildNode(beamNode)
      if !reduceMotion {
        let grow = SCNAction.group([.scale(to: 1.18, duration: 0.8), .fadeOpacity(to: 0.55, duration: 0.8)])
        let shrink = SCNAction.group([.scale(to: 1, duration: 0.8), .fadeOpacity(to: 1, duration: 0.8)])
        grow.timingMode = .easeInEaseOut
        shrink.timingMode = .easeInEaseOut
        node.runAction(.repeatForever(.sequence([grow, shrink])))
      }
    }
    return node
  }

  // MARK: - Floors and camera

  private func animateFloors(duration: Double) {
    guard let layout else { return }
    SCNTransaction.begin()
    SCNTransaction.animationDuration = reduceMotion ? 0 : duration
    SCNTransaction.animationTimingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    for floorLayout in layout.floors {
      guard let node = floorNodes[floorLayout.floor.id] else { continue }
      var position = node.position
      position.y = Float(layout.stackY(floorLayout, explode: exploded ? 1 : 0))
      node.position = position
    }
    gridNode.position = SCNVector3(0, Float(layout.minimumY(exploded: exploded) - 0.4), 0)
    SCNTransaction.commit()
  }

  private func applyFloorOpacity(animated: Bool) {
    let routeFloors: Set<String>? = route.flatMap { $0.reachable ? Set($0.floors.map(\.floorId)) : nil }
    SCNTransaction.begin()
    SCNTransaction.animationDuration = animated && !reduceMotion ? 0.35 : 0
    for (id, node) in floorNodes {
      if let focusFloorId {
        node.opacity = id == focusFloorId ? 1 : 0.1
      } else if let routeFloors {
        node.opacity = routeFloors.contains(id) ? 1 : 0.3
      } else {
        node.opacity = 1
      }
    }
    shaftLayer.opacity = focusFloorId == nil ? 1 : 0.25
    SCNTransaction.commit()
  }

  private func playIntro() {
    guard let layout else { return }
    guard !reduceMotion else {
      frameAll(duration: 0)
      return
    }
    frame(allFloorsBox(), distanceScale: 2.4, polarDegrees: 74, azimuthDegrees: -20, duration: 0)
    shaftLayer.opacity = 0
    shaftLayer.runAction(.sequence([
      .wait(duration: 0.6 + Double(layout.floors.count) * 0.18),
      .fadeIn(duration: 0.5),
    ]))
    for floorLayout in layout.floors {
      guard let node = floorNodes[floorLayout.floor.id] else { continue }
      let target = node.position
      node.position = SCNVector3(target.x, target.y - 10, target.z)
      node.opacity = 0
      let rise = SCNAction.move(to: target, duration: 0.9)
      rise.timingMode = .easeOut
      node.runAction(.sequence([
        .wait(duration: 0.15 + Double(floorLayout.index) * 0.18),
        .group([rise, .fadeIn(duration: 0.6)]),
      ]))
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
      guard let self, !self.disposed else { return }
      self.frameAll(duration: 1.6)
    }
    let introEnd = 0.9 + Double(layout.floors.count) * 0.18
    DispatchQueue.main.asyncAfter(deadline: .now() + introEnd) { [weak self] in
      guard let self, !self.disposed else { return }
      self.applyFloorOpacity(animated: true)
    }
  }

  private func frameAll(duration: Double) {
    frame(allFloorsBox(), duration: duration)
  }

  private func frameFloor(_ floorId: String) {
    guard let layout, let floor = layout.byId[floorId] else { return }
    frame(floorBox(floor, layout: layout), polarDegrees: 44, duration: 0.8)
  }

  private func frameRoute(_ route: TwinRoute) {
    guard let layout else { return }
    var points: [SIMD3<Float>] = []
    for segment in route.floors {
      let y = Float(layout.targetY(segment.floorId, exploded: exploded))
      for point in segment.points {
        let world = layout.toWorld(point)
        points.append(SIMD3<Float>(Float(world.x), y, Float(world.z)))
      }
    }
    guard let box = bounds(points, padding: 3) else { return }
    frame(box, polarDegrees: 54, duration: 0.9)
  }

  private func frameLocations(ids: [String]) {
    guard let building, let layout else { return }
    let locations = ids.flatMap { building.locations(for: $0, state: twinState) }
    let points = locations.map { location -> SIMD3<Float> in
      let world = layout.toWorld(location.point)
      return SIMD3<Float>(Float(world.x), Float(layout.targetY(location.floorId, exploded: exploded)), Float(world.z))
    }
    let largestRadius = locations.map { $0.radius }.max() ?? 1
    let padding = Float(max(9, largestRadius * 2))
    guard let box = bounds(points, padding: padding) else { return }
    frame(box, polarDegrees: 52, duration: 0.9)
  }

  private func allFloorsBox() -> (SIMD3<Float>, SIMD3<Float>) {
    guard let layout else { return (SIMD3<Float>(-10, 0, -10), SIMD3<Float>(10, 3, 10)) }
    var minimum = SIMD3<Float>(repeating: .greatestFiniteMagnitude)
    var maximum = SIMD3<Float>(repeating: -.greatestFiniteMagnitude)
    for floor in layout.floors {
      let box = floorBox(floor, layout: layout)
      minimum = simd_min(minimum, box.0)
      maximum = simd_max(maximum, box.1)
    }
    return (minimum, maximum)
  }

  private func floorBox(_ floor: TwinFloorLayout, layout: TwinLayout) -> (SIMD3<Float>, SIMD3<Float>) {
    let y = Float(layout.targetY(floor.floor.id, exploded: exploded))
    let a = layout.toWorld(TwinPoint(x: floor.bbox.minX, y: floor.bbox.maxY))
    let b = layout.toWorld(TwinPoint(x: floor.bbox.maxX, y: floor.bbox.minY))
    return (
      SIMD3<Float>(Float(min(a.x, b.x)), y, Float(min(a.z, b.z))),
      SIMD3<Float>(Float(max(a.x, b.x)), y + Float(floor.wallHeight), Float(max(a.z, b.z)))
    )
  }

  private func bounds(_ points: [SIMD3<Float>], padding: Float) -> (SIMD3<Float>, SIMD3<Float>)? {
    guard var minimum = points.first else { return nil }
    var maximum = minimum
    for point in points.dropFirst() {
      minimum = simd_min(minimum, point)
      maximum = simd_max(maximum, point)
    }
    return (minimum - SIMD3<Float>(repeating: padding), maximum + SIMD3<Float>(repeating: padding))
  }

  private func frame(
    _ box: (SIMD3<Float>, SIMD3<Float>),
    distanceScale: Float = 1,
    polarDegrees: Float = 60,
    azimuthDegrees: Float = 32,
    duration: Double
  ) {
    guard let camera = cameraNode.camera else { return }
    let center = (box.0 + box.1) / 2
    let radius = max(4, simd_length(box.1 - box.0) / 2)
    let verticalFov = Float(camera.fieldOfView) * .pi / 180
    let bounds = sceneView.bounds.size
    let aspect = Float(max(1, bounds.width) / max(1, bounds.height))
    let horizontalFov = 2 * atan(tan(verticalFov / 2) * aspect)
    // Flutter overlays cover roughly the top and bottom fifth of the screen.
    let distance = radius / sin(min(verticalFov, horizontalFov) / 2) * 1.2 * distanceScale
    let polar = polarDegrees * .pi / 180
    let azimuth = azimuthDegrees * .pi / 180
    let offset = SIMD3<Float>(sin(polar) * sin(azimuth), cos(polar), sin(polar) * cos(azimuth)) * distance
    SCNTransaction.begin()
    SCNTransaction.animationDuration = reduceMotion ? 0 : duration
    SCNTransaction.animationTimingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    cameraNode.simdPosition = center + offset
    cameraNode.simdLook(at: center)
    sceneView.defaultCameraController.target = SCNVector3(center.x, center.y, center.z)
    SCNTransaction.commit()
  }

  // MARK: - Hit testing

  @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended, !disposed else { return }
    let point = recognizer.location(in: sceneView)
    let results = sceneView.hitTest(point, options: [
      .categoryBitMask: HitMask.selectable,
      .searchMode: SCNHitTestSearchMode.closest.rawValue,
      .ignoreHiddenNodes: true,
    ])
    channel.invokeMethod("entityTapped", arguments: results.first.flatMap(entityId(for:)) ?? "")
  }

  private func entityId(for result: SCNHitTestResult) -> String? {
    var node: SCNNode? = result.node
    var layerName: String?
    var floorId: String?
    while let current = node {
      if let name = current.name {
        if name.hasPrefix("delivery:") { return String(name.dropFirst("delivery:".count)) }
        if name.hasPrefix("closed:") { return String(name.dropFirst("closed:".count)) }
        if name.hasPrefix("connector:") { return String(name.dropFirst("connector:".count)) }
        if name.hasPrefix("floor:") {
          floorId = String(name.dropFirst("floor:".count))
          break
        }
        if layerName == nil { layerName = name }
      }
      node = current.parent
    }
    guard let floorId, let floorNode = floorNodes[floorId], let layout else { return nil }
    let local = floorNode.convertPosition(result.worldCoordinates, from: nil)
    let point = TwinPoint(x: Double(local.x) + layout.center.x, y: -Double(local.z) + layout.center.y)
    if layerName == "assets", let id = assetId(at: point, floorId: floorId) { return id }
    return spaceId(at: point, floorId: floorId)
  }

  private func assetId(at point: TwinPoint, floorId: String) -> String? {
    guard let building else { return nil }
    var best: (id: String, score: Double)?
    for asset in building.assets {
      let override = twinState.overrides[asset.id]
      guard (override?.floorId ?? asset.floorId) == floorId else { continue }
      let center = override?.position ?? asset.position
      let footprint = asset.footprint ?? TwinFootprint(width: 0.5, depth: 0.5, rotation: 0)
      let angle = footprint.rotation * .pi / 180
      let dx = point.x - center.x
      let dy = point.y - center.y
      let localX = dx * cos(angle) + dy * sin(angle)
      let localY = -dx * sin(angle) + dy * cos(angle)
      let inside = abs(localX) <= footprint.width / 2 + 0.25 && abs(localY) <= footprint.depth / 2 + 0.25
      let distance = hypot(dx, dy)
      guard inside || distance < 1.2 else { continue }
      let score = inside ? footprint.width * footprint.depth : 100 + distance
      if best == nil || score < best!.score { best = (asset.id, score) }
    }
    return best?.id
  }

  private func spaceId(at point: TwinPoint, floorId: String) -> String? {
    guard let building else { return nil }
    var best: (id: String, area: Double)?
    for space in building.spaces where space.floorId == floorId && TwinGeometry.pointInPolygon(point, space.polygon) {
      let area = abs(TwinGeometry.polygonArea(space.polygon))
      if best == nil || area < best!.area { best = (space.id, area) }
    }
    return best?.id
  }

  // MARK: - Geometry helpers

  private func pulse(_ node: SCNNode) {
    guard !reduceMotion else { return }
    let dim = SCNAction.fadeOpacity(to: 0.45, duration: 0.7)
    let bright = SCNAction.fadeOpacity(to: 1, duration: 0.7)
    dim.timingMode = .easeInEaseOut
    bright.timingMode = .easeInEaseOut
    node.runAction(.repeatForever(.sequence([dim, bright])))
  }

  private func cylinder(from a: SCNVector3, to b: SCNVector3, radius: CGFloat, material: SCNMaterial) -> SCNNode? {
    let start = SIMD3<Float>(a.x, a.y, a.z)
    let end = SIMD3<Float>(b.x, b.y, b.z)
    let delta = end - start
    let length = simd_length(delta)
    guard length > 0.001 else { return nil }
    let geometry = SCNCylinder(radius: radius, height: CGFloat(length))
    geometry.radialSegmentCount = 12
    geometry.materials = [material]
    let node = SCNNode(geometry: geometry)
    node.simdPosition = (start + end) / 2
    let direction = delta / length
    node.simdOrientation = direction.y < -0.9999
      ? simd_quatf(angle: .pi, axis: SIMD3<Float>(1, 0, 0))
      : simd_quatf(from: SIMD3<Float>(0, 1, 0), to: direction)
    return node
  }

  private func lineGeometry(_ segments: [(SCNVector3, SCNVector3)], material: SCNMaterial) -> SCNGeometry {
    var vertices: [SCNVector3] = []
    vertices.reserveCapacity(segments.count * 2)
    for segment in segments {
      vertices.append(segment.0)
      vertices.append(segment.1)
    }
    let indices = (0..<UInt32(vertices.count)).map { $0 }
    let geometry = SCNGeometry(
      sources: [SCNGeometrySource(vertices: vertices)],
      elements: [SCNGeometryElement(indices: indices, primitiveType: .line)]
    )
    geometry.materials = [material]
    return geometry
  }

  private func unitBox(_ hex: String) -> SCNGeometry {
    if let box = unitBoxes[hex] { return box }
    let box = SCNBox(width: 1, height: 1, length: 1, chamferRadius: 0)
    box.materials = [litMaterial(hex, alpha: 1, emission: 0.16)]
    unitBoxes[hex] = box
    return box
  }

  private func litMaterial(_ hex: String, alpha: CGFloat, emission: CGFloat) -> SCNMaterial {
    let key = "lit|\(hex)|\(alpha)|\(emission)"
    if let material = materials[key] { return material }
    let color = UIColor(hex: hex)
    let material = SCNMaterial()
    material.lightingModel = .lambert
    material.diffuse.contents = color.withAlphaComponent(alpha)
    material.emission.contents = color
    material.emission.intensity = emission
    material.isDoubleSided = alpha < 1
    materials[key] = material
    return material
  }

  private func glowMaterial(_ hex: String, alpha: CGFloat, intensity: CGFloat) -> SCNMaterial {
    let key = "glow|\(hex)|\(alpha)|\(intensity)"
    if let material = materials[key] { return material }
    let color = UIColor(hex: hex)
    let material = SCNMaterial()
    material.lightingModel = .constant
    material.diffuse.contents = color.withAlphaComponent(alpha)
    material.emission.contents = color
    material.emission.intensity = intensity
    material.transparency = alpha
    if alpha < 1 {
      material.blendMode = .alpha
      material.writesToDepthBuffer = false
    }
    materials[key] = material
    return material
  }
}

private extension UIColor {
  convenience init(hex: String, alpha: CGFloat = 1) {
    var value: UInt64 = 0
    Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
    self.init(
      red: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: alpha
    )
  }
}
