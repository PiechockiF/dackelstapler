import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sitetwin/app/providers.dart';
import 'package:sitetwin/core/api_client.dart';
import 'package:sitetwin/core/config.dart';
import 'package:sitetwin/core/live_client.dart';
import 'package:sitetwin/core/models.dart';
import 'package:sitetwin/core/sse.dart';
import 'package:sitetwin/features/assistant/chat_controller.dart';
import 'package:sitetwin/features/site/site_session.dart';

class _FakeApi extends ApiClient {
  _FakeApi() : super(AppConfig(apiBaseUrl: 'http://twin.test'));

  static const _offline = ApiException('offline in tests');

  @override
  Future<Building> building(String siteId) => Future.error(_offline);

  @override
  Future<SiteState> state(String siteId) => Future.error(_offline);

  @override
  Future<List<SiteEvent>> events(String siteId, {int limit = 200}) => Future.error(_offline);

  @override
  Stream<ChatStreamEvent> streamChat({
    required String siteId,
    required String sessionId,
    required String message,
    String? here,
    CancelToken? cancelToken,
  }) async* {
    yield const ChatActionEvent(ChatAction(type: 'understood', raw: {}, chips: ['to: Office lift']));
    yield const ChatDelta('The office lift ');
    yield const ChatDelta('is next to Office 1.04.');
    yield const ChatDone('The office lift is next to Office 1.04.');
  }
}

void main() {
  test('conversation stays available after the panel stops listening', () async {
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(_FakeApi()),
        liveClientProvider.overrideWithValue(
          LiveClient(Uri.parse('ws://twin.test/ws'), connect: (_) => throw StateError('offline')),
        ),
      ],
    );
    addTearDown(container.dispose);

    final subscription = container.listen(siteSessionProvider('site-1'), (_, _) {});
    final panel = container.listen(chatControllerProvider('site-1'), (_, _) {});
    container.read(chatControllerProvider('site-1').notifier).toggleMuted();
    await container.read(chatControllerProvider('site-1').notifier).send('Where is the lift?');

    // The assistant panel closes: nothing watches the chat any more.
    panel.close();
    await Future<void>.delayed(const Duration(milliseconds: 10));

    final messages = container.read(chatControllerProvider('site-1')).messages;
    expect(messages.map((message) => message.text), ['Where is the lift?', 'The office lift is next to Office 1.04.']);
    expect(messages.last.chips, ['to: Office lift']);
    expect(messages.last.pending, isFalse);
    subscription.close();
  });
}
