import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../app/widgets.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../site/site_session.dart';

class RoutePanel extends ConsumerStatefulWidget {
  const RoutePanel({
    required this.siteId,
    required this.scrollController,
    required this.bottomInset,
    required this.onShowOnTwin,
    super.key,
  });

  final String siteId;
  final ScrollController scrollController;
  final double bottomInset;
  final VoidCallback onShowOnTwin;

  @override
  ConsumerState<RoutePanel> createState() => _RoutePanelState();
}

class _RoutePanelState extends ConsumerState<RoutePanel> {
  final _from = TextEditingController();
  final _to = TextEditingController();
  final _minWidth = TextEditingController();
  final _toFocus = FocusNode();
  String? _toId;
  bool _stepFree = false;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _to.addListener(() => setState(() {}));
    _toFocus.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _from.dispose();
    _to.dispose();
    _minWidth.dispose();
    _toFocus.dispose();
    super.dispose();
  }

  /// Unique space names map to ids; everything else is sent as typed for the server to resolve.
  Map<String, String?> _namesToIds(Building building) {
    final names = <String, String?>{};
    for (final space in building.spaces) {
      if (space.type == 'corridor' || space.name.isEmpty) continue;
      names[space.name] = names.containsKey(space.name) ? null : space.id;
    }
    return names;
  }

  Future<void> _route(Building building) async {
    final names = _namesToIds(building);
    final toText = _to.text.trim();
    final to = _toId ?? names[toText] ?? toText;
    if (to.isEmpty) return;
    final fromText = _from.text.trim();
    final minWidth = double.tryParse(_minWidth.text.trim().replaceAll(',', '.'));
    setState(() {
      _busy = true;
      _error = null;
    });
    FocusScope.of(context).unfocus();
    try {
      await ref
          .read(siteSessionProvider(widget.siteId).notifier)
          .navigate(
            to: to,
            from: fromText.isEmpty ? null : names[fromText] ?? fromText,
            stepFree: _stepFree,
            minWidthM: minWidth != null && minWidth > 0 ? minWidth : null,
          );
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(siteSessionProvider(widget.siteId));
    final building = session.building;
    if (building == null) return const SizedBox.shrink();
    final origin = session.originId == null ? null : building.spaceById(session.originId!);
    final query = _to.text.trim().toLowerCase();
    final suggestions = _toFocus.hasFocus && query.isNotEmpty && _toId == null
        ? _namesToIds(building).keys.where((name) => name.toLowerCase().contains(query)).take(8).toList()
        : const <String>[];
    final route = session.route;
    return ListView(
      controller: widget.scrollController,
      padding: EdgeInsets.fromLTRB(14, 6, 14, widget.bottomInset),
      children: [
        TextField(
          controller: _from,
          textInputAction: TextInputAction.next,
          decoration: InputDecoration(
            labelText: 'From',
            hintText: origin == null ? 'Room, ref or id' : '${origin.displayName} (you are here)',
            floatingLabelBehavior: FloatingLabelBehavior.always,
            prefixIcon: const Icon(CupertinoIcons.smallcircle_fill_circle, size: 17),
          ),
        ),
        const SizedBox(height: 10),
        TextField(
          controller: _to,
          focusNode: _toFocus,
          textInputAction: TextInputAction.go,
          onChanged: (_) => _toId = null,
          onSubmitted: (_) => _route(building),
          decoration: const InputDecoration(
            labelText: 'To',
            hintText: 'Room, ref, asset or id',
            floatingLabelBehavior: FloatingLabelBehavior.always,
            prefixIcon: Icon(CupertinoIcons.location_solid, size: 17),
          ),
        ),
        if (suggestions.isNotEmpty) ...[
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final name in suggestions)
                ActionChip(
                  label: Text(name, style: const TextStyle(fontSize: 12)),
                  backgroundColor: const Color(0x14FFFFFF),
                  side: const BorderSide(color: AppColors.border),
                  onPressed: () {
                    _to.text = name;
                    _toId = _namesToIds(building)[name];
                    _toFocus.unfocus();
                  },
                ),
            ],
          ),
        ],
        const SizedBox(height: 10),
        Row(
          children: [
            const Icon(CupertinoIcons.person_crop_circle_badge_checkmark, size: 17, color: AppColors.textMuted),
            const SizedBox(width: 8),
            const Text('Step-free', style: TextStyle(color: AppColors.text, fontSize: 14)),
            const SizedBox(width: 8),
            CupertinoSwitch(
              value: _stepFree,
              activeTrackColor: AppColors.accent2,
              onChanged: (value) => setState(() => _stepFree = value),
            ),
            const Spacer(),
            SizedBox(
              width: 112,
              child: TextField(
                controller: _minWidth,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Min width', suffixText: 'm', isDense: true),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: AppButton(
                label: 'Route',
                icon: CupertinoIcons.location_north_fill,
                tone: AppButtonTone.accent,
                loading: _busy,
                onPressed: _to.text.trim().isEmpty ? null : () => _route(building),
              ),
            ),
            if (route != null) ...[
              const SizedBox(width: 8),
              AppButton(
                label: 'Clear',
                icon: CupertinoIcons.xmark,
                onPressed: ref.read(siteSessionProvider(widget.siteId).notifier).clearRoute,
              ),
            ],
          ],
        ),
        if (_error != null) ...[const SizedBox(height: 12), InlineMessage(_error!)],
        if (route != null) ...[
          const SizedBox(height: 14),
          _RouteSummary(route: route, onShowOnTwin: widget.onShowOnTwin),
        ],
      ],
    );
  }
}

class _RouteSummary extends StatelessWidget {
  const _RouteSummary({required this.route, required this.onShowOnTwin});

  final RouteModel route;
  final VoidCallback onShowOnTwin;

  @override
  Widget build(BuildContext context) {
    if (!route.reachable) {
      return InlineMessage(route.message ?? 'No route is available with these constraints.');
    }
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0x0AFFFFFF),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                route.lengthM.toStringAsFixed(1),
                style: const TextStyle(
                  color: Color(0xFFBAE6FD),
                  fontSize: 28,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.8,
                ),
              ),
              const Padding(
                padding: EdgeInsets.only(left: 4, bottom: 5),
                child: Text('m', style: TextStyle(color: AppColors.textMuted, fontSize: 14)),
              ),
              const Spacer(),
              if (route.stepFree)
                const StatusBadge('STEP-FREE', color: AppColors.accent2, icon: CupertinoIcons.checkmark),
            ],
          ),
          const SizedBox(height: 10),
          for (final (index, step) in route.steps.indexed)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 20,
                    height: 20,
                    alignment: Alignment.center,
                    decoration: const BoxDecoration(color: AppColors.accentSoft, shape: BoxShape.circle),
                    child: Text(
                      '${index + 1}',
                      style: const TextStyle(color: Color(0xFFBAE6FD), fontSize: 10, fontWeight: FontWeight.w700),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(step, style: const TextStyle(color: AppColors.text, fontSize: 13, height: 1.35)),
                  ),
                ],
              ),
            ),
          if (route.message != null) Text(route.message!, style: const TextStyle(color: AppColors.warn, fontSize: 12)),
          if (route.blockingOpenings.isNotEmpty)
            Text(
              '${route.blockingOpenings.length} door(s) too narrow on the direct way.',
              style: const TextStyle(color: AppColors.danger, fontSize: 12),
            ),
          const SizedBox(height: 6),
          AppButton(label: 'Show on twin', icon: CupertinoIcons.cube, expand: true, onPressed: onShowOnTwin),
        ],
      ),
    );
  }
}
