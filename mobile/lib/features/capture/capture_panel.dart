import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../app/widgets.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../site/site_session.dart';
import '../site/space_picker.dart';

enum CaptureMode { delivery, room }

class CapturePanel extends ConsumerStatefulWidget {
  const CapturePanel({
    required this.siteId,
    required this.scrollController,
    required this.onShowOnTwin,
    required this.onClose,
    required this.bottomInset,
    super.key,
  });

  final String siteId;
  final ScrollController scrollController;
  final VoidCallback onShowOnTwin;
  final VoidCallback onClose;
  final double bottomInset;

  @override
  ConsumerState<CapturePanel> createState() => _CapturePanelState();
}

class _CapturePanelState extends ConsumerState<CapturePanel> {
  final _picker = ImagePicker();
  final _label = TextEditingController();
  final _width = TextEditingController();
  final _depth = TextEditingController();
  final _height = TextEditingController();
  final List<String> _photos = [];
  CaptureMode _mode = CaptureMode.delivery;
  BuildingSpace? _target;
  BuildingSpace? _room;
  String? _videoPath;
  double? _upload;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    for (final controller in [_label, _width, _depth, _height]) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _guard(Future<void> Function() action) async {
    setState(() => _error = null);
    try {
      await action();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } on PlatformException catch (error) {
      if (mounted) {
        setState(
          () => _error = error.code == 'camera_access_denied' || error.code == 'photo_access_denied'
              ? 'Access was denied. Allow camera and photos for SiteTwin in Settings.'
              : error.message ?? 'The camera is unavailable on this device.',
        );
      }
    }
  }

  Future<void> _takePhoto() => _guard(() async {
    final photo = await _picker.pickImage(source: ImageSource.camera, imageQuality: 90, maxWidth: 2400);
    if (photo != null && mounted) setState(() => _photos.add(photo.path));
  });

  Future<void> _choosePhotos() => _guard(() async {
    final photos = await _picker.pickMultiImage(imageQuality: 90, maxWidth: 2400, limit: 6);
    if (photos.isNotEmpty && mounted) setState(() => _photos.addAll(photos.map((photo) => photo.path)));
  });

  Future<void> _samplePhoto() => _guard(() async {
    final bytes = await ref.read(apiClientProvider).samplePhoto();
    final directory = await getTemporaryDirectory();
    final file = File(p.join(directory.path, 'sample-pallet-${DateTime.now().millisecondsSinceEpoch}.jpg'));
    await file.writeAsBytes(bytes, flush: true);
    if (mounted) setState(() => _photos.add(file.path));
  });

  Future<void> _pickVideo(ImageSource source) => _guard(() async {
    final video = await _picker.pickVideo(source: source, maxDuration: const Duration(seconds: 60));
    if (video != null && mounted) setState(() => _videoPath = video.path);
  });

  Dimensions? _declared() {
    double? parse(TextEditingController controller) => double.tryParse(controller.text.trim().replaceAll(',', '.'));
    final w = parse(_width);
    final d = parse(_depth);
    final h = parse(_height);
    return w != null && d != null && h != null ? Dimensions(w: w, d: d, h: h) : null;
  }

