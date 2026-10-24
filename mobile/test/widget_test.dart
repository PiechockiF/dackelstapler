import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sitetwin/app/theme.dart';
import 'package:sitetwin/core/models.dart';
import 'package:sitetwin/features/sites/sites_screen.dart';
import 'package:sitetwin/features/twin/timeline_bar.dart';

Widget _host(Widget child) => MaterialApp(
  theme: buildAppTheme(),
  home: Scaffold(body: Center(child: child)),
);

void main() {
  testWidgets('site card shows the site and reacts to taps', (tester) async {
    var tapped = false;
    final site = Site.fromJson(const {
      'id': 'proc-factory-dev-003',
      'name': 'Fertigung Ost 27',
      'kind': 'factory',
      'floors': 2,
      'demo_location': true,
    });
    await tester.pumpWidget(_host(SiteCard(site: site, onTap: () => tapped = true)));

    expect(find.text('Fertigung Ost 27'), findsOneWidget);
    expect(find.text('Factory · 2 floors'), findsOneWidget);
    expect(find.text('DEMO'), findsOneWidget);
    await tester.tap(find.text('Fertigung Ost 27'));
    expect(tapped, isTrue);
  });

  testWidgets('timeline is live until the user scrubs back', (tester) async {
    DateTime? selected = DateTime(2000);
    await tester.pumpWidget(
      _host(
        SizedBox(
          width: 380,
          child: TimelineBar(
            ticks: [
              TimelineTick(id: 'e1', timestamp: DateTime.now().subtract(const Duration(days: 1)), type: 'delivery'),
            ],
            timestamp: null,
            onChanged: (value) => selected = value,
          ),
        ),
      ),
    );

    expect(find.text('LIVE'), findsOneWidget);
    await tester.drag(find.byType(Slider), const Offset(-120, 0));
    await tester.pump();
    expect(selected, isNotNull);
    expect(selected!.isBefore(DateTime.now()), isTrue);
  });
}
