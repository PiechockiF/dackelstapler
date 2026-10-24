import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../features/site/site_screen.dart';
import '../features/sites/sites_screen.dart';
import 'theme.dart';

final _router = GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const SitesScreen(),
      routes: [
        GoRoute(
          path: 'site/:id',
          pageBuilder: (context, state) => CustomTransitionPage(
            key: state.pageKey,
            child: SiteScreen(siteId: state.pathParameters['id']!),
            transitionDuration: const Duration(milliseconds: 420),
            reverseTransitionDuration: const Duration(milliseconds: 280),
            transitionsBuilder: (context, animation, secondaryAnimation, child) {
              final curved = CurvedAnimation(parent: animation, curve: Curves.easeOutCubic);
              return FadeTransition(
                opacity: curved,
                child: ScaleTransition(scale: Tween(begin: 1.04, end: 1.0).animate(curved), child: child),
              );
            },
          ),
        ),
      ],
    ),
  ],
);

class SiteTwinApp extends StatelessWidget {
  const SiteTwinApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'SiteTwin',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      routerConfig: _router,
    );
  }
}
