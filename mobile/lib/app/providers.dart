import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import '../core/live_client.dart';
import '../core/models.dart';

final appConfigProvider = Provider<AppConfig>((ref) => AppConfig());

final apiClientProvider = Provider<ApiClient>((ref) {
  final client = ApiClient(ref.watch(appConfigProvider));
  ref.onDispose(client.close);
  return client;
});

final liveClientProvider = Provider<LiveClient>((ref) {
  final client = LiveClient(ref.watch(appConfigProvider).webSocketUri)..start();
  ref.onDispose(client.dispose);
  return client;
});

final liveConnectionProvider = StreamProvider<LiveConnectionState>((ref) async* {
  final client = ref.watch(liveClientProvider);
  yield client.connectionState;
  yield* client.connectionStates;
});

final sitesProvider = FutureProvider<List<Site>>((ref) => ref.watch(apiClientProvider).sites());
