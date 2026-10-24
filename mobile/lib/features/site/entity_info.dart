import '../../core/models.dart';

enum EntityKind { room, asset, door, connector, delivery }

class EntityInfo {
  const EntityInfo({
    required this.id,
    required this.kind,
    required this.title,
    required this.subtitle,
    this.floorId,
    this.closable = false,
    this.closed = false,
    this.routeTarget,
    this.detail,
  });

  final String id;
  final EntityKind kind;
  final String title;
  final String subtitle;
  final String? floorId;
  final bool closable;
  final bool closed;

  /// Id the router can navigate to, when the entity is a sensible destination.
  final String? routeTarget;
  final String? detail;
}

double polygonArea(List<List<double>> polygon) {
  var area = 0.0;
  for (var index = 0; index < polygon.length; index++) {
    final a = polygon[index];
    final b = polygon[(index + 1) % polygon.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return (area / 2).abs();
}

String humanize(String value) {
  final words = value.replaceAll('_', ' ').trim();
  return words.isEmpty ? words : words[0].toUpperCase() + words.substring(1);
}

String floorLabel(BuildingFloor? floor) {
  if (floor == null) return '';
  return floor.level >= 0 ? 'L${floor.level}' : 'B${-floor.level}';
}

EntityInfo? describeEntity(Building building, SiteState? state, String id) {
  for (final space in building.spaces) {
    if (space.id != id) continue;
    final floor = building.floorById(space.floorId);
    return EntityInfo(
      id: id,
      kind: EntityKind.room,
      title: space.displayName,
      subtitle: [
        humanize(space.roomType ?? space.type),
        floorLabel(floor),
        '${polygonArea(space.polygon).toStringAsFixed(0)} m²',
      ].where((part) => part.isNotEmpty).join(' · '),
      floorId: space.floorId,
      routeTarget: id,
    );
  }
  for (final asset in building.assets) {
    if (asset.id != id) continue;
    final override = state?.assetOverrides[id];
    final space = building.spaceById(override?.spaceId ?? asset.spaceId);
    return EntityInfo(
      id: id,
      kind: EntityKind.asset,
      title: asset.displayName,
      subtitle: [
        humanize(asset.type.isEmpty ? asset.category : asset.type),
        if (space != null) space.displayName,
      ].join(' · '),
      floorId: override?.floorId ?? asset.floorId,
      routeTarget: id,
    );
  }
  for (final opening in [...building.openings, ...?state?.addedOpenings]) {
    if (opening.id != id) continue;
    return EntityInfo(
      id: id,
      kind: EntityKind.door,
      title: humanize(opening.kind.isEmpty ? 'door' : opening.kind),
      subtitle: [
        '${opening.widthM.toStringAsFixed(2)} m wide',
        opening.stepFree ? 'step-free' : 'has a step',
        floorLabel(building.floorById(opening.floorId)),
      ].where((part) => part.isNotEmpty).join(' · '),
      floorId: opening.floorId,
      closable: true,
      closed: state?.isClosed(id) ?? false,
    );
  }
  for (final connector in building.connectors) {
    if (connector.id != id) continue;
    return EntityInfo(
      id: id,
      kind: EntityKind.connector,
      title: connector.name.isEmpty ? humanize(connector.kind) : connector.name,
      subtitle:
          '${humanize(connector.kind)} · ${connector.floorIds.length} floors'
          '${connector.stepFree ? ' · step-free' : ''}',
      closable: true,
      closed: state?.isClosed(id) ?? false,
    );
  }
  for (final delivery in state?.deliveries ?? const <Delivery>[]) {
    if (delivery.id != id) continue;
    final space = building.spaceById(delivery.spaceId);
    return EntityInfo(
      id: id,
      kind: EntityKind.delivery,
      title: delivery.label.isEmpty ? 'Delivery' : delivery.label,
      subtitle: [delivery.dimensionsText, if (space != null) space.displayName].join(' · '),
      floorId: delivery.floorId,
      routeTarget: delivery.spaceId.isEmpty ? null : delivery.spaceId,
      detail: delivery.check.summary.isEmpty ? delivery.statusLabel : delivery.check.summary,
    );
  }
  return null;
}
