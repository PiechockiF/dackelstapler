import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:sitetwin/core/config.dart';
import 'package:sitetwin/core/live_client.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

class _FakeSocket extends StreamChannelMixin<dynamic> implements WebSocketChannel {
  final incoming = StreamController<dynamic>();
  final outgoing = StreamController<dynamic>();

  @override
  Stream<dynamic> get stream => incoming.stream;

  @override
  WebSocketSink get sink => _FakeSink(outgoing, incoming);

  @override
  Future<void> get ready => Future.value();

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;
}

class _FakeSink implements WebSocketSink {
  _FakeSink(this._out, this._in);

  final StreamController<dynamic> _out;
  final StreamController<dynamic> _in;

  @override
  void add(dynamic data) => _out.add(data);

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<dynamic> stream) => stream.drain<void>();

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    if (!_in.isClosed) await _in.close();
  }

  @override
  Future<void> get done => _in.done;
}

void main() {
  group('AppConfig', () {
    test('normalises the base URL and derives the WebSocket endpoint', () {
      final config = AppConfig(apiBaseUrl: 'http://my-mac.local:8000/');
      expect(config.apiBaseUrl, 'http://my-mac.local:8000');
      expect(config.webSocketUri.toString(), 'ws://my-mac.local:8000/ws');
      expect(AppConfig(apiBaseUrl: 'https://twin.example.com').webSocketUri.scheme, 'wss');
    });

    test('resolves storage paths and keeps absolute URLs', () {
      final config = AppConfig(apiBaseUrl: 'http://10.0.0.5:8000');
      expect(config.resolve('/storage/a.glb').toString(), 'http://10.0.0.5:8000/storage/a.glb');
      expect(config.resolve('storage/a.glb').toString(), 'http://10.0.0.5:8000/storage/a.glb');
      expect(config.resolve('https://cdn.example.com/x.png').host, 'cdn.example.com');
    });

    test('rejects URLs that are not absolute http(s)', () {
      expect(() => AppConfig(apiBaseUrl: 'my-mac.local:8000'), throwsArgumentError);
      expect(() => AppConfig(apiBaseUrl: 'ftp://host'), throwsArgumentError);
    });
  });

  group('parseLiveMessage', () {
    test('parses site events and capture progress', () {
      final event = parseLiveMessage(
        '{"type": "event", "event": {"id": "e1", "site_id": "s1", "type": "closure", "title": "Office lift closed", '
        '"ts": "2026-10-24T11:41:00Z", "payload": {"element_id": "lift-office"}}}',
      );
      expect(event, isA<LiveSiteEvent>());
      expect((event as LiveSiteEvent).event.payload['element_id'], 'lift-office');

      final progress = parseLiveMessage(
        '{"type": "capture_progress", "job": {"id": "j1", "site_id": "s1", '
        '"kind": "delivery", "status": "measuring", "progress": 0.4}}',
      );
      expect((progress as LiveCaptureProgress).job.progress, 0.4);
    });

    test('ignores unknown or malformed frames', () {
      expect(parseLiveMessage('{"type": "hello"}'), isNull);
      expect(parseLiveMessage('not json'), isNull);
      expect(parseLiveMessage(42), isNull);
    });
  });

  test('backoff grows exponentially with jitter and stays bounded', () {
    expect(LiveClient.backoff(0, 0.5).inMilliseconds, 500);
    expect(LiveClient.backoff(3, 0.5).inMilliseconds, 4000);
    expect(LiveClient.backoff(20, 1).inMilliseconds, lessThanOrEqualTo(36000));
    expect(LiveClient.backoff(1, 0).inMilliseconds, 800);
  });

  test('live client delivers messages, reconnects and stops cleanly', () async {
    final sockets = <_FakeSocket>[];
    final client = LiveClient(
      Uri.parse('ws://test/ws'),
      connect: (_) {
        final socket = _FakeSocket();
        sockets.add(socket);
        return socket;
      },
      random: Random(1),
    );
    final messages = <LiveMessage>[];
    final subscription = client.messages.listen(messages.add);

    client.start();
    await pumpEventQueue();
    expect(sockets, hasLength(1));
    expect(client.connectionState, LiveConnectionState.connected);

    sockets.first.incoming.add('{"type": "capture_progress", "job": {"id": "j1", "progress": 1, "status": "done"}}');
    await pumpEventQueue();
    expect(messages.single, isA<LiveCaptureProgress>());

    await sockets.first.incoming.close();
    await pumpEventQueue();
    expect(client.connectionState, LiveConnectionState.disconnected);

    client.restart();
    await pumpEventQueue();
    expect(sockets, hasLength(2));
    expect(client.connectionState, LiveConnectionState.connected);

    await client.dispose();
    await pumpEventQueue();
    expect(sockets.last.incoming.isClosed, isTrue, reason: 'dispose closes the socket');
    expect(client.connectionState, LiveConnectionState.disconnected);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(sockets, hasLength(2), reason: 'no reconnect after dispose');
    expect(messages, hasLength(1));
    await subscription.cancel();
  });
}
