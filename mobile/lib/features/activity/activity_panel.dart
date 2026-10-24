import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../app/widgets.dart';
import '../../core/models.dart';
import '../site/site_session.dart';
import 'booking_panel.dart';
import 'route_panel.dart';

enum ActivityTab { changes, deliveries, rooms, route }

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

String clockLabel(DateTime time) {
  final local = time.toLocal();
  final hours = local.hour.toString().padLeft(2, '0');
  final minutes = local.minute.toString().padLeft(2, '0');
  return '${_weekdays[local.weekday - 1]} $hours:$minutes';
}

class ActivityPanel extends StatelessWidget {
  const ActivityPanel({
    required this.siteId,
    required this.scrollController,
    required this.tab,
    required this.onTabChanged,
    required this.onShowOnTwin,
    required this.onClose,
    required this.bottomInset,
    super.key,
    this.routeDestination,
  });

  final String siteId;
  final ScrollController scrollController;
  final ActivityTab tab;
  final String? routeDestination;
  final ValueChanged<ActivityTab> onTabChanged;
  final VoidCallback onShowOnTwin;
  final VoidCallback onClose;
  final double bottomInset;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        PanelHeader(title: 'Activity', subtitle: 'Live changes, deliveries, rooms and routes', onClose: onClose),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: AppSegmentedControl<ActivityTab>(
            values: const [
              (ActivityTab.changes, 'Changes'),
              (ActivityTab.deliveries, 'Deliveries'),
              (ActivityTab.rooms, 'Rooms'),
              (ActivityTab.route, 'Route'),
            ],
            selected: tab,
            onChanged: onTabChanged,
          ),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: switch (tab) {
            ActivityTab.changes => _ChangesList(
              siteId: siteId,
              controller: scrollController,
              bottomInset: bottomInset,
              onShowOnTwin: onShowOnTwin,
            ),
            ActivityTab.deliveries => _DeliveriesList(
              siteId: siteId,
              controller: scrollController,
              bottomInset: bottomInset,
              onShowOnTwin: onShowOnTwin,
            ),
            ActivityTab.rooms => BookingPanel(
              siteId: siteId,
              scrollController: scrollController,
              bottomInset: bottomInset,
              onShowOnTwin: onShowOnTwin,
            ),
            ActivityTab.route => RoutePanel(
              key: ValueKey(routeDestination),
              siteId: siteId,
              scrollController: scrollController,
              bottomInset: bottomInset,
              initialDestination: routeDestination,
              onShowOnTwin: onShowOnTwin,
            ),
          },
        ),
      ],
    );
  }
}

String? _focusTarget(SiteEvent event) {
  final payload = event.payload;
  final keys = event.type == 'delivery' ? const ['id', 'space_id'] : const ['element_id', 'asset_id', 'space_id', 'id'];
  for (final key in keys) {
    final value = payload[key];
    if (value is String && value.isNotEmpty) return value;
  }
  return null;
}

(IconData, Color) eventStyle(String type) => switch (type) {
  'delivery' => (CupertinoIcons.cube_box, AppColors.warn),
  'asset_moved' => (CupertinoIcons.arrow_right_arrow_left, AppColors.accent),
  'closure' => (CupertinoIcons.lock, AppColors.danger),
  'booking' => (CupertinoIcons.calendar, AppColors.booked),
  'door_added' => (CupertinoIcons.rectangle_split_3x1, AppColors.ok),
  'capture' => (CupertinoIcons.viewfinder, AppColors.accent2),
  _ => (CupertinoIcons.circle, AppColors.textMuted),
};

class _ChangesList extends ConsumerWidget {
  const _ChangesList({
    required this.siteId,
    required this.controller,
    required this.bottomInset,
    required this.onShowOnTwin,
  });

  final String siteId;
  final ScrollController controller;
  final double bottomInset;
  final VoidCallback onShowOnTwin;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(siteSessionProvider(siteId).select((state) => state.events));
    if (events.isEmpty) {
      return ListView(
        controller: controller,
        children: const [
          EmptyState(
            title: 'No changes yet',
            message: 'Deliveries, closures, bookings and scans appear here live.',
            icon: CupertinoIcons.waveform_path,
          ),
        ],
      );
    }
    final now = DateTime.now();
    return ListView.builder(
      controller: controller,
      padding: EdgeInsets.fromLTRB(10, 4, 10, bottomInset),
      itemCount: events.length,
      itemBuilder: (context, index) {
        final event = events[index];
        final (icon, color) = eventStyle(event.type);
        final time = event.time;
        final target = _focusTarget(event);
        return InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: target == null
              ? null
              : () {
                  ref.read(siteSessionProvider(siteId).notifier).highlight([target], label: event.title);
                  onShowOnTwin();
                },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.13),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: color.withValues(alpha: 0.25)),
                  ),
                  child: Icon(icon, size: 16, color: color),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(event.title, style: const TextStyle(color: AppColors.text, fontSize: 14, height: 1.3)),
                      if (time != null) ...[
                        const SizedBox(height: 3),
                        Text(
                          '${timeAgo(time, now)} · ${clockLabel(time)}',
                          style: const TextStyle(color: AppColors.textDim, fontSize: 11),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _DeliveriesList extends ConsumerWidget {
  const _DeliveriesList({
    required this.siteId,
    required this.controller,
    required this.bottomInset,
    required this.onShowOnTwin,
  });

  final String siteId;
  final ScrollController controller;
  final double bottomInset;
  final VoidCallback onShowOnTwin;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(siteSessionProvider(siteId));
    final deliveries = [...?session.siteState?.deliveries]..sort((a, b) => b.ts.compareTo(a.ts));
    if (deliveries.isEmpty) {
      return ListView(
        controller: controller,
        children: const [
          EmptyState(
            title: 'No deliveries',
            message: 'Use Capture to measure a delivery against the floor plan.',
            icon: CupertinoIcons.cube_box,
          ),
        ],
      );
    }
    final now = DateTime.now();
    return ListView.separated(
      controller: controller,
      padding: EdgeInsets.fromLTRB(14, 6, 14, bottomInset),
      itemCount: deliveries.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final delivery = deliveries[index];
        final color = switch (delivery.status) {
          'ok' => AppColors.ok,
          'blocked' => AppColors.danger,
          _ => AppColors.warn,
        };
        final space = session.building?.spaceById(delivery.spaceId);
        final time = delivery.time;
        return Material(
          color: const Color(0x0AFFFFFF),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: const BorderSide(color: AppColors.border),
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: () {
              ref.read(siteSessionProvider(siteId).notifier).highlight([delivery.id], label: delivery.label);
              onShowOnTwin();
            },
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          delivery.label.isEmpty ? 'Delivery' : delivery.label,
                          style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600),
                        ),
                      ),
                      StatusBadge(delivery.statusLabel.toUpperCase(), color: color),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '${delivery.dimensionsText}  ±${(delivery.toleranceM * 100).round()} cm',
                    style: const TextStyle(color: AppColors.accent, fontSize: 12, fontFamily: 'Menlo'),
                  ),
                  if (delivery.check.summary.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      delivery.check.summary,
                      style: const TextStyle(color: AppColors.text, fontSize: 12, height: 1.35),
                    ),
                  ],
                  const SizedBox(height: 6),
                  Text(
                    [if (space != null) space.displayName, if (time != null) timeAgo(time, now)].join(' · '),
                    style: const TextStyle(color: AppColors.textDim, fontSize: 11),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
