/// Typed DTOs for the SiteTwin REST and WebSocket APIs.
///
/// The backend is intentionally forwards-compatible: unknown enum values are
/// kept as strings, missing optional values become null, and malformed list or
/// scalar values fall back to safe values instead of crashing a screen.
library;

Map<String, dynamic> _map(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return value.map((key, value) => MapEntry(key.toString(), value));
  }
  return <String, dynamic>{};
}

List<Object?> _list(Object? value) {
  if (value is List) return value;
  if (value is Iterable && value is! String) return value.toList();
  return const <Object?>[];
}

List<Map<String, dynamic>> _mapList(Object? value) => [
  for (final item in _list(value))
    if (item is Map) _map(item),
];

String _string(Object? value, [String fallback = '']) {
  if (value is String) return value;
  if (value is num || value is bool) return value.toString();
  return fallback;
}

String? _optionalString(Object? value) {
  if (value == null) return null;
  if (value is String) return value;
  if (value is num || value is bool) return value.toString();
  return null;
}

double _double(Object? value, [double fallback = 0]) {
  final number = switch (value) {
    num value => value.toDouble(),
    String value => double.tryParse(value.trim().replaceAll(',', '.')),
    _ => null,
  };
  return number != null && number.isFinite ? number : fallback;
}

double? _optionalDouble(Object? value) {
  if (value == null || value == '') return null;
  final number = _double(value, double.nan);
  return number.isFinite ? number : null;
}

int _int(Object? value, [int fallback = 0]) {
  if (value is int) return value;
  if (value is num && value.isFinite) return value.toInt();
  if (value is String) {
    return int.tryParse(value.trim()) ?? double.tryParse(value.trim())?.toInt() ?? fallback;
  }
  return fallback;
}

bool _bool(Object? value, [bool fallback = false]) {
  if (value is bool) return value;
  if (value is num) return value != 0;
  if (value is String) {
    switch (value.trim().toLowerCase()) {
      case 'true':
      case '1':
      case 'yes':
      case 'on':
        return true;
      case 'false':
      case '0':
      case 'no':
      case 'off':
        return false;
    }
  }
  return fallback;
}

List<String> _stringList(Object? value) => List.unmodifiable([
  for (final item in _list(value))
    if (item is String || item is num || item is bool) item.toString(),
]);

List<double>? _pointOrNull(Object? value) {
  final items = _list(value);
  if (items.length < 2) return null;
  return List.unmodifiable(<double>[_double(items[0]), _double(items[1])]);
}

List<double> _point(Object? value) => _pointOrNull(value) ?? List.unmodifiable(<double>[0, 0]);

List<List<double>> _points(Object? value) => List.unmodifiable([for (final item in _list(value)) ?_pointOrNull(item)]);

class Site {
  const Site({
    required this.id,
    required this.name,
    required this.lat,
    required this.lon,
    required this.source,
    required this.buildingId,
    required this.dataPath,
    required this.floors,
    required this.demoLocation,
    required this.kind,
  });

  factory Site.fromJson(Map<String, dynamic> json) => Site(
    id: _string(json['id']),
    name: _string(json['name']),
    lat: _double(json['lat']),
    lon: _double(json['lon']),
    source: _string(json['source']),
    buildingId: _string(json['building_id']),
    dataPath: _string(json['data_path']),
    floors: _int(json['floors']),
    demoLocation: _bool(json['demo_location']),
    kind: _string(json['kind'], 'other'),
  );

  final String id;
  final String name;
  final double lat;
  final double lon;
  final String source;
  final String buildingId;
  final String dataPath;
  final int floors;
  final bool demoLocation;
  final String kind;
}

class BuildingScale {
  const BuildingScale({required this.planWidthM, required this.planHeightM, required this.userSupplied});

