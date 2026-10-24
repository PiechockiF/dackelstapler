import 'dart:async';
import 'dart:math';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../app/widgets.dart';
import '../../core/live_client.dart';
import '../../core/models.dart';

const _styleUrl = 'https://tiles.openfreemap.org/styles/dark';
const _munich = LatLng(48.165, 11.575);

const kindColors = <String, Color>{
  'factory': Color(0xFFF59E0B),
  'campus': Color(0xFF38BDF8),
  'office': Color(0xFFA78BFA),
  'airport': Color(0xFF34D399),
  'mall': Color(0xFFF472B6),
  'other': Color(0xFF94A3B8),
};

String _hex(Color color) => '#${(color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

class SitesScreen extends ConsumerStatefulWidget {
  const SitesScreen({super.key});

  @override
  ConsumerState<SitesScreen> createState() => _SitesScreenState();
}

class _SitesScreenState extends ConsumerState<SitesScreen> {
  MapLibreMapController? _map;
  bool _styleLoaded = false;
  bool _introPlayed = false;
  List<Site>? _plotted;
  String _query = '';
  String? _selectedId;
  bool _opening = false;

  @override
  void dispose() {
    _map?.onCircleTapped.remove(_onCircleTapped);
    super.dispose();
  }

  void _onCircleTapped(Circle circle) {
    final siteId = circle.data?['siteId'];
    final sites = ref.read(sitesProvider).value;
    if (siteId is! String || sites == null) return;
    for (final site in sites) {
      if (site.id == siteId) {
        unawaited(_select(site));
        return;
      }
    }
  }

  Future<void> _plot(List<Site> sites) async {
    final map = _map;
    if (map == null || !_styleLoaded || identical(_plotted, sites)) return;
    _plotted = sites;
    try {
      await map.clearCircles();
      await map.addCircles(
        [
          for (final site in sites)
            CircleOptions(
              geometry: LatLng(site.lat, site.lon),
              circleRadius: 6,
              circleColor: _hex(kindColors[site.kind] ?? kindColors['other']!),
              circleStrokeColor: '#E0F2FE',
              circleStrokeWidth: 1.5,
              circleStrokeOpacity: 0.8,
              circleBlur: 0.15,
            ),
        ],
        [
          for (final site in sites) {'siteId': site.id},
        ],
      );
    } on Exception {
      // The style is (re)loading and its annotation managers are being rebuilt;
      // onStyleLoadedCallback plots again once they are ready.
      if (identical(_plotted, sites)) _plotted = null;
    }
  }

  Future<void> _introFlight() async {
    await Future<void>.delayed(const Duration(milliseconds: 600));
    if (!mounted || _selectedId != null) return;
    await _map?.animateCamera(
      CameraUpdate.newCameraPosition(const CameraPosition(target: _munich, zoom: 10.2, tilt: 50, bearing: -18)),
      duration: const Duration(milliseconds: 2400),
    );
  }

  Future<void> _select(Site site) async {
    HapticFeedback.selectionClick();
    setState(() => _selectedId = site.id);
    await _map?.animateCamera(
      CameraUpdate.newCameraPosition(
        CameraPosition(target: LatLng(site.lat, site.lon), zoom: 16.2, tilt: 58, bearing: -30),
      ),
      duration: const Duration(milliseconds: 1400),
    );
  }

  Future<void> _open(Site site) async {
    if (_opening) return;
    _opening = true;
    await _select(site);
    await Future<void>.delayed(const Duration(milliseconds: 900));
    if (!mounted) return;
    _opening = false;
    context.go('/site/${Uri.encodeComponent(site.id)}');
  }

