import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api_client.dart';
import '../../core/live_client.dart';
import '../../core/models.dart';

enum NoticeTone { info, ok, warn }

class SessionNotice {
  const SessionNotice(this.id, this.text, this.tone);

  final int id;
  final String text;
  final NoticeTone tone;
}

const _keep = Object();

class SiteSessionState {
  const SiteSessionState({
    this.building,
    this.siteState,
    this.events = const [],
    this.route,
    this.originId,
    this.exploded = true,
    this.focusFloorId,
    this.selectedId,
    this.highlightIds = const [],
    this.highlightLabel,
    this.timelineTs,
    this.loading = true,
    this.error,
    this.captureJob,
    this.notice,
  });

  final Building? building;
  final SiteState? siteState;
  final List<SiteEvent> events;
  final RouteModel? route;
  final String? originId;
  final bool exploded;
  final String? focusFloorId;
  final String? selectedId;
  final List<String> highlightIds;
  final String? highlightLabel;
  final DateTime? timelineTs;
  final bool loading;
  final String? error;
  final CaptureJob? captureJob;
  final SessionNotice? notice;

  /// Deliveries present at the scrubbed timeline position; null while live.
  List<String>? get visibleDeliveryIds {
    final timestamp = timelineTs;
    final deliveries = siteState?.deliveries;
    if (timestamp == null || deliveries == null) return null;
    return [
      for (final delivery in deliveries)
        if (!(delivery.time?.isAfter(timestamp) ?? false)) delivery.id,
    ];
  }

  SiteSessionState copyWith({
    Object? building = _keep,
    Object? siteState = _keep,
    List<SiteEvent>? events,
    Object? route = _keep,
    Object? originId = _keep,
    bool? exploded,
    Object? focusFloorId = _keep,
    Object? selectedId = _keep,
    List<String>? highlightIds,
    Object? highlightLabel = _keep,
    Object? timelineTs = _keep,
    bool? loading,
    Object? error = _keep,
    Object? captureJob = _keep,
    Object? notice = _keep,
  }) => SiteSessionState(
    building: identical(building, _keep) ? this.building : building as Building?,
    siteState: identical(siteState, _keep) ? this.siteState : siteState as SiteState?,
    events: events ?? this.events,
    route: identical(route, _keep) ? this.route : route as RouteModel?,
    originId: identical(originId, _keep) ? this.originId : originId as String?,
    exploded: exploded ?? this.exploded,
    focusFloorId: identical(focusFloorId, _keep) ? this.focusFloorId : focusFloorId as String?,
    selectedId: identical(selectedId, _keep) ? this.selectedId : selectedId as String?,
    highlightIds: highlightIds ?? this.highlightIds,
    highlightLabel: identical(highlightLabel, _keep) ? this.highlightLabel : highlightLabel as String?,
    timelineTs: identical(timelineTs, _keep) ? this.timelineTs : timelineTs as DateTime?,
    loading: loading ?? this.loading,
    error: identical(error, _keep) ? this.error : error as String?,
    captureJob: identical(captureJob, _keep) ? this.captureJob : captureJob as CaptureJob?,
    notice: identical(notice, _keep) ? this.notice : notice as SessionNotice?,
  );
}

/// Mirrors the web viewer's default: the demo factory starts upstairs, otherwise a lobby or entrance.
String? defaultOrigin(Building building) {
  if (building.id == 'proc-factory-dev-003') {
    for (final space in building.spaces) {
      if (space.name == 'Office 1.04') return space.id;
    }
  }
  final groundFloors = {
    for (final floor in building.floors)
      if (floor.level == 0) floor.id,
  };
  for (final space in building.spaces) {
    if (space.roomType == 'lobby' && groundFloors.contains(space.floorId)) return space.id;
  }
  for (final opening in building.openings) {
    if (opening.spaceIds.contains('outside') && opening.stepFree) {
      for (final id in opening.spaceIds) {
        if (id != 'outside') return id;
      }
    }
  }
  return building.spaces.isEmpty ? null : building.spaces.first.id;
}

final siteSessionProvider = NotifierProvider.autoDispose.family<SiteSessionController, SiteSessionState, String>(
  SiteSessionController.new,
);

class SiteSessionController extends Notifier<SiteSessionState> {
  SiteSessionController(this.siteId);

  final String siteId;
  StreamSubscription<LiveMessage>? _live;
  Timer? _refreshTimer;
  Timer? _jobPoll;
  int _loadGeneration = 0;
  int _routeGeneration = 0;
  int _noticeId = 0;

  ApiClient get _api => ref.read(apiClientProvider);

  @override
  SiteSessionState build() {
    _live = ref.read(liveClientProvider).messages.listen(_onLive);
    ref.onDispose(() {
      unawaited(_live?.cancel());
      _refreshTimer?.cancel();
      _jobPoll?.cancel();
    });
    Future.microtask(load);
    return const SiteSessionState();
  }

