import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class TwinSurfaceController {
  TwinSurfaceController(this._channel);

  final MethodChannel _channel;

  Future<void> frameAll() => _channel.invokeMethod<void>('frameAll');

  Future<void> setRenderingActive(bool active) => _channel.invokeMethod<void>('setRenderingActive', {'active': active});
}

class TwinSurface extends StatefulWidget {
  const TwinSurface({
    required this.building,
    required this.onEntityTapped,
    super.key,
    this.state,
    this.route,
    this.exploded = true,
    this.focusFloorId,
    this.highlightIds = const [],
    this.selectedId,
    this.timelineVisibleIds,
    this.onController,
    this.onRendererError,
  });

  final Map<String, dynamic> building;
  final Map<String, dynamic>? state;
  final Map<String, dynamic>? route;
  final bool exploded;
  final String? focusFloorId;
  final List<String> highlightIds;
  final String? selectedId;
  final List<String>? timelineVisibleIds;

  /// Receives the tapped room/asset/delivery/closure id, or `''` when nothing was hit.
  final ValueChanged<String> onEntityTapped;
  final ValueChanged<TwinSurfaceController>? onController;
  final ValueChanged<String>? onRendererError;

  @override
  State<TwinSurface> createState() => _TwinSurfaceState();
}

class _TwinSurfaceState extends State<TwinSurface> with WidgetsBindingObserver {
  MethodChannel? _channel;
  bool _active = true;

  Map<String, dynamic> get _arguments => {
    'building': widget.building,
    'state': widget.state,
    'route': widget.route,
    'exploded': widget.exploded,
    'focusFloorId': widget.focusFloorId,
    'highlightIds': widget.highlightIds,
    'selectedId': widget.selectedId,
    'timelineVisibleIds': widget.timelineVisibleIds,
  };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didUpdateWidget(TwinSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_channel == null) return;
    final changed =
        !identical(oldWidget.building, widget.building) ||
        !identical(oldWidget.state, widget.state) ||
        !identical(oldWidget.route, widget.route) ||
        oldWidget.exploded != widget.exploded ||
        oldWidget.focusFloorId != widget.focusFloorId ||
        !listEquals(oldWidget.highlightIds, widget.highlightIds) ||
        oldWidget.selectedId != widget.selectedId ||
        !listEquals(oldWidget.timelineVisibleIds, widget.timelineVisibleIds);
    if (!changed) return;
    final arguments = _arguments;
    if (identical(oldWidget.building, widget.building)) {
      arguments.remove('building');
    }
    unawaited(_invoke('sync', arguments));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final active = state == AppLifecycleState.resumed;
    if (active == _active) return;
    _active = active;
    unawaited(_invoke('setRenderingActive', {'active': active}));
  }

  Future<void> _invoke(String method, [Object? arguments]) async {
    final channel = _channel;
    if (channel == null) return;
    try {
      await channel.invokeMethod<void>(method, arguments);
    } on PlatformException catch (error) {
      widget.onRendererError?.call(error.message ?? 'Native twin failed.');
    } on MissingPluginException {
      widget.onRendererError?.call('Native twin is unavailable in this build.');
    }
  }

  Future<void> _onMethodCall(MethodCall call) async {
    switch (call.method) {
      case 'entityTapped':
        final id = call.arguments;
        if (id is String) widget.onEntityTapped(id);
      case 'rendererError':
        widget.onRendererError?.call(call.arguments?.toString() ?? 'Native twin failed.');
    }
  }

  void _onCreated(int id) {
    final channel = MethodChannel('sitetwin/twin/$id');
    channel.setMethodCallHandler(_onMethodCall);
    _channel = channel;
    widget.onController?.call(TwinSurfaceController(channel));
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: Semantics(
        label: 'Interactive 3D building twin. Drag to orbit, pinch to zoom, tap a room or asset for details.',
        container: true,
        child: UiKitView(
          viewType: 'sitetwin/twin',
          creationParams: _arguments,
          creationParamsCodec: const StandardMessageCodec(),
          onPlatformViewCreated: _onCreated,
          gestureRecognizers: const <Factory<OneSequenceGestureRecognizer>>{
            Factory<OneSequenceGestureRecognizer>(EagerGestureRecognizer.new),
          },
        ),
      ),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    final channel = _channel;
    _channel = null;
    if (channel != null) {
      unawaited(channel.invokeMethod<void>('dispose'));
      channel.setMethodCallHandler(null);
    }
    super.dispose();
  }
}