  factory BuildingScale.fromJson(Map<String, dynamic> json) => BuildingScale(
    planWidthM: _double(json['plan_width_m']),
    planHeightM: _double(json['plan_height_m']),
    userSupplied: _bool(json['user_supplied']),
  );

  final double planWidthM;
  final double planHeightM;
  final bool userSupplied;
}

class BuildingMetadata {
  const BuildingMetadata({
    required this.id,
    required this.name,
    required this.source,
    required this.license,
    required this.attribution,
    required this.units,
    this.scale,
  });

  factory BuildingMetadata.fromJson(Map<String, dynamic> json) => BuildingMetadata(
    id: _string(json['id']),
    name: _string(json['name']),
    source: _string(json['source']),
    license: _string(json['license']),
    attribution: _string(json['attribution']),
    units: _string(json['units'], 'm'),
    scale: json['scale'] is Map ? BuildingScale.fromJson(_map(json['scale'])) : null,
  );

  final String id;
  final String name;
  final String source;
  final String license;
  final String attribution;
  final String units;
  final BuildingScale? scale;
}

class BuildingFloor {
  const BuildingFloor({
    required this.id,
    required this.level,
    required this.name,
    required this.elevationM,
    required this.heightM,
  });

  factory BuildingFloor.fromJson(Map<String, dynamic> json) => BuildingFloor(
    id: _string(json['id']),
    level: _int(json['level']),
    name: _string(json['name']),
    elevationM: _double(json['elevation_m']),
    heightM: _double(json['height_m']),
  );

  final String id;
  final int level;
  final String name;
  final double elevationM;
  final double heightM;

  String get displayName => name.isNotEmpty ? name : 'Level $level';
}

class BuildingSpace {
  const BuildingSpace({
    required this.id,
    required this.floorId,
    required this.type,
    required this.name,
    required this.polygon,
    this.roomType,
    this.ref,
    this.synthetic = false,
  });

  factory BuildingSpace.fromJson(Map<String, dynamic> json) => BuildingSpace(
    id: _string(json['id']),
    floorId: _string(json['floor_id']),
    type: _string(json['type']),
    roomType: _optionalString(json['room_type']),
    name: _string(json['name']),
    ref: _optionalString(json['ref']),
    polygon: _points(json['polygon']),
    synthetic: _bool(json['synthetic']),
  );

  final String id;
  final String floorId;
  final String type;
  final String? roomType;
  final String name;
  final String? ref;
  final List<List<double>> polygon;
  final bool synthetic;

  String get displayName {
    if (name.isNotEmpty) return name;
    if (ref != null && ref!.isNotEmpty) return ref!;
    return id;
  }
}

class BuildingOpening {
  const BuildingOpening({
    required this.id,
    required this.floorId,
    required this.spaceIds,
    required this.kind,
    required this.position,
    required this.widthM,
    required this.stepFree,
    this.synthetic = false,
  });

  factory BuildingOpening.fromJson(Map<String, dynamic> json) => BuildingOpening(
    id: _string(json['id']),
    floorId: _string(json['floor_id']),
    spaceIds: _stringList(json['space_ids']),
    kind: _string(json['kind']),
    position: _point(json['position']),
    widthM: _double(json['width_m']),
    stepFree: _bool(json['step_free'], true),
    synthetic: _bool(json['synthetic']),
  );

  final String id;
  final String floorId;
  final List<String> spaceIds;
  final String kind;
  final List<double> position;
  final double widthM;
  final bool stepFree;
  final bool synthetic;
}

class BuildingConnector {
  const BuildingConnector({
    required this.id,
    required this.kind,
    required this.name,
    required this.floorIds,
    required this.spaceIds,
    required this.stepFree,
    this.synthetic = false,
  });

  factory BuildingConnector.fromJson(Map<String, dynamic> json) => BuildingConnector(
    id: _string(json['id']),
    kind: _string(json['kind']),
    name: _string(json['name']),
    floorIds: _stringList(json['floor_ids']),
    spaceIds: _stringList(json['space_ids']),
    stepFree: _bool(json['step_free']),
    synthetic: _bool(json['synthetic']),
  );