  Future<void> _submit() async {
    final session = ref.read(siteSessionProvider(widget.siteId).notifier);
    HapticFeedback.mediumImpact();
    setState(() {
      _submitting = true;
      _upload = 0;
    });
    await _guard(() async {
      if (_mode == CaptureMode.delivery) {
        await session.captureDelivery(
          photoPaths: List.of(_photos),
          declared: _declared(),
          targetSpaceId: _target?.id,
          label: _label.text.trim(),
          onUpload: (fraction) {
            if (mounted) setState(() => _upload = fraction);
          },
        );
      } else {
        await session.captureRoom(
          spaceId: _room!.id,
          videoPath: _videoPath,
          onUpload: (fraction) {
            if (mounted) setState(() => _upload = fraction);
          },
        );
      }
    });
    if (mounted) {
      setState(() {
        _submitting = false;
        _upload = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(siteSessionProvider(widget.siteId));
    final building = session.building;
    final job = session.captureJob;
    final canSubmit =
        !_submitting &&
        building != null &&
        (_mode == CaptureMode.delivery ? _photos.isNotEmpty : _room != null) &&
        (job == null || job.isTerminal);
    return Column(
      children: [
        PanelHeader(title: 'Capture', subtitle: 'Measure deliveries · fit room scans', onClose: widget.onClose),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: AppSegmentedControl<CaptureMode>(
            values: const [(CaptureMode.delivery, 'Delivery'), (CaptureMode.room, 'Room scan')],
            selected: _mode,
            onChanged: (mode) => setState(() {
              _mode = mode;
              _error = null;
            }),
          ),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: ListView(
            controller: widget.scrollController,
            padding: EdgeInsets.fromLTRB(14, 6, 14, widget.bottomInset),
            children: [
              if (job != null) ...[
                _JobCard(
                  job: job,
                  building: building,
                  onShowOnTwin: widget.onShowOnTwin,
                  onDismiss: ref.read(siteSessionProvider(widget.siteId).notifier).dismissCaptureJob,
                ),
                const SizedBox(height: 14),
              ],
              if (_mode == CaptureMode.delivery) ..._deliveryForm(building) else ..._roomForm(building),
              if (_upload != null) ...[
                const SizedBox(height: 12),
                ClipRRect(
                  borderRadius: BorderRadius.circular(9),
                  child: LinearProgressIndicator(value: _upload, minHeight: 4),
                ),
                const SizedBox(height: 6),
                Text(
                  'Uploading ${((_upload ?? 0) * 100).round()} %',
                  style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                ),
              ],
              if (_error != null) ...[const SizedBox(height: 12), InlineMessage(_error!)],
              const SizedBox(height: 14),
              AppButton(
                label: _mode == CaptureMode.delivery ? 'Measure & check' : 'Fit scan to room',
                icon: _mode == CaptureMode.delivery ? CupertinoIcons.cube_box : CupertinoIcons.viewfinder,
                tone: AppButtonTone.accent,
                expand: true,
                loading: _submitting,
                onPressed: canSubmit ? _submit : null,
              ),
            ],
          ),
        ),
      ],
    );
  }

  List<Widget> _deliveryForm(Building? building) => [
    const _SectionLabel('Photos'),
    SizedBox(
      height: 84,
      child: _photos.isEmpty
          ? Container(
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: AppColors.borderStrong),
                color: const Color(0x08FFFFFF),
              ),
              child: const Text(
                'Photograph the delivery next to the printed A4 marker for metric scale.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.textMuted, fontSize: 12, height: 1.35),
              ),
            )
          : ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: _photos.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (context, index) => Stack(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(14),
                    child: Image.file(File(_photos[index]), width: 84, height: 84, fit: BoxFit.cover, cacheWidth: 252),
                  ),
                  Positioned(
                    top: 4,
                    right: 4,
                    child: GestureDetector(
                      onTap: () => setState(() => _photos.removeAt(index)),
                      child: Container(
                        padding: const EdgeInsets.all(4),
                        decoration: const BoxDecoration(color: Color(0xB305070D), shape: BoxShape.circle),
                        child: const Icon(CupertinoIcons.xmark, size: 12, color: Colors.white),
                      ),
                    ),
                  ),
                ],
              ),
            ),
    ),
    const SizedBox(height: 10),
    Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        AppButton(label: 'Camera', icon: CupertinoIcons.camera, onPressed: _takePhoto),
        AppButton(label: 'Library', icon: CupertinoIcons.photo_on_rectangle, onPressed: _choosePhotos),
        AppButton(label: 'Demo photo', icon: CupertinoIcons.wand_stars, onPressed: _samplePhoto),
      ],
    ),
    const SizedBox(height: 16),
    const _SectionLabel('Details'),
    TextField(
      controller: _label,
      textInputAction: TextInputAction.next,
      decoration: const InputDecoration(labelText: 'Label (optional)', hintText: 'Pallet with steel drum'),
    ),
    const SizedBox(height: 10),
    Row(
      children: [
        for (final (controller, label) in [(_width, 'W'), (_depth, 'D'), (_height, 'H')]) ...[
          Expanded(
            child: TextField(
              controller: controller,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(labelText: 'Declared $label', suffixText: 'm', isDense: true),
            ),
          ),
          if (label != 'H') const SizedBox(width: 8),
        ],
      ],
    ),
    const SizedBox(height: 10),
    _SpaceTile(
      label: 'Destination',
      value: _target?.displayName ?? 'Optional — checks route fit',
      onTap: building == null
          ? null
          : () async {
              final space = await showSpacePicker(context, building, title: 'Delivery destination');
              if (space != null && mounted) setState(() => _target = space);
            },
    ),
  ];

  List<Widget> _roomForm(Building? building) => [
    const _SectionLabel('Room'),
    _SpaceTile(
      label: 'Scan target',
      value: _room?.displayName ?? 'Choose a room',
      onTap: building == null
          ? null
          : () async {
              final space = await showSpacePicker(context, building, title: 'Room to scan');
              if (space != null && mounted) setState(() => _room = space);
            },
    ),
    const SizedBox(height: 16),
    const _SectionLabel('Walk-through video'),
    Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        AppButton(label: 'Record', icon: CupertinoIcons.videocam, onPressed: () => _pickVideo(ImageSource.camera)),
        AppButton(label: 'Library', icon: CupertinoIcons.film, onPressed: () => _pickVideo(ImageSource.gallery)),
        if (_videoPath != null)
          AppButton(
            label: p.basename(_videoPath!),
            icon: CupertinoIcons.xmark_circle,
            tone: AppButtonTone.ghost,
            onPressed: () => setState(() => _videoPath = null),
          ),
      ],
    ),
    const SizedBox(height: 10),
    const InlineMessage(
      'Without a video the server fits its labelled demo scan. The app shows wall deviations; '
      'the Gaussian-splat preview stays on the web twin.',
      color: AppColors.accent,
      icon: CupertinoIcons.info_circle,
    ),
  ];
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: 2, bottom: 8),
    child: Text(
      text.toUpperCase(),
      style: const TextStyle(color: AppColors.textDim, fontSize: 10, letterSpacing: 1.2, fontWeight: FontWeight.w600),
    ),
  );
}