  Future<void> load() async {
    final generation = ++_loadGeneration;
    state = state.copyWith(loading: true, error: null);
    try {
      final building = await _api.building(siteId);
      if (!ref.mounted || generation != _loadGeneration) return;
      state = state.copyWith(building: building, originId: state.originId ?? defaultOrigin(building), loading: false);
      final results = await Future.wait<Object?>([
        _api.state(siteId).then<Object?>((value) => value, onError: (Object _) => null),
        _api.events(siteId).then<Object?>((value) => value, onError: (Object _) => null),
      ]);
      if (!ref.mounted || generation != _loadGeneration) return;
      state = state.copyWith(
        siteState: results[0] as SiteState? ?? state.siteState,
        events: results[1] as List<SiteEvent>? ?? state.events,
      );
    } on ApiException catch (error) {
      if (!ref.mounted || generation != _loadGeneration) return;
      state = state.copyWith(loading: false, error: error.message);
    }
  }

  /// Re-syncs after the app returns to the foreground.
  Future<void> resync() async {
    if (state.building == null) return load();
    await refreshState();
    try {
      final events = await _api.events(siteId);
      if (ref.mounted) state = state.copyWith(events: events);
    } on ApiException {
      // Keep the last known feed.
    }
  }

  Future<void> refreshState() async {
    try {
      final next = await _api.state(siteId);
      if (!ref.mounted) return;
      state = state.copyWith(siteState: next);
      await replan();
    } on ApiException {
      // Transient server hiccup: keep the previous state.
    }
  }

  void _scheduleRefresh() {
    _refreshTimer?.cancel();
    _refreshTimer = Timer(const Duration(milliseconds: 150), () => unawaited(refreshState()));
  }

  void _onLive(LiveMessage message) {
    if (!ref.mounted) return;
    switch (message) {
      case LiveSiteEvent(:final event) when event.siteId == siteId:
        if (!state.events.any((existing) => existing.id == event.id)) {
          state = state.copyWith(events: [event, ...state.events]);
        }
        _scheduleRefresh();
        if (event.type == 'door_added') unawaited(_reloadBuilding());
        final delivery = event.delivery;
        if (delivery != null && delivery.id.isNotEmpty) {
          state = state.copyWith(highlightIds: [delivery.id], highlightLabel: delivery.label);
          _notify(event.title, delivery.status == 'ok' ? NoticeTone.ok : NoticeTone.warn);
        } else {
          _notify(event.title, NoticeTone.info);
        }
      case LiveCaptureProgress(:final job) when job.siteId == siteId:
        _applyJob(job);
      default:
        break;
    }
  }

  Future<void> _reloadBuilding() async {
    try {
      final building = await _api.building(siteId);
      if (ref.mounted) state = state.copyWith(building: building);
    } on ApiException {
      // The next full load will pick up the new geometry.
    }
  }

  // Routing ------------------------------------------------------------------

  Future<RouteModel> navigate({
    required String to,
    String? from,
    bool stepFree = false,
    double? minWidthM,
    List<String>? via,
  }) async {
    final building = state.building;
    final origin = from ?? state.originId ?? (building == null ? null : defaultOrigin(building));
    if (origin == null) throw const ApiException('No start point is known for this site.');
    final generation = ++_routeGeneration;
    final route = await _api.route(siteId, from: origin, to: to, stepFree: stepFree, minWidthM: minWidthM, via: via);
    if (ref.mounted && generation == _routeGeneration) {
      state = state.copyWith(route: route, focusFloorId: null, originId: origin, selectedId: null);
    }
    return route;
  }

  /// Re-runs the current route with its endpoints and constraints, also after it became unreachable.
  Future<void> replan() async {
    final route = state.route;
    if (route == null) return;
    final from = route.fromSpaceId ?? (route.spacePath.isEmpty ? null : route.spacePath.first);
    final to = route.toSpaceId ?? (route.spacePath.length < 2 ? null : route.spacePath.last);
    if (from == null || to == null) return;
    final generation = ++_routeGeneration;
    try {
      final next = await _api.route(
        siteId,
        from: from,
        to: to,
        stepFree: route.stepFree,
        minWidthM: route.minWidthM,
        via: route.via,
      );
      if (ref.mounted && generation == _routeGeneration && identical(state.route, route)) {
        state = state.copyWith(route: next);
      }
    } on ApiException {
      // Keep showing the previous route.
    }
  }

  void clearRoute() {
    _routeGeneration++;
    state = state.copyWith(route: null);
  }

  Future<void> setClosed(String elementId, {required bool closed}) async {
    final next = await _api.setClosed(siteId, elementId, closed: closed);
    if (!ref.mounted) return;
    state = state.copyWith(siteState: next);
    await replan();
  }