  final String id;
  final String kind;
  final String name;
  final List<String> floorIds;
  final List<String> spaceIds;
  final bool stepFree;
  final bool synthetic;
}

class AssetFootprint {
  const AssetFootprint({required this.widthM, required this.depthM, required this.rotationDeg});

  factory AssetFootprint.fromJson(Map<String, dynamic> json) => AssetFootprint(
    widthM: _double(json['width_m']),
    depthM: _double(json['depth_m']),
    rotationDeg: _double(json['rotation_deg']),
  );

  final double widthM;
  final double depthM;
  final double rotationDeg;
}

class BuildingAsset {
  const BuildingAsset({
    required this.id,
    required this.name,
    required this.category,
    required this.type,
    required this.spaceId,
    required this.floorId,
    required this.position,
    this.footprint,
    this.source,
  });

  factory BuildingAsset.fromJson(Map<String, dynamic> json) => BuildingAsset(
    id: _string(json['id']),
    name: _string(json['name']),
    category: _string(json['category']),
    type: _string(json['type']),
    spaceId: _string(json['space_id']),
    floorId: _string(json['floor_id']),
    position: _point(json['position']),
    footprint: json['footprint'] is Map ? AssetFootprint.fromJson(_map(json['footprint'])) : null,
    source: _optionalString(json['source']),
  );

  final String id;
  final String name;
  final String category;
  final String type;
  final String spaceId;
  final String floorId;
  final List<double> position;
  final AssetFootprint? footprint;
  final String? source;

  String get displayName => name.isNotEmpty ? name : id;
}

class Building {
  const Building({
    required this.metadata,
    required this.floors,
    required this.spaces,
    required this.openings,
    required this.connectors,
    required this.assets,
    required this.raw,
  });

  factory Building.fromJson(Map<String, dynamic> json) => Building(
    metadata: BuildingMetadata.fromJson(_map(json['building'])),
    floors: List.unmodifiable(_mapList(json['floors']).map(BuildingFloor.fromJson)),
    spaces: List.unmodifiable(_mapList(json['spaces']).map(BuildingSpace.fromJson)),
    openings: List.unmodifiable(_mapList(json['openings']).map(BuildingOpening.fromJson)),
    connectors: List.unmodifiable(_mapList(json['vertical_connectors']).map(BuildingConnector.fromJson)),
    assets: List.unmodifiable(_mapList(json['assets']).map(BuildingAsset.fromJson)),
    raw: json,
  );

  final BuildingMetadata metadata;
  final List<BuildingFloor> floors;
  final List<BuildingSpace> spaces;
  final List<BuildingOpening> openings;
  final List<BuildingConnector> connectors;
  final List<BuildingAsset> assets;

  /// Original building.json, including fields not needed by Flutter.
  final Map<String, dynamic> raw;

  String get id => metadata.id;
  String get name => metadata.name;

  BuildingFloor? floorById(String id) {
    for (final floor in floors) {
      if (floor.id == id) return floor;
    }
    return null;
  }

  BuildingSpace? spaceById(String id) {
    for (final space in spaces) {
      if (space.id == id) return space;
    }
    return null;
  }
}

class AssetOverride {
  const AssetOverride({required this.position, required this.floorId, required this.spaceId});

  factory AssetOverride.fromJson(Map<String, dynamic> json) => AssetOverride(
    position: _point(json['position']),
    floorId: _string(json['floor_id']),
    spaceId: _string(json['space_id']),
  );

  final List<double> position;
  final String floorId;
  final String spaceId;
}

class Dimensions {
  const Dimensions({required this.w, required this.d, required this.h});

  factory Dimensions.fromJson(Map<String, dynamic> json) =>
      Dimensions(w: _double(json['w']), d: _double(json['d']), h: _double(json['h']));

