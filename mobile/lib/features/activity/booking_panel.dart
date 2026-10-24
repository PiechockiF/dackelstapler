import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../app/widgets.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../site/site_session.dart';
import 'activity_panel.dart';

class BookingPanel extends ConsumerStatefulWidget {
  const BookingPanel({
    required this.siteId,
    required this.scrollController,
    required this.bottomInset,
    required this.onShowOnTwin,
    super.key,
  });

  final String siteId;
  final ScrollController scrollController;
  final double bottomInset;
  final VoidCallback onShowOnTwin;

  @override
  ConsumerState<BookingPanel> createState() => _BookingPanelState();
}

class _BookingPanelState extends ConsumerState<BookingPanel> {
  late DateTime _start = _nextHour();
  int _minutes = 60;
  int _people = 6;
  List<BookableRoom>? _rooms;
  ({DateTime start, DateTime end, int people})? _search;
  final Set<String> _booked = {};
  bool _loading = false;
  String? _error;

  static DateTime _nextHour() {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day, now.hour + 1);
  }

  Future<void> _find() async {
    final search = (start: _start, end: _start.add(Duration(minutes: _minutes)), people: _people);
    setState(() {
      _search = search;
      _loading = true;
      _error = null;
    });
    try {
      final rooms = await ref
          .read(siteSessionProvider(widget.siteId).notifier)
          .bookableRooms(start: search.start, end: search.end, people: search.people);
      if (!mounted || _search != search) return;
      setState(() => _rooms = rooms);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _book(BookableRoom room) async {
    final search = _search;
    if (search == null) return;
    setState(() => _loading = true);
    try {
      await ref
          .read(siteSessionProvider(widget.siteId).notifier)
          .book(room, start: search.start, end: search.end, people: search.people);
      _booked.add(room.spaceId);
      await _find();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _invalidate(VoidCallback change) => setState(() {
    change();
    _rooms = null;
    _booked.clear();
  });

  Future<void> _pickStart() async {
    var selected = _start;
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (context) => Container(
        height: 300,
        padding: const EdgeInsets.only(top: 8),
        decoration: const BoxDecoration(
          color: AppColors.panelSolid,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [CupertinoButton(child: const Text('Done'), onPressed: () => Navigator.of(context).pop())],
              ),
              Expanded(
                child: CupertinoTheme(
                  data: const CupertinoThemeData(brightness: Brightness.dark),
                  child: CupertinoDatePicker(
                    initialDateTime: _start,
                    minimumDate: _nextHour().subtract(const Duration(hours: 1)),
                    minuteInterval: 15,
                    use24hFormat: true,
                    onDateTimeChanged: (value) => selected = value,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (mounted && selected != _start) _invalidate(() => _start = selected);
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(
      siteSessionProvider(widget.siteId)
          .select((state) => state.events.where((event) => event.type == 'booking').firstOrNull?.id),
      (previous, next) {
        if (previous != next && _rooms != null && !_loading) unawaited(_find());
      },
    );
    final rooms = _rooms;
    return ListView(
      controller: widget.scrollController,
      padding: EdgeInsets.fromLTRB(14, 6, 14, widget.bottomInset),
      children: [
        _FieldTile(label: 'Start', value: clockLabel(_start), icon: CupertinoIcons.calendar, onTap: _pickStart),
        const SizedBox(height: 10),
        AppSegmentedControl<int>(
          values: const [(30, '30 min'), (60, '1 h'), (90, '1.5 h'), (120, '2 h')],
          selected: _minutes,
          onChanged: (value) => _invalidate(() => _minutes = value),
        ),
        const SizedBox(height: 10),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 4, 4, 4),
          decoration: BoxDecoration(
            color: const Color(0x0AFFFFFF),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            children: [
              const Icon(CupertinoIcons.person_2, size: 17, color: AppColors.textMuted),
              const SizedBox(width: 10),
              const Expanded(
                child: Text('People', style: TextStyle(color: AppColors.text, fontSize: 14)),
              ),
              AppIconButton(
                icon: CupertinoIcons.minus,
                tooltip: 'Fewer people',
                onPressed: _people > 1 ? () => _invalidate(() => _people--) : null,
              ),
              SizedBox(
                width: 34,
                child: Text(
                  '$_people',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700),
                ),
              ),
              AppIconButton(
                icon: CupertinoIcons.plus,
                tooltip: 'More people',
                onPressed: _people < 200 ? () => _invalidate(() => _people++) : null,
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        AppButton(
          label: 'Find free rooms',
          icon: CupertinoIcons.search,
          tone: AppButtonTone.accent,
          expand: true,
          loading: _loading,
          onPressed: _find,
        ),
        if (_error != null) ...[const SizedBox(height: 12), InlineMessage(_error!)],
        if (rooms != null && rooms.isEmpty) ...[
          const SizedBox(height: 12),
          EmptyState(title: 'No room fits $_people people', icon: CupertinoIcons.person_3),
        ],
        if (rooms != null)
          for (final room in rooms) ...[
            const SizedBox(height: 8),
            _RoomTile(
              room: room,
              booked: _booked.contains(room.spaceId) && !room.free,
              busy: _loading,
              onBook: () => _book(room),
              onShow: () {
                final controller = ref.read(siteSessionProvider(widget.siteId).notifier);
                controller.focusFloor(room.floorId);
                controller.select(room.spaceId);
                widget.onShowOnTwin();
              },
              onNavigate: () async {
                try {
                  await ref.read(siteSessionProvider(widget.siteId).notifier).navigate(to: room.spaceId);
                  widget.onShowOnTwin();
                } on ApiException catch (error) {
                  if (mounted) setState(() => _error = error.message);
                }
              },
            ),
          ],
      ],
    );
  }
}

class _FieldTile extends StatelessWidget {
  const _FieldTile({required this.label, required this.value, required this.icon, required this.onTap});

  final String label;
  final String value;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0x0AFFFFFF),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: AppColors.border),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          child: Row(
            children: [
              Icon(icon, size: 17, color: AppColors.textMuted),
              const SizedBox(width: 10),
              Text(label, style: const TextStyle(color: AppColors.text, fontSize: 14)),
              const Spacer(),
              Text(
                value,
                style: const TextStyle(color: AppColors.accent, fontSize: 14, fontWeight: FontWeight.w600),
              ),
              const SizedBox(width: 6),
              const Icon(CupertinoIcons.chevron_right, size: 14, color: AppColors.textDim),
            ],
          ),
        ),
      ),
    );
  }
}

class _RoomTile extends StatelessWidget {
  const _RoomTile({
    required this.room,
    required this.booked,
    required this.busy,
    required this.onBook,
    required this.onShow,
    required this.onNavigate,
  });

  final BookableRoom room;
  final bool booked;
  final bool busy;
  final VoidCallback onBook;
  final VoidCallback onShow;
  final VoidCallback onNavigate;

  @override
  Widget build(BuildContext context) {
    final color = booked
        ? AppColors.booked
        : room.free
        ? AppColors.ok
        : AppColors.textDim;
    return Material(
      color: const Color(0x0AFFFFFF),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: AppColors.border),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onShow,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
          child: Row(
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  color: color,
                  shape: BoxShape.circle,
                  boxShadow: room.free || booked ? [BoxShadow(color: color, blurRadius: 9)] : null,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      room.displayName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [
                        'L${room.level}',
                        '${room.capacity} seats',
                        '${room.areaM2.toStringAsFixed(0)} m²',
                        if (room.distanceM != null) '${room.distanceM!.round()} m away',
                      ].join(' · '),
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              if (booked)
                const Padding(
                  padding: EdgeInsets.only(right: 6),
                  child: StatusBadge('BOOKED', color: AppColors.booked),
                )
              else if (room.free)
                AppButton(
                  label: 'Book',
                  icon: CupertinoIcons.checkmark_alt,
                  tone: AppButtonTone.ok,
                  onPressed: busy ? null : onBook,
                ),
              AppIconButton(icon: CupertinoIcons.location_north, tooltip: 'Navigate there', onPressed: onNavigate),
            ],
          ),
        ),
      ),
    );
  }
}