  // Viewer state ---------------------------------------------------------------

  void setExploded(bool exploded) => state = state.copyWith(exploded: exploded);

  void focusFloor(String? floorId) => state = state.copyWith(focusFloorId: floorId);

  void select(String? id) => state = state.copyWith(selectedId: id == null || id.isEmpty ? null : id);

  void highlight(List<String> ids, {String? label}) =>
      state = state.copyWith(highlightIds: ids, highlightLabel: label, focusFloorId: null);

  void clearHighlight() => state = state.copyWith(highlightIds: const [], highlightLabel: null);

  void setOrigin(String spaceId) => state = state.copyWith(originId: spaceId);

  void setTimeline(DateTime? timestamp) => state = state.copyWith(timelineTs: timestamp);

  void applyChatAction(ChatAction action) {
    switch (action.type) {
      case 'set_location':
        if (action.spaceId != null) state = state.copyWith(originId: action.spaceId);
      case 'show_route':
        if (action.route != null) {
          _routeGeneration++;
          state = state.copyWith(route: action.route, focusFloorId: null);
        }
      case 'highlight':
        state = state.copyWith(highlightIds: action.ids, highlightLabel: action.label);
      case 'focus_floor':
        state = state.copyWith(focusFloorId: action.floorId);
      case 'state_changed':
        unawaited(refreshState());
    }
  }

  // Bookings -------------------------------------------------------------------

  Future<List<BookableRoom>> bookableRooms({required DateTime start, required DateTime end, required int people}) =>
      _api.bookableRooms(siteId, start: start, end: end, people: people, near: state.originId);

  Future<Booking> book(BookableRoom room, {required DateTime start, required DateTime end, required int people}) async {
    final booking = await _api.book(
      siteId,
      spaceId: room.spaceId,
      start: start,
      end: end,
      who: 'SiteTwin iOS',
      title: 'Meeting ($people people)',
    );
    if (ref.mounted) {
      state = state.copyWith(highlightIds: [room.spaceId], highlightLabel: 'Booked: ${room.displayName}');
    }
    return booking;
  }

  // Capture --------------------------------------------------------------------

  Future<void> captureDelivery({
    required List<String> photoPaths,
    Dimensions? declared,
    String? targetSpaceId,
    String? label,
    String? note,
    void Function(double fraction)? onUpload,
  }) async {
    final job = await _api.captureDelivery(
      siteId: siteId,
      photoPaths: photoPaths,
      declared: declared,
      targetSpaceId: targetSpaceId,
      label: label,
      note: note,
      onSendProgress: (sent, total) {
        if (total > 0) onUpload?.call(sent / total);
      },
    );
    _track(job);
  }

  Future<void> captureRoom({
    required String spaceId,
    String? videoPath,
    void Function(double fraction)? onUpload,
  }) async {
    final job = await _api.captureRoom(
      siteId: siteId,
      spaceId: spaceId,
      videoPath: videoPath,
      onSendProgress: (sent, total) {
        if (total > 0) onUpload?.call(sent / total);
      },
    );
    _track(job);
  }

  void dismissCaptureJob() {
    _jobPoll?.cancel();
    state = state.copyWith(captureJob: null);
  }

  void _track(CaptureJob job) {
    if (!ref.mounted) return;
    state = state.copyWith(captureJob: job);
    _applyJob(job);
    if (job.isTerminal) return;
    _jobPoll?.cancel();
    _jobPoll = Timer.periodic(const Duration(milliseconds: 1500), (timer) async {
      final current = state.captureJob;
      if (!ref.mounted || current == null || current.id != job.id || current.isTerminal) {
        timer.cancel();
        return;
      }
      try {
        final polled = await _api.captureJob(job.id);
        if (ref.mounted) _applyJob(polled);
      } on ApiException {
        // Keep polling; the WebSocket may still deliver progress.
      }
    });
  }

  void _applyJob(CaptureJob job) {
    final current = state.captureJob;
    if (current == null || current.id != job.id) return;
    if (!identical(current, job)) {
      if (current.isDone) return;
      if (job.progress < current.progress && !job.isTerminal) return;
      state = state.copyWith(captureJob: job);
    }
    if (!job.isTerminal) return;
    _jobPoll?.cancel();
    if (job.isDone) {
      _scheduleRefresh();
      final delivery = job.deliveryResult;
      final scan = job.roomScanResult;
      if (delivery != null) {
        state = state.copyWith(highlightIds: [delivery.id], highlightLabel: delivery.label);
      } else if (scan != null) {
        state = state.copyWith(highlightIds: [scan.spaceId], highlightLabel: 'Room scan');
      }
    }
  }

  void _notify(String text, NoticeTone tone) {
    if (text.isEmpty) return;
    state = state.copyWith(notice: SessionNotice(++_noticeId, text, tone));
  }
}