  final double w;
  final double d;
  final double h;

  String get displayString =>
      '${w.toStringAsFixed(2)} × ${d.toStringAsFixed(2)} × '
      '${h.toStringAsFixed(2)} m';
}

class DeclaredDimensionCheck {
  const DeclaredDimensionCheck({required this.ok, required this.deviationM});

  factory DeclaredDimensionCheck.fromJson(Map<String, dynamic> json) =>
      DeclaredDimensionCheck(ok: _bool(json['ok']), deviationM: Dimensions.fromJson(_map(json['deviation_m'])));

  final bool ok;
  final Dimensions deviationM;
}

class RouteFloorSegment {
  const RouteFloorSegment({required this.floorId, required this.level, required this.elevationM, required this.points});

  factory RouteFloorSegment.fromJson(Map<String, dynamic> json) => RouteFloorSegment(
    floorId: _string(json['floor_id']),
    level: _int(json['level']),
    elevationM: _double(json['elevation_m']),
    points: _points(json['points']),
  );

  final String floorId;
  final int level;
  final double elevationM;
  final List<List<double>> points;
}

class RouteConnector {
  const RouteConnector({
    required this.id,
    required this.kind,
    required this.fromFloorId,
    required this.toFloorId,
    required this.position,
    required this.name,
  });

  factory RouteConnector.fromJson(Map<String, dynamic> json) => RouteConnector(
    id: _string(json['id']),
    kind: _string(json['kind']),
    fromFloorId: _string(json['from_floor_id']),
    toFloorId: _string(json['to_floor_id']),
    position: _point(json['position']),
    name: _string(json['name']),
  );

  final String id;
  final String kind;
  final String fromFloorId;
  final String toFloorId;
  final List<double> position;
  final String name;
}

class BlockingOpening {
  const BlockingOpening({
    required this.id,
    required this.widthM,
    required this.position,
    required this.floorId,
    this.label,
    this.reason,
  });

  factory BlockingOpening.fromJson(Map<String, dynamic> json) => BlockingOpening(
    id: _string(json['id']),
    widthM: _double(json['width_m']),
    position: _point(json['position']),
    floorId: _string(json['floor_id']),
    label: _optionalString(json['label']),
    reason: _optionalString(json['reason']),
  );

  final String id;
  final double widthM;
  final List<double> position;
  final String floorId;
  final String? label;
  final String? reason;
}

class RouteModel {
  const RouteModel({
    required this.reachable,
    required this.lengthM,
    required this.stepFree,
    required this.spacePath,
    required this.steps,
    required this.floors,
    required this.connectors,
    required this.blockingOpenings,
    required this.raw,
    this.fromSpaceId,
    this.toSpaceId,
    this.via = const <String>[],
    this.minWidthM,
    this.message,
  });

  factory RouteModel.fromJson(Map<String, dynamic> json) => RouteModel(
    fromSpaceId: _optionalString(json['from_space_id']),
    toSpaceId: _optionalString(json['to_space_id']),
    via: _stringList(json['via']),
    message: _optionalString(json['message']),
    reachable: _bool(json['reachable']),
    lengthM: _double(json['length_m']),
    stepFree: _bool(json['step_free']),
    minWidthM: _optionalDouble(json['min_width_m']),
    spacePath: _stringList(json['space_path']),
    steps: _stringList(json['steps']),
    floors: List.unmodifiable(_mapList(json['floors']).map(RouteFloorSegment.fromJson)),
    connectors: List.unmodifiable(_mapList(json['connectors']).map(RouteConnector.fromJson)),
    blockingOpenings: List.unmodifiable(_mapList(json['blocking_openings']).map(BlockingOpening.fromJson)),
    raw: json,
  );

