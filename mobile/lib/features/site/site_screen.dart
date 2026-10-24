import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../app/widgets.dart';
import '../../core/api_client.dart';
import '../../core/live_client.dart';
import '../../core/models.dart';
import '../activity/activity_panel.dart';
import '../assistant/assistant_panel.dart';
import '../capture/capture_panel.dart';
import '../twin/timeline_bar.dart';
import '../twin/twin_surface.dart';
import 'entity_info.dart';
import 'site_session.dart';

enum SitePanel { twin, activity, capture, ask }

class SiteScreen extends ConsumerStatefulWidget {
  const SiteScreen({required this.siteId, super.key});

  final String siteId;

  @override
  ConsumerState<SiteScreen> createState() => _SiteScreenState();
}

class _SiteScreenState extends ConsumerState<SiteScreen> with WidgetsBindingObserver {
  SitePanel _panel = SitePanel.twin;
  ActivityTab _activityTab = ActivityTab.changes;
  String? _routeDestination;
  TwinSurfaceController? _twin;
  String? _rendererError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    ref.read(liveClientProvider).restart();
    unawaited(ref.read(siteSessionProvider(widget.siteId).notifier).resync());
  }

  void _openPanel(SitePanel panel) {
    HapticFeedback.selectionClick();
    setState(() => _panel = _panel == panel && panel != SitePanel.twin ? SitePanel.twin : panel);
  }

  void _showOnTwin() => setState(() => _panel = SitePanel.twin);

  void _routeTo(String id) {
    setState(() {
      _routeDestination = id;
      _activityTab = ActivityTab.route;
      _panel = SitePanel.activity;
    });
  }

  void _showNotice(SessionNotice notice) {
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    final color = switch (notice.tone) {
      NoticeTone.ok => AppColors.ok,
      NoticeTone.warn => AppColors.warn,
      NoticeTone.info => AppColors.accent,
    };
    messenger.showSnackBar(
      SnackBar(
        content: Row(
          children: [
            Icon(CupertinoIcons.bell_fill, size: 15, color: color),
            const SizedBox(width: 10),
            Expanded(child: Text(notice.text, maxLines: 2, overflow: TextOverflow.ellipsis)),
          ],
        ),
        duration: const Duration(seconds: 4),
        margin: EdgeInsets.fromLTRB(16, 0, 16, _panel == SitePanel.twin ? 168 : 96),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final siteId = widget.siteId;
    final session = ref.watch(siteSessionProvider(siteId));
    final controller = ref.read(siteSessionProvider(siteId).notifier);
    ref.listen(siteSessionProvider(siteId).select((state) => state.notice), (previous, next) {
      if (next != null && next.id != previous?.id) _showNotice(next);
    });
    final site = ref.watch(sitesProvider).value?.where((site) => site.id == siteId).firstOrNull;
    final connection = ref.watch(liveConnectionProvider).value;
    final building = session.building;
    final media = MediaQuery.of(context);
    final keyboardOpen = media.viewInsets.bottom > 0;
    final navBottom = media.padding.bottom + 10;
    final selection = building == null || session.selectedId == null
        ? null
        : describeEntity(building, session.siteState, session.selectedId!);

    return Scaffold(
      backgroundColor: AppColors.background,
      body: Stack(
        children: [
          Positioned.fill(
            child: building == null
                ? _LoadingTwin(error: session.error, loading: session.loading, onRetry: controller.load)
                : TwinSurface(
                    building: building.raw,
                    state: session.siteState?.raw,
                    route: session.route?.raw,
                    exploded: session.exploded,
                    focusFloorId: session.focusFloorId,
                    highlightIds: session.highlightIds,
                    selectedId: session.selectedId,
                    timelineVisibleIds: session.visibleDeliveryIds,
                    onEntityTapped: (id) {
                      if (id.isNotEmpty) HapticFeedback.selectionClick();
                      controller.select(id);
                    },
                    onController: (twin) => _twin = twin,
                    onRendererError: (message) => setState(() => _rendererError = message),
                  ),
          ),
          Positioned(
            top: media.padding.top + 8,
            left: 12,
            right: 12,
            child: Column(
              children: [
                _SiteHeader(
                  title: site?.name ?? building?.name ?? siteId,
                  subtitle: building == null
                      ? 'Loading twin…'
                      : '${building.floors.length} floors · ${building.spaces.length} spaces · ${building.assets.length} assets',
                  connection: connection,
                  onBack: () => context.go('/'),
                ),
                if (building != null) ...[
                  const SizedBox(height: 8),
                  _FloorBar(
                    floors: building.floors,
                    exploded: session.exploded,
                    focusFloorId: session.focusFloorId,
                    onExploded: controller.setExploded,
                    onFocus: controller.focusFloor,
                    onFrame: () {
                      controller.focusFloor(null);
                      unawaited(_twin?.frameAll());
                    },
                  ),
                ],
                if (_rendererError != null) ...[const SizedBox(height: 8), InlineMessage(_rendererError!)],
              ],
            ),
          ),
          if (building != null && _panel == SitePanel.twin) ...[
            if (selection != null)
              Positioned(
                left: 12,
                right: 12,
                bottom: navBottom + 74 + (session.route != null ? 140 : 84),
                child: _SelectionCard(
                  info: selection,
                  onClose: () => controller.select(null),
                  onRoute: selection.routeTarget == null ? null : () => _routeTo(selection.routeTarget!),
                  onFocusFloor: selection.floorId == null ? null : () => controller.focusFloor(selection.floorId),
                  onToggleClosed: selection.closable
                      ? () async {
                          try {
                            await controller.setClosed(selection.id, closed: !selection.closed);
                          } on ApiException catch (error) {
                            if (context.mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.message)));
                            }
                          }
                        }
                      : null,
                ),
              ),
            Positioned(
              left: 12,
              right: 12,
              bottom: navBottom + 64 + 10,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (session.route != null) _RouteChip(route: session.route!, onClear: controller.clearRoute),
                  TimelineBar(
                    ticks: [
                      for (final event in session.events)
                        if (event.time case final time?) TimelineTick(id: event.id, timestamp: time, type: event.type),
                    ],
                    timestamp: session.timelineTs,
                    onChanged: controller.setTimeline,
                  ),
                  if (building.metadata.attribution.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(6, 5, 6, 0),
                      child: Text(
                        building.metadata.attribution,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: AppColors.textDim, fontSize: 9),
                      ),
                    ),
                ],
              ),
            ),
          ],
          if (_panel != SitePanel.twin)
            Positioned.fill(
              child: _PanelSheet(
                key: ValueKey(_panel),
                initialFraction: _panel == SitePanel.ask ? 0.72 : 0.62,
                expanded: keyboardOpen,
                builder: (scrollController) => switch (_panel) {
                  SitePanel.activity => ActivityPanel(
                    siteId: siteId,
                    scrollController: scrollController,
                    tab: _activityTab,
                    routeDestination: _routeDestination,
                    onTabChanged: (tab) => setState(() => _activityTab = tab),
                    onShowOnTwin: _showOnTwin,
                    onClose: _showOnTwin,
                    bottomInset: keyboardOpen ? 12 : navBottom + 76,
                  ),
                  SitePanel.capture => CapturePanel(
                    siteId: siteId,
                    scrollController: scrollController,
                    onShowOnTwin: _showOnTwin,
                    onClose: _showOnTwin,
                    bottomInset: keyboardOpen ? 12 : navBottom + 76,
                  ),
                  _ => AssistantPanel(
                    siteId: siteId,
                    scrollController: scrollController,
                    onShowOnTwin: _showOnTwin,
                    onClose: _showOnTwin,
                    bottomInset: keyboardOpen ? 8 : navBottom + 72,
                  ),
                },
              ),
            ),
          if (!keyboardOpen)
            Positioned(
              left: 12,
              right: 12,
              bottom: navBottom,
              child: _BottomNavigation(selected: _panel, onSelected: _openPanel),
            ),
        ],
      ),
    );
  }
}

