// End-to-end check against a running backend, on a simulator or a connected iPhone:
//
//   flutter test integration_test/app_flow_test.dart -d <device> \
//     --dart-define=SITETWIN_API_URL=http://<mac>.local:8000
//
// It changes the hero site's state (lift closure, then reopening), so use a demo backend.
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sitetwin/app/app.dart';
import 'package:sitetwin/core/api_client.dart';
import 'package:sitetwin/core/config.dart';

const _heroSiteId = 'proc-factory-dev-003';

Future<void> _pumpUntil(WidgetTester tester, Finder finder, {Duration timeout = const Duration(seconds: 30)}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 200));
    if (finder.evaluate().isNotEmpty) return;
  }
  throw TestFailure('Timed out waiting for $finder');
}

Future<void> _hold(WidgetTester tester, String marker, [Duration duration = const Duration(seconds: 4)]) async {
  debugPrint('STEP $marker');
  final end = DateTime.now().add(duration);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('hero site: twin, step-free route and live lift closure re-planning', (tester) async {
    final api = ApiClient(AppConfig());
    final building = await api.building(_heroSiteId);
    final lift = building.connectors.firstWhere((connector) => connector.kind == 'lift');
    await api.setClosed(_heroSiteId, lift.id, closed: false);

    await tester.pumpWidget(const ProviderScope(child: SiteTwinApp()));
    await _pumpUntil(tester, find.text('Fertigung Ost 27'));
    expect(find.text('LIVE'), findsWidgets);
    await _hold(tester, 'sites');

    await tester.tap(find.text('Fertigung Ost 27').first);
    await _pumpUntil(tester, find.text('2 floors · 79 spaces · 505 assets'));
    await _hold(tester, 'twin', const Duration(seconds: 6));

    await tester.tap(find.text('L1'));
    await _hold(tester, 'focus-l1');
    await tester.tap(find.text('All'));
    await tester.pump(const Duration(seconds: 1));

    await tester.tap(find.text('Activity'));
    await _pumpUntil(tester, find.text('Changes'));
    await _hold(tester, 'activity');

    await tester.tap(find.text('Route').first);
    await _pumpUntil(tester, find.widgetWithText(TextField, 'To'));
    await tester.tap(find.byType(CupertinoSwitch));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To'), 'Quality lab 0.21');
    // Submitting from the keyboard ("Go") plans the route, like a user would.
    await tester.testTextInput.receiveAction(TextInputAction.go);
    await _pumpUntil(tester, find.text('STEP-FREE'));

    await tester.pump(const Duration(seconds: 1));
    await tester.ensureVisible(find.text('Show on twin'));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('Show on twin'));
    final reachable = find.byIcon(CupertinoIcons.location_fill);
    final blocked = find.byIcon(CupertinoIcons.nosign);
    await _pumpUntil(tester, reachable);
    await _hold(tester, 'route', const Duration(seconds: 6));

    // A closure made elsewhere arrives over the WebSocket and the route is re-planned.
    await api.setClosed(_heroSiteId, lift.id, closed: true);
    await _pumpUntil(tester, blocked, timeout: const Duration(seconds: 20));
    await _hold(tester, 'lift-closed');

    await api.setClosed(_heroSiteId, lift.id, closed: false);
    await _pumpUntil(tester, reachable, timeout: const Duration(seconds: 20));
    await _hold(tester, 'lift-reopened');
    api.close();
  });
}