  final String? fromSpaceId;
  final String? toSpaceId;
  final List<String> via;
  final String? message;
  final bool reachable;
  final double lengthM;
  final bool stepFree;
  final double? minWidthM;
  final List<String> spacePath;
  final List<String> steps;
  final List<RouteFloorSegment> floors;
  final List<RouteConnector> connectors;
  final List<BlockingOpening> blockingOpenings;

  /// Original route payload for native map/3D bridges.
  final Map<String, dynamic> raw;
}

class RouteFitCheck {
  const RouteFitCheck({required this.ok, required this.blockingOpenings, this.route, this.alternative});

  factory RouteFitCheck.fromJson(Map<String, dynamic> json) => RouteFitCheck(
    ok: _bool(json['ok']),
    route: json['route'] is Map ? RouteModel.fromJson(_map(json['route'])) : null,
    blockingOpenings: List.unmodifiable(_mapList(json['blocking_openings']).map(BlockingOpening.fromJson)),
    alternative: json['alternative'] is Map ? RouteModel.fromJson(_map(json['alternative'])) : null,
  );

  final bool ok;
  final RouteModel? route;
  final List<BlockingOpening> blockingOpenings;
  final RouteModel? alternative;
}

class FloorFitCheck {
  const FloorFitCheck({required this.ok, required this.reason});

  factory FloorFitCheck.fromJson(Map<String, dynamic> json) =>
      FloorFitCheck(ok: _bool(json['ok']), reason: _string(json['reason']));

  final bool ok;
  final String reason;
}

class DimensionCheck {
  const DimensionCheck({required this.summary, this.declared, this.routeFit, this.floorFit});

  factory DimensionCheck.fromJson(Map<String, dynamic> json) => DimensionCheck(
    declared: json['declared'] is Map ? DeclaredDimensionCheck.fromJson(_map(json['declared'])) : null,
    routeFit: json['route_fit'] is Map ? RouteFitCheck.fromJson(_map(json['route_fit'])) : null,
    floorFit: json['floor_fit'] is Map ? FloorFitCheck.fromJson(_map(json['floor_fit'])) : null,
    summary: _string(json['summary']),
  );

  final DeclaredDimensionCheck? declared;
  final RouteFitCheck? routeFit;
  final FloorFitCheck? floorFit;
  final String summary;
}

class Delivery {
  const Delivery({
    required this.id,
    required this.siteId,
    required this.ts,
    required this.label,
    required this.dimsM,
    required this.toleranceM,
    required this.floorId,
    required this.spaceId,
    required this.position,
    required this.rotationDeg,
    required this.status,
    required this.check,
    this.note,
    this.declaredDimsM,
    this.targetSpaceId,
    this.photoUrl,
    this.modelUrl,
    this.overlayUrl,
  });

  factory Delivery.fromJson(Map<String, dynamic> json) => Delivery(
    id: _string(json['id']),
    siteId: _string(json['site_id']),
    ts: _string(json['ts']),
    label: _string(json['label']),
    note: _optionalString(json['note']),
    dimsM: Dimensions.fromJson(_map(json['dims_m'])),
    toleranceM: _double(json['tolerance_m']),
    declaredDimsM: json['declared_dims_m'] is Map ? Dimensions.fromJson(_map(json['declared_dims_m'])) : null,
    floorId: _string(json['floor_id']),
    spaceId: _string(json['space_id']),
    position: _point(json['position']),
    rotationDeg: _double(json['rotation_deg']),
    targetSpaceId: _optionalString(json['target_space_id']),
    photoUrl: _optionalString(json['photo_url']),
    modelUrl: _optionalString(json['model_url']),
    overlayUrl: _optionalString(json['overlay_url']),
    status: _string(json['status']),
    check: DimensionCheck.fromJson(_map(json['check'])),
  );

  final String id;
  final String siteId;
  final String ts;
  final String label;
  final String? note;
  final Dimensions dimsM;
  final double toleranceM;
  final Dimensions? declaredDimsM;
  final String floorId;
  final String spaceId;
  final List<double> position;
  final double rotationDeg;
  final String? targetSpaceId;
  final String? photoUrl;
  final String? modelUrl;
  final String? overlayUrl;
  final String status;
  final DimensionCheck check;

