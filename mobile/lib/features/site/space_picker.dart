import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../app/widgets.dart';
import '../../core/models.dart';
import 'entity_info.dart';

/// Rooms a person would choose as a destination or scan target, grouped by floor (corridors last).
List<(BuildingFloor, List<BuildingSpace>)> pickableSpaces(Building building) {
  int rank(BuildingSpace space) => switch (space.type) {
    'room' => 0,
    'hall' => 1,
    'corridor' => 2,
    _ => 3,
  };
  final floors = [...building.floors]..sort((a, b) => a.level.compareTo(b.level));
  final groups = <(BuildingFloor, List<BuildingSpace>)>[];
  for (final floor in floors) {
    final spaces =
        building.spaces
            .where((space) => space.floorId == floor.id && !const {'stair', 'lift', 'outdoor'}.contains(space.type))
            .toList()
          ..sort((a, b) => rank(a) != rank(b) ? rank(a) - rank(b) : a.displayName.compareTo(b.displayName));
    if (spaces.isNotEmpty) groups.add((floor, spaces));
  }
  return groups;
}

Future<BuildingSpace?> showSpacePicker(BuildContext context, Building building, {required String title}) {
  return showModalBottomSheet<BuildingSpace>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => _SpacePicker(building: building, title: title),
  );
}

class _SpacePicker extends StatefulWidget {
  const _SpacePicker({required this.building, required this.title});

  final Building building;
  final String title;

  @override
  State<_SpacePicker> createState() => _SpacePickerState();
}

class _SpacePickerState extends State<_SpacePicker> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final groups = pickableSpaces(widget.building);
    final query = _query.toLowerCase();
    return FractionallySizedBox(
      heightFactor: 0.85,
      child: GlassPanel(
        borderRadius: 26,
        color: AppColors.panelSolid,
        child: Column(
          children: [
            const SheetHandle(),
            PanelHeader(title: widget.title, onClose: () => Navigator.of(context).pop()),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: TextField(
                autofocus: false,
                onChanged: (value) => setState(() => _query = value.trim()),
                decoration: const InputDecoration(
                  hintText: 'Search rooms',
                  prefixIcon: Icon(CupertinoIcons.search, size: 17),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: ListView(
                padding: EdgeInsets.fromLTRB(8, 0, 8, MediaQuery.paddingOf(context).bottom + 16),
                children: [
                  for (final (floor, spaces) in groups) ...[
                    if (spaces.any((space) => space.displayName.toLowerCase().contains(query)))
                      Padding(
                        padding: const EdgeInsets.fromLTRB(10, 12, 10, 4),
                        child: Text(
                          '${floorLabel(floor)} · ${floor.displayName}'.toUpperCase(),
                          style: const TextStyle(
                            color: AppColors.textDim,
                            fontSize: 10,
                            letterSpacing: 1.2,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    for (final space in spaces)
                      if (space.displayName.toLowerCase().contains(query))
                        ListTile(
                          dense: true,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          leading: Container(
                            width: 10,
                            height: 10,
                            decoration: BoxDecoration(
                              color:
                                  AppColors.roomPalette[space.roomType] ??
                                  AppColors.roomPalette[space.type] ??
                                  AppColors.textDim,
                              borderRadius: BorderRadius.circular(3),
                            ),
                          ),
                          title: Text(space.displayName, style: const TextStyle(color: AppColors.text, fontSize: 14)),
                          subtitle: Text(
                            humanize(space.roomType ?? space.type),
                            style: const TextStyle(color: AppColors.textDim, fontSize: 11),
                          ),
                          onTap: () => Navigator.of(context).pop(space),
                        ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