/// Bottom panel with its own scroll controller. Scrolling the content never resizes the panel,
/// so a chat or form cannot collapse out of view; the handle resizes it explicitly.
class _PanelSheet extends StatefulWidget {
  const _PanelSheet({required this.initialFraction, required this.expanded, required this.builder, super.key});

  final double initialFraction;

  /// While the keyboard is up the panel uses almost all remaining height.
  final bool expanded;
  final Widget Function(ScrollController scrollController) builder;

  @override
  State<_PanelSheet> createState() => _PanelSheetState();
}

class _PanelSheetState extends State<_PanelSheet> {
  static const _minFraction = 0.4;
  static const _maxFraction = 0.94;
  final _scrollController = ScrollController();
  late double _fraction = widget.initialFraction;
  bool _dragging = false;

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _toggle() => setState(() => _fraction = _fraction < 0.8 ? _maxFraction : widget.initialFraction);

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final fraction = widget.expanded ? 0.96 : _fraction;
        return Align(
          alignment: Alignment.bottomCenter,
          child: AnimatedContainer(
            duration: _dragging ? Duration.zero : const Duration(milliseconds: 240),
            curve: Curves.easeOutCubic,
            height: constraints.maxHeight * fraction,
            child: GlassPanel(
              borderRadius: 26,
              child: Column(
                children: [
                  Semantics(
                    button: true,
                    label: 'Resize panel',
                    onTap: _toggle,
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: _toggle,
                      onVerticalDragStart: (_) => setState(() => _dragging = true),
                      onVerticalDragUpdate: (details) => setState(() {
                        _fraction = (_fraction - details.delta.dy / constraints.maxHeight).clamp(
                          _minFraction,
                          _maxFraction,
                        );
                      }),
                      onVerticalDragEnd: (_) => setState(() => _dragging = false),
                      child: const SizedBox(width: double.infinity, height: 22, child: SheetHandle()),
                    ),
                  ),
                  Expanded(child: widget.builder(_scrollController)),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _LoadingTwin extends StatelessWidget {
  const _LoadingTwin({required this.error, required this.loading, required this.onRetry});

  final String? error;
  final bool loading;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Color(0xFF0B1430), AppColors.background],
        ),
      ),
      child: Center(
        child: error != null && !loading
            ? Padding(
                padding: const EdgeInsets.all(24),
                child: GlassPanel(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Could not load this site', style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 8),
                      Text(
                        error!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
                      ),
                      const SizedBox(height: 16),
                      AppButton(
                        label: 'Try again',
                        icon: CupertinoIcons.arrow_clockwise,
                        tone: AppButtonTone.accent,
                        onPressed: () => unawaited(onRetry()),
                      ),
                    ],
                  ),
                ),
              )
            : const Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox.square(dimension: 34, child: CircularProgressIndicator(strokeWidth: 2.4)),
                  SizedBox(height: 16),
                  Text(
                    'BUILDING TWIN',
                    style: TextStyle(
                      color: AppColors.textDim,
                      fontSize: 11,
                      letterSpacing: 3,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}

class _SiteHeader extends StatelessWidget {
  const _SiteHeader({required this.title, required this.subtitle, required this.connection, required this.onBack});

  final String title;
  final String subtitle;
  final LiveConnectionState? connection;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final connected = connection == LiveConnectionState.connected;
    return GlassPanel(
      padding: const EdgeInsets.fromLTRB(6, 6, 14, 6),
      child: Row(
        children: [
          AppIconButton(icon: CupertinoIcons.chevron_left, tooltip: 'Back to sites', onPressed: onBack),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -0.2,
                  ),
                ),
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                ),
              ],
            ),
          ),
          Semantics(
            label: connected ? 'Live updates connected' : 'Live updates disconnected',
            child: Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: connected ? AppColors.ok : AppColors.textDim,
                boxShadow: connected ? const [BoxShadow(color: AppColors.ok, blurRadius: 8)] : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FloorBar extends StatelessWidget {
  const _FloorBar({
    required this.floors,
    required this.exploded,
    required this.focusFloorId,
    required this.onExploded,
    required this.onFocus,
    required this.onFrame,
  });

  final List<BuildingFloor> floors;
  final bool exploded;
  final String? focusFloorId;
  final ValueChanged<bool> onExploded;
  final ValueChanged<String?> onFocus;
  final VoidCallback onFrame;

  @override
  Widget build(BuildContext context) {
    final sorted = [...floors]..sort((a, b) => b.elevationM.compareTo(a.elevationM));
    return Align(
      alignment: Alignment.centerLeft,
      child: GlassPanel(
        padding: const EdgeInsets.all(4),
        borderRadius: 15,
        blur: false,
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              _Pill(
                label: exploded ? 'Exploded' : 'Stacked',
                icon: exploded ? CupertinoIcons.square_stack_3d_up_fill : CupertinoIcons.square_stack_3d_down_right,
                active: exploded,
                activeColor: AppColors.accent2,
                onTap: () => onExploded(!exploded),
              ),
              const _Divider(),
              _Pill(label: 'All', active: focusFloorId == null, onTap: () => onFocus(null)),
              for (final floor in sorted)
                _Pill(
                  label: floorLabel(floor),
                  monospace: true,
                  active: focusFloorId == floor.id,
                  semanticLabel: floor.displayName,
                  onTap: () => onFocus(focusFloorId == floor.id ? null : floor.id),
                ),
              const _Divider(),
              _Pill(icon: CupertinoIcons.viewfinder, semanticLabel: 'Frame building', onTap: onFrame),
            ],
          ),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({
    required this.onTap,
    this.label,
    this.icon,
    this.active = false,
    this.activeColor = AppColors.accent,
    this.monospace = false,
    this.semanticLabel,
  });

  final String? label;
  final IconData? icon;
  final bool active;
  final Color activeColor;
  final bool monospace;
  final String? semanticLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: active,
      label: semanticLabel ?? label,
      child: InkWell(
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        borderRadius: BorderRadius.circular(11),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: active ? activeColor.withValues(alpha: 0.22) : Colors.transparent,
            borderRadius: BorderRadius.circular(11),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) Icon(icon, size: 16, color: active ? Colors.white : AppColors.textMuted),
              if (icon != null && label != null) const SizedBox(width: 6),
              if (label != null)
                ExcludeSemantics(
                  child: Text(
                    label!,
                    style: TextStyle(
                      color: active ? Colors.white : AppColors.textMuted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      fontFamily: monospace ? 'Menlo' : null,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Divider extends StatelessWidget {
  const _Divider();

  @override
  Widget build(BuildContext context) =>
      Container(width: 1, height: 20, margin: const EdgeInsets.symmetric(horizontal: 4), color: AppColors.border);
}

class _RouteChip extends StatelessWidget {
  const _RouteChip({required this.route, required this.onClear});

  final RouteModel route;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final color = route.reachable ? AppColors.accent : AppColors.danger;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: GlassPanel(
        blur: false,
        borderRadius: 14,
        padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(route.reachable ? CupertinoIcons.location_fill : CupertinoIcons.nosign, size: 15, color: color),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                route.reachable
                    ? '${route.lengthM.toStringAsFixed(1)} m${route.stepFree ? ' · step-free' : ''}'
                    : (route.message ?? 'No route with these constraints'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
              ),
            ),
            AppIconButton(icon: CupertinoIcons.xmark, tooltip: 'Clear route', onPressed: onClear),
          ],
        ),
      ),
    );
  }
}

class _SelectionCard extends StatelessWidget {
  const _SelectionCard({
    required this.info,
    required this.onClose,
    this.onRoute,
    this.onFocusFloor,
    this.onToggleClosed,
  });

  final EntityInfo info;
  final VoidCallback onClose;
  final VoidCallback? onRoute;
  final VoidCallback? onFocusFloor;
  final VoidCallback? onToggleClosed;

  @override
  Widget build(BuildContext context) {
    final icon = switch (info.kind) {
      EntityKind.room => CupertinoIcons.square_grid_2x2,
      EntityKind.asset => CupertinoIcons.gear_alt,
      EntityKind.door => CupertinoIcons.rectangle_split_3x1,
      EntityKind.connector => CupertinoIcons.arrow_up_arrow_down,
      EntityKind.delivery => CupertinoIcons.cube_box,
    };
    return GlassPanel(
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(color: AppColors.accentSoft, borderRadius: BorderRadius.circular(10)),
                child: Icon(icon, size: 17, color: AppColors.accent),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      info.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600),
                    ),
                    Text(
                      info.subtitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                    ),
                  ],
                ),
              ),
              if (info.closed) const StatusBadge('CLOSED', color: AppColors.danger),
              AppIconButton(icon: CupertinoIcons.xmark, tooltip: 'Dismiss', onPressed: onClose),
            ],
          ),
          if (info.detail != null) ...[
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Text(info.detail!, style: const TextStyle(color: AppColors.text, fontSize: 12, height: 1.35)),
            ),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (onRoute != null)
                AppButton(
                  label: 'Route here',
                  icon: CupertinoIcons.location_north_fill,
                  tone: AppButtonTone.accent,
                  onPressed: onRoute,
                ),
              if (onToggleClosed != null)
                AppButton(
                  label: info.closed ? 'Reopen' : 'Close',
                  icon: info.closed ? CupertinoIcons.lock_open : CupertinoIcons.lock,
                  tone: info.closed ? AppButtonTone.ok : AppButtonTone.danger,
                  onPressed: onToggleClosed,
                ),
              if (onFocusFloor != null)
                AppButton(label: 'Focus floor', icon: CupertinoIcons.scope, onPressed: onFocusFloor),
            ],
          ),
        ],
      ),
    );
  }
}