  DateTime? get time => DateTime.tryParse(ts);
  String get dimensionsText => dimsM.displayString;
  String get statusLabel => switch (status) {
    'ok' => 'Ready',
    'mismatch' => 'Dimensions differ',
    'blocked' => 'Blocked',
    _ => status.isEmpty ? 'Unknown' : status,
  };
}

class SiteState {
  const SiteState({
    required this.closed,
    required this.assetOverrides,
    required this.deliveries,
    required this.addedOpenings,
    required this.raw,
  });

  factory SiteState.fromJson(Map<String, dynamic> json) => SiteState(
    closed: _stringList(json['closed']),
    assetOverrides: Map.unmodifiable({
      for (final entry in _map(json['asset_overrides']).entries)
        if (entry.value is Map) entry.key: AssetOverride.fromJson(_map(entry.value)),
    }),
    deliveries: List.unmodifiable(_mapList(json['deliveries']).map(Delivery.fromJson)),
    addedOpenings: List.unmodifiable(_mapList(json['added_openings']).map(BuildingOpening.fromJson)),
    raw: json,
  );

  final List<String> closed;
  final Map<String, AssetOverride> assetOverrides;
  final List<Delivery> deliveries;
  final List<BuildingOpening> addedOpenings;

  /// Original state payload for native map/3D bridges.
  final Map<String, dynamic> raw;

  bool isClosed(String elementId) => closed.contains(elementId);
}

class SiteEvent {
  const SiteEvent({
    required this.id,
    required this.ts,
    required this.siteId,
    required this.type,
    required this.title,
    required this.payload,
  });

  factory SiteEvent.fromJson(Map<String, dynamic> json) => SiteEvent(
    id: _string(json['id']),
    ts: _string(json['ts']),
    siteId: _string(json['site_id']),
    type: _string(json['type']),
    title: _string(json['title']),
    payload: _map(json['payload']),
  );

  final String id;
  final String ts;
  final String siteId;
  final String type;
  final String title;
  final Map<String, dynamic> payload;

  DateTime? get time => DateTime.tryParse(ts);
  Delivery? get delivery => type == 'delivery' ? Delivery.fromJson(payload) : null;
}

class Booking {
  const Booking({
    required this.id,
    required this.siteId,
    required this.spaceId,
    required this.start,
    required this.end,
    required this.who,
    required this.title,
  });

  factory Booking.fromJson(Map<String, dynamic> json) => Booking(
    id: _string(json['id']),
    siteId: _string(json['site_id']),
    spaceId: _string(json['space_id']),
    start: _string(json['start']),
    end: _string(json['end']),
    who: _string(json['who']),
    title: _string(json['title']),
  );

  final String id;
  final String siteId;
  final String spaceId;
  final String start;
  final String end;
  final String who;
  final String title;

  DateTime? get startTime => DateTime.tryParse(start);
  DateTime? get endTime => DateTime.tryParse(end);
}

class BookableRoom {
  const BookableRoom({
    required this.spaceId,
    required this.name,
    required this.floorId,
    required this.level,
    required this.capacity,
    required this.areaM2,
    required this.free,
    required this.bookings,
    this.distanceM,
  });

  factory BookableRoom.fromJson(Map<String, dynamic> json) => BookableRoom(
    spaceId: _string(json['space_id']),
    name: _string(json['name']),
    floorId: _string(json['floor_id']),
    level: _int(json['level']),
    capacity: _int(json['capacity']),
    areaM2: _double(json['area_m2']),
    free: _bool(json['free']),
    bookings: List.unmodifiable(_mapList(json['bookings']).map(Booking.fromJson)),
    distanceM: _optionalDouble(json['distance_m']),
  );