  @override
  Widget build(BuildContext context) {
    final sites = ref.watch(sitesProvider);
    final connection = ref.watch(liveConnectionProvider).value;
    ref.listen(sitesProvider, (_, next) {
      final value = next.value;
      if (value != null) unawaited(_plot(value));
    });
    final padding = MediaQuery.paddingOf(context);
    return Scaffold(
      backgroundColor: AppColors.background,
      resizeToAvoidBottomInset: false,
      body: Stack(
        children: [
          Positioned.fill(
            child: MapLibreMap(
              styleString: _styleUrl,
              // Pitch is applied after the style loads: an initial tilt crashes MapLibre Native on device.
              initialCameraPosition: const CameraPosition(target: _munich, zoom: 9.6),
              compassEnabled: false,
              rotateGesturesEnabled: true,
              tiltGesturesEnabled: true,
              attributionButtonPosition: AttributionButtonPosition.topRight,
              attributionButtonMargins: Point(12, padding.top + 136),
              onMapCreated: (controller) {
                _map = controller;
                controller.onCircleTapped.add(_onCircleTapped);
              },
              onStyleLoadedCallback: () {
                // Every style load recreates the annotation managers, so pins are always re-added.
                _styleLoaded = true;
                _plotted = null;
                final value = ref.read(sitesProvider).value;
                if (value != null) unawaited(_plot(value));
                if (!_introPlayed) {
                  _introPlayed = true;
                  unawaited(_introFlight());
                }
              },
            ),
          ),
          const Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 220,
            child: IgnorePointer(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Color(0xE605070D), Color(0x0005070D)],
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            top: padding.top + 10,
            left: 12,
            right: 12,
            child: Column(
              children: [
                GlassPanel(
                  padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                  child: Row(
                    children: [
                      Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(11),
                          gradient: const LinearGradient(colors: [AppColors.accent, AppColors.accent2]),
                        ),
                        child: const Icon(CupertinoIcons.cube_box_fill, color: AppColors.background, size: 19),
                      ),
                      const SizedBox(width: 11),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'SiteTwin',
                              style: Theme.of(context).textTheme.titleMedium?.copyWith(color: Colors.white),
                            ),
                            const Text(
                              'Living 3D twins for every Standort',
                              style: TextStyle(color: AppColors.textMuted, fontSize: 11),
                            ),
                          ],
                        ),
                      ),
                      _ConnectionBadge(connection),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                GlassPanel(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  borderRadius: 14,
                  child: TextField(
                    onChanged: (value) => setState(() => _query = value.trim().toLowerCase()),
                    textInputAction: TextInputAction.search,
                    style: const TextStyle(fontSize: 14, color: AppColors.text),
                    decoration: const InputDecoration(
                      hintText: 'Search sites',
                      prefixIcon: Icon(CupertinoIcons.search, size: 18),
                      filled: false,
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                    ),
                  ),
                ),
              ],
            ),
          ),
          Positioned.fill(
            child: DraggableScrollableSheet(
              initialChildSize: 0.42,
              minChildSize: 0.16,
              maxChildSize: 0.86,
              snap: true,
              snapSizes: const [0.42],
              builder: (context, controller) => GlassPanel(
                borderRadius: 26,
                child: sites.when(
                  data: (value) => _SiteList(
                    controller: controller,
                    sites: _filter(value),
                    total: value.length,
                    selectedId: _selectedId,
                    onTap: _open,
                  ),
                  loading: () => ListView(
                    controller: controller,
                    children: const [
                      SheetHandle(),
                      SizedBox(height: 80),
                      Center(child: CircularProgressIndicator()),
                    ],
                  ),
                  error: (error, _) => ListView(
                    controller: controller,
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                    children: [
                      const SheetHandle(),
                      const SizedBox(height: 16),
                      InlineMessage(error.toString()),
                      const SizedBox(height: 12),
                      AppButton(
                        label: 'Try again',
                        icon: CupertinoIcons.arrow_clockwise,
                        tone: AppButtonTone.accent,
                        onPressed: () => ref.invalidate(sitesProvider),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Site> _filter(List<Site> sites) {
    final filtered = _query.isEmpty
        ? [...sites]
        : sites.where((site) => site.name.toLowerCase().contains(_query) || site.kind.contains(_query)).toList();
    filtered.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return filtered;
  }
}

class _ConnectionBadge extends StatelessWidget {
  const _ConnectionBadge(this.state);

  final LiveConnectionState? state;

  @override
  Widget build(BuildContext context) {
    return switch (state) {
      LiveConnectionState.connected => const StatusBadge(
        'LIVE',
        color: AppColors.ok,
        icon: CupertinoIcons.dot_radiowaves_left_right,
      ),
      LiveConnectionState.connecting => const StatusBadge('CONNECTING', color: AppColors.warn),
      _ => const StatusBadge('OFFLINE', color: AppColors.textMuted),
    };
  }
}

class _SiteList extends StatelessWidget {
  const _SiteList({
    required this.controller,
    required this.sites,
    required this.total,
    required this.selectedId,
    required this.onTap,
  });

  final ScrollController controller;
  final List<Site> sites;
  final int total;
  final String? selectedId;
  final ValueChanged<Site> onTap;

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.paddingOf(context).bottom;
    return ListView.builder(
      controller: controller,
      padding: EdgeInsets.fromLTRB(12, 0, 12, bottom + 16),
      itemCount: sites.length + 2,
      itemBuilder: (context, index) {
        if (index == 0) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
            child: Column(
              children: [
                const SheetHandle(),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Text('Standorte', style: Theme.of(context).textTheme.titleLarge?.copyWith(color: Colors.white)),
                    const Spacer(),
                    Text(
                      sites.length == total ? '$total sites' : '${sites.length} of $total',
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                    ),
                  ],
                ),
              ],
            ),
          );
        }
        if (index == sites.length + 1) {
          return const Padding(
            padding: EdgeInsets.fromLTRB(4, 14, 4, 0),
            child: Text(
              'Building data © OpenStreetMap contributors (ODbL), Swiss Dwellings (CC BY 4.0), ResPlan. '
              'Map © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.',
              style: TextStyle(color: AppColors.textDim, fontSize: 10, height: 1.4),
            ),
          );
        }
        final site = sites[index - 1];
        return SiteCard(site: site, selected: site.id == selectedId, onTap: () => onTap(site));
      },
    );
  }
}

class SiteCard extends StatelessWidget {
  const SiteCard({required this.site, required this.onTap, super.key, this.selected = false});

  final Site site;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = kindColors[site.kind] ?? kindColors['other']!;
    final kind = site.kind.isEmpty ? 'Site' : site.kind[0].toUpperCase() + site.kind.substring(1);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: selected ? const Color(0x1F38BDF8) : const Color(0x0AFFFFFF),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: selected ? const Color(0x6638BDF8) : AppColors.border),
        ),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(16),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            child: Row(
              children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: color,
                    shape: BoxShape.circle,
                    boxShadow: [BoxShadow(color: color.withValues(alpha: 0.7), blurRadius: 10)],
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        site.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        '$kind · ${site.floors} ${site.floors == 1 ? 'floor' : 'floors'}',
                        style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                if (site.demoLocation) ...[
                  const StatusBadge('DEMO', color: AppColors.textMuted),
                  const SizedBox(width: 8),
                ],
                const Icon(CupertinoIcons.chevron_right, size: 16, color: AppColors.textDim),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