class _SpaceTile extends StatelessWidget {
  const _SpaceTile({required this.label, required this.value, required this.onTap});

  final String label;
  final String value;
  final VoidCallback? onTap;

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
              const Icon(CupertinoIcons.map_pin_ellipse, size: 17, color: AppColors.textMuted),
              const SizedBox(width: 10),
              Text(label, style: const TextStyle(color: AppColors.text, fontSize: 14)),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  value,
                  textAlign: TextAlign.right,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: AppColors.accent, fontSize: 13, fontWeight: FontWeight.w600),
                ),
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

class _JobCard extends StatelessWidget {
  const _JobCard({required this.job, required this.building, required this.onShowOnTwin, required this.onDismiss});

  final CaptureJob job;
  final Building? building;
  final VoidCallback onShowOnTwin;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final delivery = job.deliveryResult;
    final scan = job.roomScanResult;
    final color = job.isFailed
        ? AppColors.danger
        : job.isDone
        ? AppColors.ok
        : AppColors.accent;
    final status = switch (job.status) {
      'queued' => 'Queued',
      'measuring' => 'Measuring',
      'modeling' => 'Building 3D model',
      'aligning' => 'Aligning to plan',
      'done' => 'Done',
      'failed' => 'Failed',
      _ => job.status,
    };
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(job.kind == 'room' ? CupertinoIcons.viewfinder : CupertinoIcons.cube_box, size: 17, color: color),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  job.kind == 'room' ? 'Room scan · $status' : 'Delivery · $status',
                  style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600),
                ),
              ),
              if (job.isTerminal) AppIconButton(icon: CupertinoIcons.xmark, tooltip: 'Dismiss', onPressed: onDismiss),
            ],
          ),
          if (!job.isTerminal) ...[
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(9),
              child: LinearProgressIndicator(value: job.progress, minHeight: 4),
            ),
          ],
          if (job.message.isNotEmpty && delivery == null && scan == null) ...[
            const SizedBox(height: 8),
            Text(
              job.message,
              style: TextStyle(color: job.isFailed ? AppColors.danger : AppColors.textMuted, fontSize: 12),
            ),
          ],
          if (delivery != null) ...[
            const SizedBox(height: 8),
            Text(
              '${delivery.dimensionsText}  ±${(delivery.toleranceM * 100).round()} cm',
              style: const TextStyle(color: AppColors.accent, fontSize: 13, fontFamily: 'Menlo'),
            ),
            const SizedBox(height: 6),
            StatusBadge(
              delivery.statusLabel.toUpperCase(),
              color: delivery.status == 'ok' ? AppColors.ok : AppColors.warn,
            ),
            if (delivery.check.summary.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(delivery.check.summary, style: const TextStyle(color: AppColors.text, fontSize: 12, height: 1.35)),
            ],
          ],
          if (scan != null) ...[
            const SizedBox(height: 8),
            Text(
              scan.summary.isEmpty
                  ? 'Scan fitted to ${building?.spaceById(scan.spaceId)?.displayName ?? 'room'}.'
                  : scan.summary,
              style: const TextStyle(color: AppColors.text, fontSize: 12, height: 1.35),
            ),
            if (scan.deviations.isNotEmpty) ...[
              const SizedBox(height: 6),
              for (final deviation in scan.deviations)
                Text(
                  'Wall ${deviation.wallIndex + 1}: ${(deviation.offsetM * 100).round()} cm off plan',
                  style: TextStyle(
                    color: deviation.offsetM.abs() > 0.15 ? AppColors.warn : AppColors.textMuted,
                    fontSize: 11,
                  ),
                ),
            ],
          ],
          if (job.isDone) ...[
            const SizedBox(height: 10),
            AppButton(
              label: 'Show on twin',
              icon: CupertinoIcons.cube,
              tone: AppButtonTone.accent,
              onPressed: onShowOnTwin,
            ),
          ],
        ],
      ),
    );
  }
}