  final String spaceId;
  final String name;
  final String floorId;
  final int level;
  final int capacity;
  final double areaM2;
  final bool free;
  final List<Booking> bookings;
  final double? distanceM;

  String get displayName => name.isNotEmpty ? name : spaceId;
}

class RoomDeviation {
  const RoomDeviation({required this.wallIndex, required this.offsetM, required this.segment});

  factory RoomDeviation.fromJson(Map<String, dynamic> json) => RoomDeviation(
    wallIndex: _int(json['wall_index']),
    offsetM: _double(json['offset_m']),
    segment: _points(json['segment']),
  );

  final int wallIndex;
  final double offsetM;
  final List<List<double>> segment;
}

class RoomScan {
  const RoomScan({
    required this.id,
    required this.siteId,
    required this.spaceId,
    required this.splatUrl,
    required this.transform,
    required this.deviations,
    required this.summary,
    this.floorId,
    this.ts,
  });

  factory RoomScan.fromJson(Map<String, dynamic> json) => RoomScan(
    id: _string(json['id']),
    siteId: _string(json['site_id']),
    spaceId: _string(json['space_id']),
    splatUrl: _string(json['splat_url']),
    transform: List.unmodifiable(_list(json['transform']).map((value) => _double(value))),
    deviations: List.unmodifiable(_mapList(json['deviations']).map(RoomDeviation.fromJson)),
    summary: _string(json['summary']),
    floorId: _optionalString(json['floor_id']),
    ts: _optionalString(json['ts']),
  );

  final String id;
  final String siteId;
  final String spaceId;
  final String splatUrl;
  final List<double> transform;
  final List<RoomDeviation> deviations;
  final String summary;
  final String? floorId;
  final String? ts;
}

class CaptureJob {
  const CaptureJob({
    required this.id,
    required this.kind,
    required this.siteId,
    required this.status,
    required this.progress,
    required this.message,
    required this.raw,
    this.result,
  });

  factory CaptureJob.fromJson(Map<String, dynamic> json) => CaptureJob(
    id: _string(json['id']),
    kind: _string(json['kind']),
    siteId: _string(json['site_id']),
    status: _string(json['status']),
    progress: _double(json['progress']).clamp(0, 1).toDouble(),
    message: _string(json['message']),
    result: json['result'] is Map ? _map(json['result']) : null,
    raw: json,
  );

  final String id;
  final String kind;
  final String siteId;
  final String status;
  final double progress;
  final String message;

  /// Delivery or RoomScan source payload, retained for native viewers.
  final Map<String, dynamic>? result;
  final Map<String, dynamic> raw;

  Delivery? get deliveryResult => kind == 'delivery' && result != null ? Delivery.fromJson(result!) : null;
  RoomScan? get roomScanResult => kind == 'room' && result != null ? RoomScan.fromJson(result!) : null;

  bool get isDone => status == 'done';
  bool get isFailed => status == 'failed';
  bool get isTerminal => isDone || isFailed;
}

class ChatAction {
  const ChatAction({
    required this.type,
    required this.raw,
    this.spaceId,
    this.route,
    this.ids = const <String>[],
    this.label,
    this.floorId,
    this.chips = const <String>[],
  });

  factory ChatAction.fromJson(Map<String, dynamic> json) => ChatAction(
    type: _string(json['type']),
    spaceId: _optionalString(json['space_id']),
    route: json['route'] is Map ? RouteModel.fromJson(_map(json['route'])) : null,
    ids: _stringList(json['ids']),
    label: _optionalString(json['label']),
    floorId: _optionalString(json['floor_id']),
    chips: _stringList(json['chips']),
    raw: json,
  );

  final String type;
  final String? spaceId;
  final RouteModel? route;
  final List<String> ids;
  final String? label;
  final String? floorId;
  final List<String> chips;
  final Map<String, dynamic> raw;
}
