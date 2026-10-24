import 'package:flutter_test/flutter_test.dart';
import 'package:sitetwin/core/models.dart';
import 'package:sitetwin/features/assistant/voice_service.dart';
import 'package:sitetwin/features/site/entity_info.dart';
import 'package:sitetwin/features/site/site_session.dart';

Building _building({String id = 'b1'}) => Building.fromJson({
  'building': {'id': id, 'name': 'Test', 'attribution': 'ODbL'},
  'floors': [
    {'id': 'L0', 'level': 0, 'name': 'Ground', 'elevation_m': 0, 'height_m': 4},
    {'id': 'L1', 'level': 1, 'name': 'First', 'elevation_m': 4, 'height_m': 4},
  ],
  'spaces': [
    {
      'id': 's-office',
      'floor_id': 'L1',
      'type': 'room',
      'room_type': 'office',
      'name': 'Office 1.04',
      'polygon': [
        [0, 0],
        [5, 0],
        [5, 4],
        [0, 4],
      ],
    },
    {
      'id': 's-lobby',
      'floor_id': 'L0',
      'type': 'room',
      'room_type': 'lobby',
      'name': 'Lobby',
      'polygon': [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    },
  ],
  'openings': [
    {
      'id': 'door-1',
      'floor_id': 'L0',
      'space_ids': ['outside', 's-lobby'],
      'kind': 'door',
      'position': [5, 0],
      'width_m': 1.2,
      'step_free': true,
    },
  ],
  'vertical_connectors': [
    {
      'id': 'lift-office',
      'kind': 'lift',
      'name': 'Office lift',
      'floor_ids': ['L0', 'L1'],
      'space_ids': ['s-lobby', 's-office'],
      'step_free': true,
    },
  ],
  'assets': [
    {
      'id': 'asset-drum',
      'name': 'Steel drum',
      'category': 'equipment',
      'type': 'steel_drum',
      'space_id': 's-lobby',
      'floor_id': 'L0',
      'position': [2, 2],
    },
  ],
});

void main() {
  group('defaultOrigin', () {
    test('uses the upstairs office for the demo factory', () {
      expect(defaultOrigin(_building(id: 'proc-factory-dev-003')), 's-office');
    });

    test('falls back to a ground-floor lobby', () {
      expect(defaultOrigin(_building()), 's-lobby');
    });
  });

  test('timeline hides deliveries that arrived after the scrubbed time', () {
    final state = SiteState.fromJson({
      'closed': [],
      'deliveries': [
        {
          'id': 'early',
          'ts': '2026-10-20T10:00:00Z',
          'dims_m': {'w': 1, 'd': 1, 'h': 1},
        },
        {
          'id': 'late',
          'ts': '2026-10-23T10:00:00Z',
          'dims_m': {'w': 1, 'd': 1, 'h': 1},
        },
      ],
    });
    final live = SiteSessionState(siteState: state);
    expect(live.visibleDeliveryIds, isNull);
    final scrubbed = live.copyWith(timelineTs: DateTime.utc(2026, 10, 21));
    expect(scrubbed.visibleDeliveryIds, ['early']);
    expect(scrubbed.copyWith(timelineTs: null).visibleDeliveryIds, isNull);
  });

  group('describeEntity', () {
    final building = _building();
    final state = SiteState.fromJson({
      'closed': ['lift-office'],
    });

    test('describes rooms with type, floor and area', () {
      final info = describeEntity(building, state, 's-office')!;
      expect(info.kind, EntityKind.room);
      expect(info.subtitle, 'Office · L1 · 20 m²');
      expect(info.routeTarget, 's-office');
    });

    test('marks closable connectors and their closure state', () {
      final info = describeEntity(building, state, 'lift-office')!;
      expect(info.kind, EntityKind.connector);
      expect(info.closable, isTrue);
      expect(info.closed, isTrue);
    });

    test('returns null for unknown ids', () {
      expect(describeEntity(building, state, 'nope'), isNull);
    });
  });

  group('speech text', () {
    test('drops notes and markdown and limits length', () {
      expect(speakable('**Go** left (via lift)  then `right`'), 'Go left then right');
      expect(speakable('a' * 700).length, 600);
    });

    test('detects German replies', () {
      expect(looksGerman('Wo ist die Kantine?'), isTrue);
      expect(looksGerman('Where is the canteen?'), isFalse);
    });
  });
}
