import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'models.dart';

sealed class LiveMessage {
  const LiveMessage();
}

class LiveSiteEvent extends LiveMessage {
  const LiveSiteEvent(this.event);

  final SiteEvent event;
}

class LiveCaptureProgress extends LiveMessage {
  const LiveCaptureProgress(this.job);

  final CaptureJob job;
}

enum LiveConnectionState { connecting, connected, disconnected }

/// Parses one `/ws` frame; unknown or malformed frames return null.
LiveMessage? parseLiveMessage(Object? frame) {
  if (frame is! String) return null;
  final Object? decoded;
  try {
    decoded = jsonDecode(frame);
  } on FormatException {
    return null;
  }
  if (decoded is! Map) return null;
  final payload = switch (decoded['type']) {
    'event' => decoded['event'],
    'capture_progress' => decoded['job'],
    _ => null,
  };
  if (payload is! Map) return null;
  final json = payload.map((key, value) => MapEntry(key.toString(), value));
  return decoded['type'] == 'event'
      ? LiveSiteEvent(SiteEvent.fromJson(json))
      : LiveCaptureProgress(CaptureJob.fromJson(json));
}

/// Reconnecting server-push client. Consumers filter messages by site.
class LiveClient {
  LiveClient(this.uri, {WebSocketChannel Function(Uri uri)? connect, Random? random})
    : _connect = connect ?? WebSocketChannel.connect,
      _random = random ?? Random();

  final Uri uri;
  final WebSocketChannel Function(Uri uri) _connect;
  final Random _random;
  final _messages = StreamController<LiveMessage>.broadcast();
  final _states = StreamController<LiveConnectionState>.broadcast();

  WebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  Timer? _retry;
  int _attempt = 0;
  int _generation = 0;
  bool _running = false;
  bool _disposed = false;
  LiveConnectionState _state = LiveConnectionState.disconnected;

  Stream<LiveMessage> get messages => _messages.stream;
  Stream<LiveConnectionState> get connectionStates => _states.stream;
  LiveConnectionState get connectionState => _state;

  static Duration backoff(int attempt, double jitter) {
    final base = min(30000, 500 * pow(2, min(attempt, 8)).toInt());
    return Duration(milliseconds: (base * (0.8 + 0.4 * jitter)).round());
  }

  void start() {
    if (_disposed || _running) return;
    _running = true;
    _attempt = 0;
    unawaited(_open());
  }

  void stop() {
    _running = false;
    _generation++;
    _retry?.cancel();
    _retry = null;
    _closeChannel();
    _setState(LiveConnectionState.disconnected);
  }

  /// Drops the current socket and reconnects immediately, e.g. after the app resumes.
  void restart() {
    if (_disposed) return;
    stop();
    start();
  }

  Future<void> dispose() async {
    if (_disposed) return;
    stop();
    _disposed = true;
    await _messages.close();
    await _states.close();
  }

  Future<void> _open() async {
    final generation = ++_generation;
    _setState(LiveConnectionState.connecting);
    WebSocketChannel? channel;
    try {
      channel = _connect(uri);
      await channel.ready;
    } catch (_) {
      unawaited(channel?.sink.close());
      if (generation == _generation) _scheduleRetry();
      return;
    }
    if (generation != _generation) {
      unawaited(channel.sink.close());
      return;
    }
    _channel = channel;
    _attempt = 0;
    _setState(LiveConnectionState.connected);
    _subscription = channel.stream.listen(
      (frame) {
        if (generation != _generation) return;
        final message = parseLiveMessage(frame);
        if (message != null && !_messages.isClosed) _messages.add(message);
      },
      onError: (Object _) {},
      onDone: () {
        if (generation != _generation) return;
        _closeChannel();
        _setState(LiveConnectionState.disconnected);
        _scheduleRetry();
      },
    );
  }

  void _scheduleRetry() {
    if (!_running || _disposed) return;
    _setState(LiveConnectionState.disconnected);
    final delay = backoff(_attempt++, _random.nextDouble());
    _retry?.cancel();
    _retry = Timer(delay, () {
      if (_running && !_disposed) unawaited(_open());
    });
  }

  void _closeChannel() {
    unawaited(_subscription?.cancel());
    _subscription = null;
    unawaited(_channel?.sink.close());
    _channel = null;
  }

  void _setState(LiveConnectionState state) {
    if (_state == state || _states.isClosed) return;
    _state = state;
    _states.add(state);
  }
}