class _BottomNavigation extends StatelessWidget {
  const _BottomNavigation({required this.selected, required this.onSelected});

  final SitePanel selected;
  final ValueChanged<SitePanel> onSelected;

  @override
  Widget build(BuildContext context) {
    const items = [
      (SitePanel.twin, 'Twin', CupertinoIcons.cube),
      (SitePanel.activity, 'Activity', CupertinoIcons.waveform_path_ecg),
      (SitePanel.capture, 'Capture', CupertinoIcons.camera_viewfinder),
      (SitePanel.ask, 'Ask', CupertinoIcons.sparkles),
    ];
    return GlassPanel(
      padding: const EdgeInsets.all(6),
      borderRadius: 22,
      child: Row(
        children: [
          for (final (panel, label, icon) in items)
            Expanded(
              child: Semantics(
                button: true,
                selected: selected == panel,
                label: label,
                child: InkWell(
                  onTap: () => onSelected(panel),
                  borderRadius: BorderRadius.circular(16),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 200),
                    height: 52,
                    decoration: BoxDecoration(
                      color: selected == panel ? AppColors.accentSoft : Colors.transparent,
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: ExcludeSemantics(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(icon, size: 20, color: selected == panel ? AppColors.accent : AppColors.textMuted),
                          const SizedBox(height: 3),
                          Text(
                            label,
                            style: TextStyle(
                              color: selected == panel ? const Color(0xFFE0F2FE) : AppColors.textMuted,
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
