import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../app/widgets.dart';

class TimelineTick {
  const TimelineTick({required this.id, required this.timestamp, required this.type});

  final String id;
  final DateTime timestamp;
  final String type;
}

class TimelineBar extends StatefulWidget {
  const TimelineBar({required this.ticks, required this.timestamp, required this.onChanged, super.key});

  final List<TimelineTick> ticks;
  final DateTime? timestamp;
  final ValueChanged<DateTime?> onChanged;

  @override
  State<TimelineBar> createState() => _TimelineBarState();
}

class _TimelineBarState extends State<TimelineBar> {
  static const _days = 7;
  Timer? _timer;
  late final Timer _clock;
  DateTime _now = DateTime.now();
  DateTime? _playbackValue;
  DateTime? _lastEmit;

  bool get _playing => _timer != null;
  DateTime get _start => _now.subtract(const Duration(days: _days));
  DateTime get _value => _playbackValue ?? widget.timestamp ?? _now;

  @override
  void initState() {
    super.initState();
    _clock = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted && !_playing) setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _clock.cancel();
    _timer?.cancel();
    super.dispose();
  }

  void _emit(DateTime? value, {bool force = false}) {
    final now = DateTime.now();
    if (!force && _lastEmit != null && now.difference(_lastEmit!).inMilliseconds < 90) {
      return;
    }
    _lastEmit = now;
    widget.onChanged(value);
  }

  void _togglePlayback() {
    if (_playing) {
      _timer?.cancel();
      setState(() => _timer = null);
      return;
    }
    var value = _value;
    if (widget.timestamp == null || _now.difference(value).inMinutes < 1) {
      value = _start;
    }
    _playbackValue = value;
    _timer = Timer.periodic(const Duration(milliseconds: 60), (timer) {
      if (!mounted) return;
      final elapsed = const Duration(days: _days).inMilliseconds;
      final step = elapsed * 0.06 / 8000;
      value = value.add(Duration(milliseconds: step.round()));
      if (!value.isBefore(_now)) {
        timer.cancel();
        _timer = null;
        _playbackValue = null;
        _emit(null, force: true);
      } else {
        _playbackValue = value;
        _emit(value);
      }
      setState(() {});
    });
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final startMs = _start.millisecondsSinceEpoch.toDouble();
    final nowMs = _now.millisecondsSinceEpoch.toDouble();
    final valueMs = _value.millisecondsSinceEpoch.toDouble().clamp(startMs, nowMs);
    final live = widget.timestamp == null && _playbackValue == null;
    return GlassPanel(
      blur: false,
      borderRadius: 17,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
      child: Row(
        children: [
          AppIconButton(
            icon: _playing ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill,
            tooltip: _playing ? 'Pause timeline' : 'Replay last seven days',
            onPressed: _togglePlayback,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: SizedBox(
              height: 40,
              child: LayoutBuilder(
                builder: (context, constraints) {
                  return Stack(
                    alignment: Alignment.center,
                    children: [
                      Positioned.fill(
                        top: 3,
                        bottom: 0,
                        child: CustomPaint(
                          painter: _TimelinePainter(ticks: widget.ticks, start: _start, end: _now, value: _value),
                        ),
                      ),
                      Positioned.fill(
                        child: SliderTheme(
                          data: SliderTheme.of(context).copyWith(
                            trackShape: const _TransparentTrackShape(),
                            thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
                            overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
                          ),
                          child: Slider(
                            min: startMs,
                            max: nowMs,
                            value: valueMs,
                            onChanged: (value) {
                              _timer?.cancel();
                              _timer = null;
                              final selected = DateTime.fromMillisecondsSinceEpoch(value.round());
                              final nextLive = nowMs - value < 60000;
                              _playbackValue = nextLive ? null : selected;
                              _emit(nextLive ? null : selected, force: true);
                              setState(() {});
                            },
                          ),
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
          ),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 64),
            child: live
                ? const Center(
                    widthFactor: 1,
                    child: StatusBadge('LIVE', color: AppColors.ok, icon: CupertinoIcons.dot_radiowaves_left_right),
                  )
                : AppButton(
                    label: 'LIVE',
                    icon: CupertinoIcons.forward_end_fill,
                    tone: AppButtonTone.ghost,
                    onPressed: () {
                      _timer?.cancel();
                      _timer = null;
                      _playbackValue = null;
                      _emit(null, force: true);
                      setState(() {});
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

class _TimelinePainter extends CustomPainter {
  const _TimelinePainter({required this.ticks, required this.start, required this.end, required this.value});

  final List<TimelineTick> ticks;
  final DateTime start;
  final DateTime end;
  final DateTime value;

  double _fraction(DateTime timestamp) =>
      (timestamp.millisecondsSinceEpoch - start.millisecondsSinceEpoch) /
      (end.millisecondsSinceEpoch - start.millisecondsSinceEpoch);

  @override
  void paint(Canvas canvas, Size size) {
    final range = end.millisecondsSinceEpoch - start.millisecondsSinceEpoch;
    if (range <= 0) return;
    final centerY = size.height * 0.52;
    final track = Paint()
      ..color = AppColors.borderStrong
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(Offset(0, centerY), Offset(size.width, centerY), track);
    final active = Paint()
      ..color = AppColors.accent
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(Offset(0, centerY), Offset(size.width * _fraction(value).clamp(0, 1), centerY), active);

    final dayPaint = Paint()
      ..color = AppColors.borderStrong
      ..strokeWidth = 1;
    final textPainter = TextPainter(textDirection: TextDirection.ltr);
    final firstDay = DateTime(start.year, start.month, start.day).add(const Duration(days: 1));
    for (var day = firstDay; day.isBefore(end); day = day.add(const Duration(days: 1))) {
      final x = size.width * _fraction(day).clamp(0, 1);
      canvas.drawLine(Offset(x, 0), Offset(x, 7), dayPaint);
      const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
      textPainter.text = TextSpan(
        text: weekdays[day.weekday - 1],
        style: const TextStyle(color: AppColors.textDim, fontSize: 7, fontWeight: FontWeight.w600),
      );
      textPainter.layout();
      textPainter.paint(
        canvas,
        Offset((x - textPainter.width / 2).clamp(0, size.width - textPainter.width), size.height - 9),
      );
    }

    for (final tick in ticks) {
      if (tick.timestamp.isBefore(start) || tick.timestamp.isAfter(end)) continue;
      final x = size.width * _fraction(tick.timestamp).clamp(0, 1);
      final color = switch (tick.type) {
        'delivery' => AppColors.warn,
        'asset_moved' => AppColors.accent,
        'closure' => AppColors.danger,
        'booking' => AppColors.booked,
        'door_added' => AppColors.ok,
        'capture' => AppColors.accent2,
        _ => AppColors.textMuted,
      };
      canvas.drawCircle(
        Offset(x, centerY),
        3,
        Paint()..color = tick.timestamp.isAfter(value) ? color.withValues(alpha: 0.25) : color,
      );
    }
  }

  @override
  bool shouldRepaint(_TimelinePainter oldDelegate) =>
      oldDelegate.ticks != ticks || oldDelegate.start != start || oldDelegate.end != end || oldDelegate.value != value;
}

class _TransparentTrackShape extends RoundedRectSliderTrackShape {
  const _TransparentTrackShape();

  @override
  void paint(
    PaintingContext context,
    Offset offset, {
    required RenderBox parentBox,
    required SliderThemeData sliderTheme,
    required Animation<double> enableAnimation,
    required TextDirection textDirection,
    required Offset thumbCenter,
    Offset? secondaryOffset,
    bool isDiscrete = false,
    bool isEnabled = false,
    double additionalActiveTrackHeight = 2,
  }) {}
}
